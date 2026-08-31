'use strict';

// one file by assignment rule: a single server-side script behind a single URL path

// 1. IMPORTS

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
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

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, saltBytes: 16 };
const USERNAME_PATTERN = /^[a-z0-9._-]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LIMITS = {
  username: { min: 3, max: 32 },
  password: { min: 8, max: 200 },
  nama: { min: 1, max: 100 },
  no_id: { max: 32 },
  judul: { min: 1, max: 150 },
  isi: { max: 20000 },
  kategori: { min: 1, max: 50 },
  keywords: { max: 200 },
};

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

// 6. PASSWORD

// the async form runs on the threadpool, so hashing one login does not stall every other
// request on this single-threaded server
function scrypt(plain, salt, keylen, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(plain, salt, keylen, params, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(plain) {
  const { N, r, p, keylen, saltBytes } = SCRYPT;
  const salt = crypto.randomBytes(saltBytes);
  const key = await scrypt(plain, salt, keylen, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('hex'), key.toString('hex')].join('$');
}

// hex decoding stops at the first invalid character and returns what it got, so a corrupt
// record would otherwise decode to an empty buffer that compares equal to anything
function fromHex(text) {
  const buf = Buffer.from(String(text), 'hex');
  return buf.length > 0 && buf.length * 2 === String(text).length ? buf : null;
}

// parameters are read back from the record, so old hashes stay verifiable after a retune
async function verifyPassword(plain, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, N, r, p, saltHex, keyHex] = parts;
  const salt = fromHex(saltHex);
  const expected = fromHex(keyHex);
  if (!salt || !expected) return false;

  try {
    const actual = await scrypt(plain, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// 7. VALIDATION

function requireText(fields, name, { min = 1, max = 255 } = {}) {
  const value = typeof fields[name] === 'string' ? fields[name].trim() : '';
  if (!value) throw new HttpError(400, `${name} wajib diisi`);
  if (value.length < min) throw new HttpError(400, `${name} minimal ${min} karakter`);
  if (value.length > max) throw new HttpError(400, `${name} maksimal ${max} karakter`);
  return value;
}

function optionalText(fields, name, { max = 255 } = {}) {
  const value = typeof fields[name] === 'string' ? fields[name].trim() : '';
  if (!value) return null;
  if (value.length > max) throw new HttpError(400, `${name} maksimal ${max} karakter`);
  return value;
}

// never trimmed: a leading or trailing space is a legitimate part of a password
function requirePassword(fields) {
  const value = typeof fields.password === 'string' ? fields.password : '';
  const { min, max } = LIMITS.password;
  if (!value) throw new HttpError(400, 'password wajib diisi');
  if (value.length < min) throw new HttpError(400, `password minimal ${min} karakter`);
  if (value.length > max) throw new HttpError(400, `password maksimal ${max} karakter`);
  return value;
}

// toISOString would report yesterday for anyone east of UTC before their morning
function todayLocal(now = new Date()) {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// the brief lists tgl_submit as an input, so it is taken from the client rather than
// stamped by the server, and today is only the fallback when the field is absent
function requireDate(fields, name) {
  const value = typeof fields[name] === 'string' ? fields[name].trim() : '';
  if (!value) return todayLocal();

  if (!DATE_PATTERN.test(value)) {
    throw new HttpError(400, `${name} harus berformat YYYY-MM-DD`);
  }

  // the pattern accepts 2026-02-30, so the parts have to survive a real date round trip
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new HttpError(400, `${name} bukan tanggal yang ada`);
  }

  return value;
}

// only trailing space is stripped, because a poem may open with deliberate indentation
function requirePoemBody(fields) {
  const raw = typeof fields.isi === 'string' ? fields.isi : '';
  const value = raw.replace(/\r\n/g, '\n').replace(/\s+$/, '');

  if (!value.trim()) throw new HttpError(400, 'isi wajib diisi');
  if (value.length > LIMITS.isi.max) {
    throw new HttpError(400, `isi maksimal ${LIMITS.isi.max} karakter`);
  }

  return value;
}

// lowercased so someone who registers as Budi can still log in as budi
function requireUsername(fields) {
  const value = requireText(fields, 'username', LIMITS.username).toLowerCase();
  if (!USERNAME_PATTERN.test(value)) {
    throw new HttpError(400, 'username hanya boleh huruf kecil, angka, titik, garis bawah, dan strip');
  }
  return value;
}

// 8. ACTIONS

async function register(req, res, ctx) {
  const fields = await readFields(req);
  const username = requireUsername(fields);
  const nama = requireText(fields, 'nama', LIMITS.nama);
  const password = requirePassword(fields);
  const noId = optionalText(fields, 'no_id', LIMITS.no_id);

  const stored = await hashPassword(password);

  try {
    const info = ctx.db
      .prepare('INSERT INTO users (username, password, nama, no_id) VALUES (?, ?, ?, ?)')
      .run(username, stored, nama, noId);
    sendJson(res, 201, { ok: true, id: Number(info.lastInsertRowid), username });
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) throw new HttpError(409, 'username sudah dipakai');
    throw err;
  }
}

// a throwaway record so a missing username costs the same time as a wrong password,
// otherwise the response delay alone tells an attacker which accounts exist
let decoyRecord = null;

async function verifyAgainstDecoy(password) {
  if (!decoyRecord) decoyRecord = await hashPassword(crypto.randomBytes(32).toString('hex'));
  await verifyPassword(password, decoyRecord);
  return false;
}

async function login(req, res, ctx) {
  const fields = await readFields(req);

  // login does not reuse the register validators: rejecting a short password here would
  // answer 400 before checking anything, which tells an attacker the input never matched
  const username = String(fields.username || '').trim().toLowerCase();
  const password = typeof fields.password === 'string' ? fields.password : '';

  if (!username || !password) {
    throw new HttpError(400, 'username dan password wajib diisi');
  }

  const user = ctx.db
    .prepare('SELECT id, username, password, nama FROM users WHERE username = ?')
    .get(username);

  const ok = user
    ? await verifyPassword(password, user.password)
    : await verifyAgainstDecoy(password);

  // one message for both failures, so neither reveals whether the username exists
  if (!ok) throw new HttpError(401, 'username atau password salah');

  const sid = ctx.sessions.create(user);

  // never round down to zero: Max-Age=0 tells the browser to drop the cookie at once,
  // which would silently break a short ttl set for a demo
  const maxAgeSeconds = Math.max(1, Math.round(ctx.sessions.ttlMs / 1000));

  res.setHeader('Set-Cookie', buildSetCookie(SESSION_COOKIE, sid, { maxAgeSeconds }));
  sendJson(res, 200, { ok: true, username: user.username, nama: user.nama });
}

async function submitPuisi(req, res, ctx, { session }) {
  const fields = await readFields(req);
  const judul = requireText(fields, 'judul', LIMITS.judul);
  const isi = requirePoemBody(fields);
  const kategori = requireText(fields, 'kategori', LIMITS.kategori);
  const tglSubmit = requireDate(fields, 'tgl_submit');

  // the input is named keywords, the mandated column is keyword
  const keyword = optionalText(fields, 'keywords', LIMITS.keywords);

  const info = ctx.db
    .prepare(
      'INSERT INTO puisi (user_id, judul, tgl_submit, isi, kategori, keyword) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(session.userId, judul, tglSubmit, isi, kategori, keyword);

  sendJson(res, 201, { ok: true, id: Number(info.lastInsertRowid) });
}

// public and idempotent, so leaving never fails; clearing the cookie is right here
// because the user asked to go, unlike the 401 path which keeps it as evidence
function logout(req, res, ctx) {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (sid) ctx.sessions.destroy(sid);

  res.setHeader('Set-Cookie', buildSetCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0 }));
  sendJson(res, 200, { ok: true });
}

// public so the page can ask who it is on load without a 401 in the console
function whoami(req, res, ctx) {
  const session = sessionOf(req, ctx);
  sendJson(res, 200, {
    user: session ? { username: session.username, nama: session.nama } : null,
  });
}

// the instrument for the report: restart the service and pid changes while sessions drops
// to zero, on the same screen that starts refusing the cookie the browser still holds
function serverInfo(req, res, ctx) {
  sendJson(res, 200, {
    hostname: os.hostname(),
    pid: process.pid,
    uptime_seconds: Math.round(process.uptime()),
    sessions: ctx.sessions.size,
    node: process.version,
  });
}

// scoped to the session owner, and projecting exactly the three columns the brief lists:
// the specified output has no author field, which only reads as complete for one author
function daftarPuisi(req, res, ctx, { session }) {
  const items = ctx.db
    .prepare(
      'SELECT tgl_submit, judul, kategori FROM puisi WHERE user_id = ? ORDER BY tgl_submit DESC, id DESC',
    )
    .all(session.userId);

  sendJson(res, 200, { items });
}

// 9. STATIC FILES

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  let relative;
  try {
    relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname).slice(1);
  } catch {
    throw new HttpError(404, 'alamat tidak ditemukan');
  }

  const target = path.resolve(PUBLIC_DIR, relative);

  // resolve collapses ../ and treats a leading slash as absolute, so the result has to be
  // checked rather than the input
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    throw new HttpError(404, 'alamat tidak ditemukan');
  }

  let body;
  try {
    body = fs.readFileSync(target);
  } catch {
    throw new HttpError(404, 'alamat tidak ditemukan');
  }

  res.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(target)] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// 10. ROUTER

