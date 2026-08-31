# Changelog

## 0.1.0

First complete baseline: all four mandated actions, a minimal frontend, and a test suite.

**Backend**

- Single-path HTTP entry point at `/server.js?aksi=<name>`, with the method enforced per action and prototype keys unable to resolve as handlers.
- Local SQLite schema applied at startup, with `PRAGMA foreign_keys = ON` so the mandated constraint is enforced rather than merely declared.
- Request bodies parsed for urlencoded and JSON, capped by both a `Content-Length` check and a streaming byte counter, returning a null-prototype object.
- In-memory session store keyed by 32 random bytes, absolute expiry, unreferenced sweeper, and no persistence of any kind.
- `register` with scrypt password hashing, per-user salt, and parameters stored in the record so a later retune leaves old accounts verifiable.
- `login` issuing an `HttpOnly` session cookie, answering one identical `401` for both failure modes and spending equal time on each.
- Session guard declared in the route table, so a protected action cannot omit it.
- `submit_puisi` filing under the session owner, mapping the `keywords` input to the `keyword` column, validating `tgl_submit` as a real calendar date.
- `daftar_puisi` returning the caller's own poems and exactly the three specified fields.
- `logout`, `whoami` and `server_info` as supporting actions.
- Static handler for the frontend, resolving paths before checking them so the backend source cannot be walked out to.

**Frontend**

- Register, login, poem submission and listing, in plain HTML, CSS and JavaScript with no framework and no external resource.
- Rendering through `textContent` and `createElement` only, since server errors quote user input back.
- The session lives solely in the cookie jar; nothing is written to `localStorage`.
- Live hostname, pid, uptime and session count in the footer, so a restart is visible without leaving the page.

**Tests**

- Eighteen cases on the built-in `node --test` runner, covering the mandated contract and the constraints the brief places on the frontend.
- `docs/schema.sql` checked against the schema the server applies, so the two cannot drift.
- Suite verified by mutation: twelve deliberate breaks, ten caught, one correct survivor, one real gap since closed.

**Fixes**

- Password verification decoded hex loosely. `Buffer.from` stops at the first invalid character and returns what it read, so a corrupt record decoded to an empty buffer that `timingSafeEqual` reported as equal, letting any password authenticate. Both halves are now length checked.
- Cookie `Max-Age` rounded down to `0` for any sub-second `SESSION_TTL_MS`, which instructs the browser to delete the cookie at once and silently broke the short lifetime documented for live demos. It is floored at one second.
- Error handling keyed off the status code, so every deliberate `501` printed a stack trace. It now keys off the error type: an `HttpError` is a reply, anything else is a bug.
- `npm test` invoked `node --test test/`, which Node 22 on Windows reads as a module path rather than a directory. It uses discovery mode.
