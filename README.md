# Monolithic Stateful Baseline

Assignment 1 for **PACS262521 Pengembangan Perangkat Lunak Scalable**, S1 Ilmu Komputer,
Universitas Gadjah Mada.

**Author:** Pison Golda Mountera (24/543770/PA/23107)

A poem submission service built as a deliberately monolithic, stateful application: one
server-side script, one process, session state in local RAM, and a database file on the same
host. None of that is an oversight. The assignment asks for the architecture that does *not*
scale horizontally, so that the constraint can be measured rather than described, and so the
later stateless work in this course has a real baseline to improve on.

The interesting property of this design is not that it works. It is that restarting the
process logs everyone out while losing no data at all, and that running a second copy behind
a load balancer would split users into two disconnected session worlds. Both are
demonstrated below.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 22 LTS, standard library only |
| HTTP | `node:http`, no framework |
| Database | SQLite through the built-in `node:sqlite`, local file |
| Sessions | In-process `Map`, opaque identifier in an `HttpOnly` cookie |
| Passwords | `node:crypto` scrypt, per-user salt |
| Frontend | Hand-written HTML, CSS and JavaScript, `fetch()` only |
| Tests | Built-in `node --test` |

Runtime dependencies: **none**. `package.json` declares an empty `dependencies` object, and
a test asserts that every `require` in `server.js` resolves to a `node:` builtin. The
assignment bans frameworks that abstract session management away, so nothing is installed
that could.

## Requirements

Node.js **22.5 or newer, below 23**. `node:sqlite` is built in from 22.5 but still requires
the `--experimental-sqlite` flag, which the npm scripts pass for you. Node 23 and later drop
the flag and would reject it.

## Running

```
npm start        # http://localhost:8080
npm test
```

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `DB_PATH` | `./data/app.db` | SQLite file, or `:memory:` |
| `SESSION_TTL_MS` | `1800000` | Session lifetime. Set to a few seconds to show expiry live |
| `SESSION_SWEEP_MS` | `60000` | How often expired sessions are evicted |
| `MAX_BODY_BYTES` | `65536` | Request body cap |
| `COOKIE_SECURE` | off | Set to `1` once anything terminates TLS in front |

Nothing is hardcoded that a deployment might need to change, and there is no `.env` file
because there is no secret to keep in one.

## API

Every action shares a single path, `/server.js?aksi=<name>`, mirroring the
`server.php?aksi=` example in the brief. The method is part of the contract and a mismatch
answers `405` with an `Allow` header.

| Action | Method | Session | Input | Output |
|---|---|---|---|---|
| `register` | POST | no | `username`, `nama`, `password`, optional `no_id` | `201 {ok, id, username}` |
| `login` | POST | no | `username`, `password` | `200` plus `Set-Cookie: SID=...` |
| `submit_puisi` | POST | yes | `judul`, `isi`, `tgl_submit`, `kategori`, `keywords` | `201 {ok, id}` |
| `daftar_puisi` | GET | yes | none | `200 {items: [{tgl_submit, judul, kategori}]}` |
| `logout` | POST | no | none | `200 {ok}`, clears the cookie |
| `whoami` | GET | no | none | `200 {user}` or `200 {user: null}` |
| `server_info` | GET | no | none | `200 {hostname, pid, uptime_seconds, sessions, node}` |

The last three are additions. The four the assignment mandates are unchanged in name,
method, input and output.

Bodies are accepted as `application/x-www-form-urlencoded` or `application/json`. Errors
return `{"error": "<message>"}` with `400`, `401`, `404`, `405`, `409`, `413`, `415` or
`500`.

## State model

This is the part the assignment is actually about.

```
Browser                        EC2 t2.micro, one process
  cookie jar                     server.js
    SID=3f9a...  ---------->       sessions: Map<sid, {userId, ...}>   <- RAM
                                   data/app.db                         <- local disk
```

The cookie carries 32 random bytes and nothing else. It is not a token: it says nothing
about who you are, and it cannot be verified in isolation. Every request resolves identity
by looking the identifier up in a `Map` that exists only inside this process. That is what
the brief means by *server-side local session*, and it is why JWT is ruled out.

The consequences are the point:

- **Restarting the process logs everyone out.** The database is untouched, so no poem is
  lost. Only the sessions are gone, because they were never anywhere but memory.
