'use strict';

// one file by assignment rule: a single server-side script behind a single URL path

// 1. IMPORTS

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// 2. CONFIG

const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'app.db');
const DEFAULT_PORT = 8080;
const MAX_ECHO_LENGTH = 40;

// generous for a poem, small enough that a flood cannot exhaust a t2.micro
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES) || 64 * 1024;

// how much oversized payload to drain before cutting the socket, so 413 still reaches the client
const DRAIN_LIMIT_FACTOR = 4;

const SESSION_COOKIE = 'SID';
const SESSION_ID_BYTES = 32;

// off by default because the brief deploys over plain http, where a Secure cookie would
// never be sent back; turn it on the moment anything terminates tls in front
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';

// lower this to a few seconds to demonstrate expiry live in class
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 30 * 60 * 1000;
const SESSION_SWEEP_MS = Number(process.env.SESSION_SWEEP_MS) || 60 * 1000;

// mirrors the server.php?aksi= example in the brief, so every action shares one path
const ENTRY_PATH = '/server.js';

// 3. DATABASE

// no_id and singular keyword are copied from the mandated schema, not typos
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT    NOT NULL UNIQUE,
  password TEXT    NOT NULL,
  nama     TEXT    NOT NULL,
  no_id    TEXT
);

CREATE TABLE IF NOT EXISTS puisi (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  judul      TEXT    NOT NULL,
  tgl_submit TEXT    NOT NULL,
  isi        TEXT    NOT NULL,
  kategori   TEXT    NOT NULL,
  keyword    TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_puisi_user_id ON puisi(user_id);
`;

function openDatabase(dbPath = DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);

  // sqlite parses foreign keys but only enforces them per connection with this pragma
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(SCHEMA_SQL);
  return db;
}

function foreignKeysEnabled(db) {
  const row = db.prepare('PRAGMA foreign_keys').get();
  return Boolean(row && row.foreign_keys);
}

// 4. HTTP HELPERS

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// only unexpected throws are logged and hidden; an HttpError is a deliberate reply
function sendError(res, err) {
  const deliberate = err instanceof HttpError;
  if (!deliberate) console.error(err);
  sendJson(res, deliberate ? err.status : 500, {
    error: deliberate ? err.message : 'kesalahan server',
  });
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, 'data terlalu besar'));
      return;
    }

    const chunks = [];
    let size = 0;
    let over = false;

    req.on('data', (chunk) => {
      size += chunk.length;

      if (size > limit) {
        if (!over) {
          over = true;
          chunks.length = 0;
          reject(new HttpError(413, 'data terlalu besar'));
        }
        // keep draining briefly so the 413 gets written, then cut a sender that ignores it
        if (size > limit * DRAIN_LIMIT_FACTOR) req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function parseBody(raw, contentType) {
  // null prototype so a field named __proto__ cannot reach Object.prototype
  const fields = Object.create(null);
  if (!raw) return fields;

  const type = String(contentType || '').split(';')[0].trim().toLowerCase();

  if (type === 'application/json') {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'json tidak valid');
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'body harus berupa objek');
    }

    for (const [key, value] of Object.entries(parsed)) fields[key] = value;
    return fields;
  }

  if (type === 'application/x-www-form-urlencoded') {
    for (const [key, value] of new URLSearchParams(raw)) fields[key] = value;
    return fields;
  }

  throw new HttpError(415, `content-type tidak didukung: ${type.slice(0, MAX_ECHO_LENGTH)}`);
}

async function readFields(req) {
  return parseBody(await readBody(req), req.headers['content-type']);
}

// 5. SESSION

function parseCookies(header) {
  const jar = Object.create(null);
  if (!header) return jar;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;

    const name = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    if (!name) continue;

    // a malformed escape such as %zz would otherwise throw and drop the whole jar
    try {
      jar[name] = decodeURIComponent(raw);
    } catch {
      jar[name] = raw;
    }
  }

  return jar;
}

function buildSetCookie(name, value, { maxAgeSeconds, secure = COOKIE_SECURE } = {}) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

// state lives in this process and nowhere else, which is the point of the baseline:
// restart the process or add a second instance and every session here is gone
function createSessionStore({ ttlMs = SESSION_TTL_MS } = {}) {
  const sessions = new Map();

  function expired(session, now) {
    return now - session.createdAt > ttlMs;
  }

  function create(user) {
    const id = crypto.randomBytes(SESSION_ID_BYTES).toString('hex');
    const now = Date.now();
    sessions.set(id, {
      userId: user.id,
      username: user.username,
      nama: user.nama,
      createdAt: now,
      lastSeen: now,
    });
    return id;
  }

  function get(id) {
    if (!id) return null;

    const session = sessions.get(id);
    if (!session) return null;

    const now = Date.now();
    if (expired(session, now)) {
      sessions.delete(id);
      return null;
    }

    session.lastSeen = now;
    return session;
  }

  function sweep(now = Date.now()) {
    let removed = 0;
    for (const [id, session] of sessions) {
      if (expired(session, now)) {
        sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  function startSweeper(intervalMs = SESSION_SWEEP_MS) {
    const timer = setInterval(sweep, intervalMs);

    // unref keeps this timer from holding the process, and the test runner, alive
    timer.unref();
    return timer;
  }

  return {
    create,
    get,
    sweep,
    startSweeper,
    ttlMs,
    destroy: (id) => sessions.delete(id),
    clear: () => sessions.clear(),
    get size() {
      return sessions.size;
    },
  };
}

function sessionOf(req, ctx) {
  return ctx.sessions.get(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

// 6. ACTIONS

function notImplemented() {
  throw new HttpError(501, 'aksi ini belum tersedia');
}

// 7. ROUTER

const ROUTES = {
  register: { method: 'POST', handler: notImplemented },
  login: { method: 'POST', handler: notImplemented },
  submit_puisi: { method: 'POST', handler: notImplemented },
  daftar_puisi: { method: 'GET', handler: notImplemented },
};

async function handleRequest(req, res, ctx) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname !== ENTRY_PATH) {
    throw new HttpError(404, 'alamat tidak ditemukan');
  }

  const aksi = url.searchParams.get('aksi');
  if (!aksi) {
    throw new HttpError(400, 'parameter aksi wajib diisi');
  }

  // hasOwn stops aksi=__proto__ or aksi=constructor from resolving to an inherited value
  if (!Object.hasOwn(ROUTES, aksi)) {
    // truncated so a long query string cannot be reflected back in full
    throw new HttpError(404, `aksi tidak dikenal: ${aksi.slice(0, MAX_ECHO_LENGTH)}`);
  }

  const route = ROUTES[aksi];
  if (req.method !== route.method) {
    res.setHeader('Allow', route.method);
    throw new HttpError(405, `aksi ${aksi} hanya menerima ${route.method}`);
  }

  await route.handler(req, res, ctx, url);
}

function createServer(ctx) {
  return http.createServer((req, res) => {
    handleRequest(req, res, ctx).catch((err) => sendError(res, err));
  });
}

// 8. ENTRY POINT

function start() {
  const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const ctx = { db: openDatabase(dbPath), sessions: createSessionStore() };
  const server = createServer(ctx);

  ctx.sessions.startSweeper();

  server.listen(port, () => {
    console.log(`listening on http://localhost:${port}${ENTRY_PATH}?aksi=`);
    console.log(`database ${dbPath}, foreign keys ${foreignKeysEnabled(ctx.db) ? 'on' : 'off'}`);
    console.log(`sessions in memory, ttl ${ctx.sessions.ttlMs} ms, lost on restart`);
  });

  // systemd sends SIGTERM on restart, and the in-memory sessions die with the process
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => {
      ctx.db.close();
      process.exit(0);
    }));
  }

  return { server, ctx };
}

if (require.main === module) {
  start();
}

// 9. EXPORTS

module.exports = {
  DEFAULT_DB_PATH,
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  ENTRY_PATH,
  SCHEMA_SQL,
  ROUTES,
  HttpError,
  openDatabase,
  foreignKeysEnabled,
  sendJson,
  readBody,
  parseBody,
  readFields,
  parseCookies,
  buildSetCookie,
  createSessionStore,
  sessionOf,
  createServer,
  start,
};
