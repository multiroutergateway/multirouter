# FreeFirst Router v2

Satu endpoint kompatibel OpenAI untuk webapp dan mobile app.
Urutan pemakaian: **free tier → murah → premium (tugas berat)**. Satu dependensi (`pg`), Node 20+.

## Yang baru di v2

| Perbaikan | Detail |
|---|---|
| Reservasi biaya | Estimasi biaya (input + `max_tokens`) diamankan **atomik sebelum** memanggil provider berbayar. Request bersamaan tidak bisa menembus batas. Setelah selesai, selisih dikoreksi. |
| State di Postgres | Kuota route, belanja, cooldown, dan rate limit tahan redeploy dan dipakai bersama beberapa instance. Tanpa `DATABASE_URL` = memori (hanya dev; mode produksi menolak start). |
| `allowedModels` per client | Client hanya boleh memakai alias yang diizinkan (default: `auto`, `auto-fast`, `auto-smart`). Memaku route atau `auto-heavy` harus diizinkan eksplisit. |
| `max_tokens` dibatasi | Per client (`maxTokens`), supaya satu request tidak bisa menghabiskan budget. |
| Anggaran per proyek | Header `X-Project: digium` → batas harian proyek (`projects` di config). |
| Adapter Anthropic asli | Memakai Messages API (`/v1/messages`): teks, gambar, system prompt, tools, streaming. |
| Estimasi token lebih konservatif | Menghitung definisi tools dan gambar. |
| Lain-lain | Key client di-hash dan dibandingkan aman; `HOST`; `/ready` (cek DB); log JSON per request tanpa isi prompt; reservasi yatim ditagih penuh (aman terhadap budget). |

## Mulai cepat (lokal)

```bash
npm install
cp .env.example .env     # isi CLIENT_KEYS, ADMIN_KEY, dan key provider yang kamu punya
npm test                 # uji dengan provider palsu (memori)
npm start                # http://127.0.0.1:20128
```

Uji dengan Postgres: `TEST_DATABASE_URL=postgres://... npm test`.

## Memilih model

| `model` | Perilaku |
|---|---|
| `auto` | Tugas biasa → `auto-fast`; input panjang → `auto-smart`; paksa dengan header `X-Task: fast/smart/heavy` (turun otomatis bila client tidak berhak atas tier itu) |
| `auto-fast` | Semua free → lalu murah |
| `auto-smart` | Model gratis terbesar → DeepSeek → Sonnet |
| `auto-heavy` | Premium (Sonnet → Opus), cadangan model murah |
| `groq/llama-70b` dst. | Dipaku ke satu route, tanpa fallback (butuh izin) |

Data sensitif: header `X-Sensitive: true` → hanya route berlabel `"privacy": "private"`.

## Policy per client & proyek (`router.config.json`)

```json
"clients":  { "web": { "allowedModels": ["auto","auto-heavy"], "dailyUsd": 1, "maxTokens": 4096 },
              "mobile": { "dailyUsd": 0.3, "maxTokens": 1024 } },
"projects": { "digium": { "dailyUsd": 2 } }
```

Nama client = nama di `CLIENT_KEYS` (`web=...,mobile=...`). Batas global lewat `GLOBAL_DAILY_USD`.

## Pemakaian dari backend webapp

```js
const r = await fetch(process.env.AI_GATEWAY_URL + "/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${process.env.AI_GATEWAY_KEY}`, "x-project": "digium" },
  body: JSON.stringify({ model: "auto", messages }),   // model ditentukan backend, bukan dari client
});
```

Jangan teruskan seluruh body dari browser/mobile. Ambil `messages` saja. Mobile app memanggil backend-mu (dengan login user), bukan gateway.

## Deploy ke Railway

1. Buat project, tambahkan **Postgres**, lalu **New → GitHub repo / Docker** untuk folder ini (Dockerfile sudah ada).
2. Variables di service gateway:
   - `DATABASE_URL` = referensi ke Postgres (`${{Postgres.DATABASE_URL}}`)
   - `CLIENT_KEYS`, `ADMIN_KEY` (acak, panjang), key provider, batas biaya
   - `HOST=::` (agar bisa dijangkau lewat private networking Railway), `NODE_ENV=production`
3. Jalankan **1 replika dulu**. Beberapa replika didukung oleh desain (state di Postgres), tapi belum saya uji dengan dua proses terpisah.
4. Backend webapp memanggil `http://<nama-service>.railway.internal:20128` (private networking). Tidak perlu domain publik untuk gateway.
5. Health check: `/health` (hidup) dan `/ready` (DB terhubung). Pantau: `GET /admin/stats` dengan header `x-admin-key`.

## Yang WAJIB kamu cek sendiri

- **Nama model, `limits`, dan `cost` di config hanyalah contoh.** Harga model Claude di config adalah placeholder; samakan dengan halaman harga terbaru.
- Adapter Anthropic **belum diuji ke API asli**, hanya ke server tiruan. Coba dengan satu key dan request kecil dulu.
- Flag `privacy` adalah penilaian kasar, bukan jaminan kontrak. Verifikasi kebijakan data tiap provider.
- Free tier bisa memakai datamu untuk training; jangan kirim data pribadi lewat tier gratis.
- Batas harian route (`rpd`/`tpd`) bersifat lunak (cek lalu pakai, tidak atomik); provider tetap menegakkan batasnya sendiri lewat 429.
- Streaming: fallback hanya sebelum byte pertama. Bila usage tidak diketahui, route berbayar ditagih sebesar estimasi penuh.
- Hari dihitung UTC; reset kuota tiap provider bisa berbeda.
- Pemakaian free tier mengikuti syarat layanan tiap provider (jangan membuat banyak akun hanya untuk menambah kuota).
