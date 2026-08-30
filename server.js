'use strict';

// one file by assignment rule: a single server-side script behind a single URL path

// 1. IMPORTS

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// 2. CONFIG

const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'app.db');
const DEFAULT_PORT = 8080;
const MAX_ECHO_LENGTH = 40;

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

// 5. ACTIONS

function notImplemented() {
  throw new HttpError(501, 'aksi ini belum tersedia');
}

// 6. ROUTER

const ROUTES = {
  register: { method: 'POST', handler: notImplemented },
  login: { method: 'POST', handler: notImplemented },
  submit_puisi: { method: 'POST', handler: notImplemented },
  daftar_puisi: { method: 'GET', handler: notImplemented },
};

async function handleRequest(req, res, db) {
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

  await route.handler(req, res, db, url);
}

function createServer(db) {
  return http.createServer((req, res) => {
    handleRequest(req, res, db).catch((err) => sendError(res, err));
  });
}

// 7. ENTRY POINT

function start() {
  const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const db = openDatabase(dbPath);
  const server = createServer(db);

  server.listen(port, () => {
    console.log(`listening on http://localhost:${port}${ENTRY_PATH}?aksi=`);
    console.log(`database ${dbPath}, foreign keys ${foreignKeysEnabled(db) ? 'on' : 'off'}`);
  });

  // systemd sends SIGTERM on restart, and the in-memory sessions die with the process
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => {
      db.close();
      process.exit(0);
    }));
  }

  return { server, db };
}

if (require.main === module) {
  start();
}

// 8. EXPORTS

module.exports = {
  DEFAULT_DB_PATH,
  DEFAULT_PORT,
  ENTRY_PATH,
  SCHEMA_SQL,
  ROUTES,
  HttpError,
  openDatabase,
  foreignKeysEnabled,
  sendJson,
  createServer,
  start,
};