- **A second instance cannot help.** A load balancer sending a logged-in user to the other
  copy would find no session there. Making this work would require sticky sessions, which is
  the constraint that limits distribution.
- **The failure is asymmetric.** Data survives, state does not. That distinction is the
  whole lesson.

Reproducing it takes one restart:

```
before   {"hostname":"...","pid":22868,"uptime_seconds":2,"sessions":1}   daftar_puisi -> 200
after    {"hostname":"...","pid":32580,"uptime_seconds":1,"sessions":0}   daftar_puisi -> 401
```

The browser still holds the cookie and still sends it. The `401` path deliberately does not
clear it, because watching a valid-looking cookie be refused is more informative than
watching it disappear. `logout` does clear it, since there the user asked to leave.

## Database

Column names and order follow the assignment exactly, including two that look like typos and
are not. `docs/schema.sql` carries a readable copy, and a test fails if it drifts from what
the server applies.

```sql
users   id, username, password, nama, no_id
puisi   id, user_id, judul, tgl_submit, isi, kategori, keyword
```

`PRAGMA foreign_keys = ON` is the load-bearing line. SQLite parses a `FOREIGN KEY` clause but
enforces it only when foreign key support is switched on for the connection, so without that
pragma the mandated integrity rule would pass review and never fire. A test inserts an orphan
poem and requires it to be rejected.

## Decisions that look wrong until explained

| Decision | Why |
|---|---|
| The entire server is one file | The brief requires a single server-side script reached through a single URL path. Splitting it into routes and controllers would break that rule, not improve the code |
| `users.no_id` exists but registration does not require it | The mandated schema lists the column; the mandated inputs do not. It is nullable and optional, so both rules hold |
| The column is `keyword`, the form field is `keywords` | The schema is singular, the action spec is plural. Each follows its own source and the handler maps between them |
| `tgl_submit` comes from the client | The brief lists it as an input, not a server timestamp. It is validated as a real calendar date; today is only the fallback |
| `daftar_puisi` lists only your own poems | The specified output has no author column, which only reads as complete for a single author. It also makes the session a real input to the response |
| The cookie has no `Secure` flag by default | The brief deploys over plain HTTP, where a `Secure` cookie would never be sent back. It is a config flag, not a hardcoded omission |
| Passwords are hashed although nothing asked | The database sits behind a public IP. `node:crypto` covers it, so no constraint is affected |
| A rejected session leaves the stale cookie in place | It is the evidence the demonstration depends on |

## Tests

```
npm test
```

Eighteen cases on the built-in runner, covering the mandated contract rather than every
branch: the schema and its foreign key, both credential paths, the session guard, the exact
three-field listing, the router, body parsing at both encodings and both size defences, and
the constraints the brief places on the frontend.

The suite was checked by mutation rather than trusted. Twelve deliberate breaks were
injected into `server.js`; ten turned the suite red. One survivor was correct, since two
defences cover the same rule. The other was a real gap: every case sent a body with a
`Content-Length` header, so the streaming byte counter was never exercised, and a 320 KB
chunked upload against a 64 KB cap passed unnoticed. That case is now covered.

## Known limitations

Stated plainly, because most of them are the assignment working as intended.

- **Sessions do not survive a restart and cannot be shared.** By design.
- **Traffic is plain HTTP.** A session identifier crossing an untrusted network in cleartext
  can be captured and replayed. TLS belongs at the load balancer, which is a later
  assignment; the code is ready for it through `COOKIE_SECURE`.
- **`tgl_submit` is client controlled.** The brief specifies it as an input, so a poem can be
  filed under any valid date. Only the calendar validity is checked.
- **Static files are read from disk on every request.** Fine at this scale, and it stays
  visible as a baseline characteristic worth measuring later.
- **One process, one core.** No clustering, no worker threads, no caching layer.

## Layout

```
server.js            the single server-side program, twelve numbered sections
public/              index.html, style.css, app.js
test/app.test.js     the suite
docs/schema.sql      reference schema
docs/                deployment runbook and service unit
data/                runtime database, gitignored
```

Exactly one file runs on the server. `public/` is the frontend the brief asks for, `test/`
is not part of the served application, and `docs/` is prose and configuration. The
single-path rule is intact.