// auth lives in this table rather than inside each handler, so a new protected action
// cannot forget the guard
const ROUTES = {
  register: { method: 'POST', handler: register },
  login: { method: 'POST', handler: login },
  submit_puisi: { method: 'POST', auth: true, handler: submitPuisi },
  daftar_puisi: { method: 'GET', auth: true, handler: daftarPuisi },
  logout: { method: 'POST', handler: logout },
  whoami: { method: 'GET', handler: whoami },
  server_info: { method: 'GET', handler: serverInfo },
};

async function handleRequest(req, res, ctx) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // the single-path rule covers the actions; the frontend is plain files beside them
  if (url.pathname !== ENTRY_PATH) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      throw new HttpError(405, 'berkas statis hanya menerima GET');
    }

    serveStatic(res, url.pathname);
    return;
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

  const session = route.auth ? sessionOf(req, ctx) : null;

  // the stale cookie is left in the browser on purpose: watching it still be sent to a
  // server that no longer knows it is the lesson this baseline exists to teach
  if (route.auth && !session) {
    throw new HttpError(401, 'sesi tidak valid, silakan masuk lagi');
  }

  await route.handler(req, res, ctx, { url, session });
}

function createServer(ctx) {
  return http.createServer((req, res) => {
    handleRequest(req, res, ctx).catch((err) => sendError(res, err));
  });
}

// 11. ENTRY POINT

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

// 12. EXPORTS

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
  hashPassword,
  verifyPassword,
  requireText,
  optionalText,
  requirePassword,
  requireUsername,
  register,
  login,
  submitPuisi,
  daftarPuisi,
  logout,
  whoami,
  serverInfo,
  todayLocal,
  requireDate,
  requirePoemBody,
  handleRequest,
  createSessionStore,
  sessionOf,
  serveStatic,
  createServer,
  start,
};
