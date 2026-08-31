'use strict';

// every action goes through the one backend path, exactly as the assignment requires
const ENDPOINT = '/server.js';

const el = (id) => document.getElementById(id);
const pesan = el('pesan');

// credentials same-origin makes the browser attach the session cookie, which is the only
// place the session id is ever kept; nothing here touches localStorage
async function panggil(aksi, { method = 'GET', form } = {}) {
  const options = { method, credentials: 'same-origin' };

  if (form) {
    options.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    options.body = new URLSearchParams(form).toString();
  }

  const res = await fetch(`${ENDPOINT}?aksi=${aksi}`, options);
  const data = await res.json().catch(() => ({}));

  if (!res.ok) throw new Error(data.error || `gagal dengan status ${res.status}`);
  return data;
}

// textContent, never innerHTML: server messages quote back what the user typed
function tampilkanPesan(teks, baik = false) {
  pesan.textContent = teks;
  pesan.classList.toggle('baik', baik);
  pesan.hidden = false;
}

function sembunyikanPesan() {
  pesan.hidden = true;
}

function tampilkanTamu() {
  el('tamu').hidden = false;
  el('pengguna').hidden = true;
}

function tampilkanPengguna(user) {
  el('nama-pengguna').textContent = user.nama;
  el('tamu').hidden = true;
  el('pengguna').hidden = false;
}

function gambarTabel(items) {
  const tbody = el('tabel-puisi').querySelector('tbody');
  tbody.replaceChildren();

  for (const item of items) {
    const tr = document.createElement('tr');
    for (const kolom of ['tgl_submit', 'judul', 'kategori']) {
      const td = document.createElement('td');
      td.textContent = item[kolom];
      tr.append(td);
    }
    tbody.append(tr);
  }

  el('kosong').hidden = items.length > 0;
}

async function muatDaftar() {
  const data = await panggil('daftar_puisi');
  gambarTabel(data.items);
}

async function muatInfoServer() {
  try {
    const info = await panggil('server_info');
    el('info-server').textContent =
      `Server ${info.hostname}, pid ${info.pid}, aktif ${info.uptime_seconds} detik, ` +
      `${info.sessions} sesi di memori, Node ${info.node}`;
  } catch {
    el('info-server').textContent = 'Info server tidak tersedia';
  }
}

// a session that died with the server looks exactly like never having logged in
async function segarkan() {
  const { user } = await panggil('whoami');

  if (user) {
    tampilkanPengguna(user);
    await muatDaftar();
  } else {
    tampilkanTamu();
  }

  await muatInfoServer();
}

function pasang(formId, jalankan) {
  el(formId).addEventListener('submit', async (event) => {
    event.preventDefault();
    sembunyikanPesan();

    const tombol = event.target.querySelector('button[type="submit"]');
    tombol.disabled = true;

    try {
      await jalankan(Object.fromEntries(new FormData(event.target)));
    } catch (err) {
      tampilkanPesan(err.message);
    } finally {
      tombol.disabled = false;
    }
  });
}

pasang('form-daftar', async (form) => {
  await panggil('register', { method: 'POST', form });
  tampilkanPesan(`Akun ${form.username} dibuat. Silakan masuk.`, true);
  el('form-daftar').reset();
});

pasang('form-masuk', async (form) => {
  await panggil('login', { method: 'POST', form });
  el('form-masuk').reset();
  await segarkan();
});

pasang('form-puisi', async (form) => {
  await panggil('submit_puisi', { method: 'POST', form });
  tampilkanPesan(`Puisi "${form.judul}" tersimpan.`, true);

  const tanggal = el('puisi-tanggal').value;
  el('form-puisi').reset();
  el('puisi-tanggal').value = tanggal;

  await muatDaftar();
  await muatInfoServer();
});

el('tombol-keluar').addEventListener('click', async () => {
  sembunyikanPesan();
  await panggil('logout', { method: 'POST' });
  tampilkanTamu();
  await muatInfoServer();
});

el('puisi-tanggal').value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
  .toISOString()
  .slice(0, 10);

segarkan().catch((err) => tampilkanPesan(err.message));
