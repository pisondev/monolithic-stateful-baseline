'use strict';

// one file by assignment rule: a single server-side script behind a single URL path

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'app.db');

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

function start() {
  const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;
  const db = openDatabase(dbPath);

  console.log(`database ready at ${dbPath}`);
  console.log(`foreign key enforcement: ${foreignKeysEnabled(db) ? 'on' : 'off'}`);
  return { db };
}

if (require.main === module) {
  start();
}

module.exports = {
  DEFAULT_DB_PATH,
  SCHEMA_SQL,
  openDatabase,
  foreignKeysEnabled,
  start,
};
