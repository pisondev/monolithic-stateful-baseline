-- reference copy, server.js holds the authoritative version and applies it at startup
-- no_id and singular keyword are copied from the mandated schema, not typos

-- sqlite parses foreign keys but only enforces them per connection with this pragma
PRAGMA foreign_keys = ON;

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
