'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');

const app = require('../server.js');

const ROOT = path.join(__dirname, '..');

let ctx;
let server;
let origin;
let akunKe = 0;

before(async () => {
  ctx = { db: app.openDatabase(':memory:'), sessions: app.createSessionStore() };
  server = app.createServer(ctx);
  await new Promise((ready) => server.listen(0, ready));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((closed) => server.close(closed));
  ctx.db.close();
});

async function panggil(aksi, { method = 'GET', form, cookie } = {}) {
  const res = await fetch(`${origin}/server.js?aksi=${aksi}`, {
    method,
    headers: {
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });

  return {
    status: res.status,
    body: await res.json().catch(() => null),
    setCookie: res.headers.getSetCookie(),
    allow: res.headers.get('allow'),
  };
}

// a fresh account per test, so no test depends on another having run first
async function akun() {
  akunKe += 1;
  const username = `warga${akunKe}`;
  const password = 'rahasia123';

  await panggil('register', { method: 'POST', form: { username, nama: `Warga ${akunKe}`, password } });
  const masuk = await panggil('login', { method: 'POST', form: { username, password } });

  return { username, cookie: masuk.setCookie[0].split(';')[0] };
}

const puisi = (extra = {}) => ({
  judul: 'Hujan Agustus',
  isi: 'langit turun perlahan',
  kategori: 'Alam',
  tgl_submit: '2026-08-30',
  ...extra,
});

test('the schema matches the assignment and the foreign key is enforced', () => {
  const kolom = (tabel) => ctx.db.prepare(`PRAGMA table_info(${tabel})`).all().map((c) => c.name);

  assert.deepStrictEqual(kolom('users'), ['id', 'username', 'password', 'nama', 'no_id']);
  assert.deepStrictEqual(kolom('puisi'), [
    'id', 'user_id', 'judul', 'tgl_submit', 'isi', 'kategori', 'keyword',
  ]);
  assert.strictEqual(app.foreignKeysEnabled(ctx.db), true);

  // without the pragma this insert would be accepted and the constraint would be decorative
  assert.throws(
    () => ctx.db
      .prepare('INSERT INTO puisi (user_id, judul, tgl_submit, isi, kategori, keyword) VALUES (?,?,?,?,?,?)')
      .run(999999, 'x', '2026-08-30', 'y', 'z', null),
    /FOREIGN KEY/i,
  );
});

test('docs/schema.sql has not drifted from the schema the server applies', () => {
  const normalise = (sql) => sql
    .replace(/--[^\n]*/g, '')
    .replace(/PRAGMA[^;]*;/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const berkas = fs.readFileSync(path.join(ROOT, 'docs/schema.sql'), 'utf8');
  assert.strictEqual(normalise(berkas), normalise(app.SCHEMA_SQL));
});

test('passwords are stored as a salted scrypt record, never as plaintext', async () => {
  const record = await app.hashPassword('rahasia123');

  assert.ok(!record.includes('rahasia123'));
  assert.notStrictEqual(record, await app.hashPassword('rahasia123'));
  assert.strictEqual(await app.verifyPassword('rahasia123', record), true);
  assert.strictEqual(await app.verifyPassword('rahasia124', record), false);

  // hex decoding stops at the first bad character, so a corrupt record once compared equal
  // to every password; both halves are length checked now
  for (const rusak of ['', 'scrypt$16384$8$1$zz$zz', 'scrypt$16384$8$1$$', 'bcrypt$1$1$1$aa$bb']) {
    assert.strictEqual(await app.verifyPassword('rahasia123', rusak), false, rusak);
  }
});

test('register creates an account and refuses a duplicate username', async () => {
  const r = await panggil('register', {
    method: 'POST',
    form: { username: 'ganda', nama: 'Ganda', password: 'rahasia123' },
  });
  assert.strictEqual(r.status, 201);

  const row = ctx.db.prepare('SELECT * FROM users WHERE username = ?').get('ganda');
  assert.strictEqual(row.nama, 'Ganda');
  assert.ok(!row.password.includes('rahasia123'));

  // sqlite compares UNIQUE case sensitively, so usernames are lowercased before they reach it
  const lagi = await panggil('register', {
    method: 'POST',
    form: { username: 'GANDA', nama: 'Ganda Lain', password: 'rahasia123' },
  });
  assert.strictEqual(lagi.status, 409);
});

test('login issues an opaque HttpOnly cookie and rejects bad credentials alike', async () => {
  await panggil('register', {
    method: 'POST',
    form: { username: 'masuk', nama: 'Masuk', password: 'rahasia123' },
  });

  const ok = await panggil('login', { method: 'POST', form: { username: 'masuk', password: 'rahasia123' } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.setCookie.length, 1);
  assert.match(ok.setCookie[0], /^SID=[0-9a-f]{64};/);
  assert.ok(ok.setCookie[0].includes('HttpOnly'));
  assert.ok(ok.setCookie[0].includes('SameSite=Lax'));
  assert.ok(!ok.setCookie[0].includes('masuk'), 'the cookie must carry no identity of its own');

  const salah = await panggil('login', { method: 'POST', form: { username: 'masuk', password: 'salah123' } });
  const hantu = await panggil('login', { method: 'POST', form: { username: 'tidakada', password: 'salah123' } });

  assert.strictEqual(salah.status, 401);
  assert.strictEqual(hantu.status, 401);
  assert.strictEqual(salah.body.error, hantu.body.error, 'neither failure may reveal whether the account exists');
  assert.strictEqual(salah.setCookie.length, 0);
});

test('submit_puisi needs a session and files the poem under the session owner', async () => {
  const { cookie } = await akun();

  const tanpa = await panggil('submit_puisi', { method: 'POST', form: puisi() });
  assert.strictEqual(tanpa.status, 401);

  const dengan = await panggil('submit_puisi', {
    method: 'POST',
    cookie,
    form: puisi({ keywords: 'hujan, kenangan', user_id: '1' }),
  });
  assert.strictEqual(dengan.status, 201);

  const row = ctx.db.prepare('SELECT * FROM puisi WHERE id = ?').get(dengan.body.id);
  const pemilik = ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(`warga${akunKe}`).id;

  assert.strictEqual(row.user_id, pemilik, 'a user_id sent by the client must be ignored');
  assert.strictEqual(row.keyword, 'hujan, kenangan', 'the keywords input maps to the keyword column');
  assert.strictEqual(row.tgl_submit, '2026-08-30', 'tgl_submit comes from the client, per the brief');
});

test('tgl_submit is rejected when it is not a real calendar date', async () => {
  const { cookie } = await akun();

  for (const tanggal of ['30-08-2026', '2026-02-30', '2026-13-01', '2025-02-29']) {
    const r = await panggil('submit_puisi', { method: 'POST', cookie, form: puisi({ tgl_submit: tanggal }) });
    assert.strictEqual(r.status, 400, tanggal);
  }

  const kabisat = await panggil('submit_puisi', { method: 'POST', cookie, form: puisi({ tgl_submit: '2024-02-29' }) });
  assert.strictEqual(kabisat.status, 201);
});

test('daftar_puisi returns only the caller poems and only the three specified fields', async () => {
  const a = await akun();
  const b = await akun();

  await panggil('submit_puisi', { method: 'POST', cookie: a.cookie, form: puisi({ judul: 'Milik A', isi: 'rahasia a' }) });
  await panggil('submit_puisi', { method: 'POST', cookie: b.cookie, form: puisi({ judul: 'Milik B' }) });

  const tanpa = await panggil('daftar_puisi');
  assert.strictEqual(tanpa.status, 401);

  const daftar = await panggil('daftar_puisi', { cookie: a.cookie });
  assert.strictEqual(daftar.status, 200);
  assert.deepStrictEqual(daftar.body.items.map((i) => i.judul), ['Milik A']);

  for (const item of daftar.body.items) {
    assert.deepStrictEqual(Object.keys(item).sort(), ['judul', 'kategori', 'tgl_submit']);
  }
  assert.ok(!JSON.stringify(daftar.body).includes('rahasia a'), 'the poem body is not part of the listing');
});

test('the router enforces the method and the action name', async () => {
  const { cookie } = await akun();

  assert.strictEqual((await panggil('daftar_puisi', { method: 'POST', cookie })).status, 405);
  assert.strictEqual((await panggil('login')).allow, 'POST');
  assert.strictEqual((await panggil('tidak_ada')).status, 404);

  // a prototype key must not resolve to an inherited property and get called as a handler
  for (const kunci of ['__proto__', 'constructor', 'toString']) {
    assert.strictEqual((await panggil(kunci)).status, 404, kunci);
  }
});

test('the request body is parsed for both encodings and capped', async () => {
  const { cookie } = await akun();

  const json = await fetch(`${origin}/server.js?aksi=submit_puisi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(puisi({ judul: 'Lewat JSON' })),
  });
  assert.strictEqual(json.status, 201);

  const besar = await panggil('submit_puisi', {
    method: 'POST',
    cookie,
    form: puisi({ isi: 'x'.repeat(app.MAX_BODY_BYTES + 1000) }),
  });
  assert.strictEqual(besar.status, 413);

  const asing = await fetch(`${origin}/server.js?aksi=submit_puisi`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Cookie: cookie },
    body: 'halo',
  });
  assert.strictEqual(asing.status, 415);
});

// the cap has two independent defences and a Content-Length body only exercises the first,
// so an oversized chunked upload is the only way to prove the streaming counter works
test('the size cap holds for a chunked body that declares no Content-Length', async () => {
  const { cookie } = await akun();
  const total = app.MAX_BODY_BYTES * 3;
  let terkirim = 0;

  const aliran = new ReadableStream({
    pull(controller) {
      if (terkirim >= total) return controller.close();
      const potong = Math.min(8192, total - terkirim);
      terkirim += potong;
      return controller.enqueue(new TextEncoder().encode('x'.repeat(potong)));
    },
  });

  const res = await fetch(`${origin}/server.js?aksi=submit_puisi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: aliran,
    duplex: 'half',
  });

  assert.strictEqual(res.status, 413);

  // cutting the socket must not take the server down with it
  assert.strictEqual((await panggil('daftar_puisi', { cookie })).status, 200);
});

test('logout destroys the session and clears the cookie', async () => {
  const { cookie } = await akun();
  assert.strictEqual((await panggil('daftar_puisi', { cookie })).status, 200);

  const keluar = await panggil('logout', { method: 'POST', cookie });
  assert.strictEqual(keluar.status, 200);
  assert.ok(keluar.setCookie[0].includes('Max-Age=0'));

  assert.strictEqual((await panggil('daftar_puisi', { cookie })).status, 401);
  assert.strictEqual((await panggil('logout', { method: 'POST', cookie })).status, 200, 'logout is idempotent');
});

// the whole reason this baseline exists
test('emptying the session store invalidates every live cookie, as a restart would', async () => {
  const a = await akun();
  const b = await akun();

  assert.strictEqual((await panggil('daftar_puisi', { cookie: a.cookie })).status, 200);
  assert.strictEqual((await panggil('daftar_puisi', { cookie: b.cookie })).status, 200);
  assert.ok((await panggil('server_info')).body.sessions >= 2);

  ctx.sessions.clear();

  assert.strictEqual((await panggil('server_info')).body.sessions, 0);
  assert.strictEqual((await panggil('daftar_puisi', { cookie: a.cookie })).status, 401);
  assert.strictEqual((await panggil('daftar_puisi', { cookie: b.cookie })).status, 401);

  // the poems survive, because they are data on disk rather than state in memory
  assert.ok(ctx.db.prepare('SELECT COUNT(*) c FROM puisi').get().c > 0);
});

test('an expired session is refused even though the cookie is still valid', async () => {
  const singkat = { db: ctx.db, sessions: app.createSessionStore({ ttlMs: 80 }) };
  const lain = app.createServer(singkat);
  await new Promise((ready) => lain.listen(0, ready));

  const url = `http://127.0.0.1:${lain.address().port}/server.js?aksi=daftar_puisi`;
  const id = singkat.sessions.create({ id: 1, username: 'x', nama: 'X' });

  assert.strictEqual((await fetch(url, { headers: { Cookie: `SID=${id}` } })).status, 200);
  await new Promise((lewat) => setTimeout(lewat, 140));
  assert.strictEqual((await fetch(url, { headers: { Cookie: `SID=${id}` } })).status, 401);

  await new Promise((closed) => lain.close(closed));
});

test('the static handler serves the page and cannot be walked out of', async () => {
  const halaman = await fetch(`${origin}/`);
  assert.strictEqual(halaman.status, 200);
  assert.match(halaman.headers.get('content-type'), /text\/html/);

  // the entry path and the backend file share a name, so the source is one slip away
  const sumber = await fetch(`${origin}/server.js`);
  assert.ok(!(await sumber.text()).includes('SCHEMA_SQL'));

  for (const serangan of ['/../server.js', '/%2e%2e%2fserver.js', '/../../etc/passwd', '/....//server.js']) {
    const r = await fetch(origin + serangan);
    assert.ok(r.status === 404 || r.status === 400, `${serangan} answered ${r.status}`);
    assert.ok(!(await r.text()).includes('SCHEMA_SQL'), serangan);
  }
});

test('the frontend obeys the constraints the brief sets for it', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

  // strip comments first: a note explaining why localStorage is avoided is not a use of it
  const kode = js.replace(/^\s*\/\/.*$/gm, '');

  assert.ok(!/https?:\/\//i.test(html + css), 'no external resource may be referenced');
  assert.ok(!/bootstrap|tailwind|react|vue|jquery/i.test(html + css + kode), 'no framework allowed');
  assert.ok(!/localStorage|sessionStorage/.test(kode), 'the session belongs in the cookie jar alone');
  assert.ok(!/\binnerHTML\b|insertAdjacentHTML|document\.write/.test(kode), 'server errors quote user input back');
  assert.ok(/credentials:\s*'same-origin'/.test(kode), 'fetch must send the session cookie');

  for (const aksi of new Set([...kode.matchAll(/panggil\('([a-z_]+)'/g)].map((m) => m[1]))) {
    assert.ok(Object.hasOwn(app.ROUTES, aksi), `the page calls an unknown action: ${aksi}`);
  }
});

test('the project still declares no runtime dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.deepStrictEqual(pkg.dependencies, {}, 'the brief bans frameworks, so nothing is installed');
  assert.strictEqual(pkg.devDependencies, undefined);

  const sumber = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  for (const [, modul] of sumber.matchAll(/require\('([^']+)'\)/g)) {
    assert.ok(modul.startsWith('node:'), `server.js requires something outside the standard library: ${modul}`);
  }
});

test('exactly the two mandated actions are session protected', () => {
  const dijaga = Object.entries(app.ROUTES).filter(([, r]) => r.auth).map(([nama]) => nama).sort();
  assert.deepStrictEqual(dijaga, ['daftar_puisi', 'submit_puisi']);

  assert.strictEqual(app.ROUTES.register.method, 'POST');
  assert.strictEqual(app.ROUTES.login.method, 'POST');
  assert.strictEqual(app.ROUTES.submit_puisi.method, 'POST');
  assert.strictEqual(app.ROUTES.daftar_puisi.method, 'GET');
});
