# FreeFirst Router v3

Satu endpoint kompatibel OpenAI untuk webapp dan mobile app. Urutan pemakaian: **free tier → murah → premium**.
Satu dependensi (`pg`), Node 20+. State di Postgres.

## Yang baru di v3

| Fitur | Cara kerja |
|---|---|
| Lebih banyak provider free | NVIDIA NIM, Groq, Google Gemini, Cerebras, OpenRouter (`:free`), Mistral, Z.ai (GLM Flash). Berbayar/kredit: Xiaomi MiMo, DeepSeek, Anthropic. |
| **Penemuan model otomatis** | Tiap 6 jam (dan lewat `POST /admin/discover`) router membaca `/models` tiap provider, menyaring model non-chat (embedding, whisper, guard, dst.), lalu **menguji** model baru dengan 1 request kecil. Yang lolos otomatis menjadi route `free` di belakang route kurasi. Model yang hilang dinonaktifkan; route kurasi yang modelnya sudah tidak ada ikut dinonaktifkan. |
| **Ganti key otomatis** | Key yang mati (401/403) atau terkena limit (429) dilewati; request yang sama langsung dicoba dengan key berikutnya. Key mati ditandai di `/admin/stats` (key disamarkan). |
| **Radar provider baru** | Membaca daftar komunitas publik dan melaporkan provider OpenAI-compatible yang belum ada di config (`GET /admin/radar`, juga masuk log). Hanya melapor: menambahkannya butuh akun/key milik kamu. |
| Kelas model | Model dikelompokkan `small`/`large` dari nama dan ukuran. `auto-fast` memakai yang kecil dulu, `auto-smart` yang besar dulu. |
| Batas per menit & per akun | `limits.rpm`, serta `sharedLimits` untuk provider yang kuotanya dibagi semua model (mis. OpenRouter :free). |
| Pembatas percobaan | Maks. `MAX_ATTEMPTS` (6) panggilan provider per request; provider yang timeout/5xx dilewati untuk sisa request itu. |

Dari v2 tetap ada: reservasi biaya atomik, `allowedModels`/`maxTokens` per client, anggaran per proyek (`X-Project`), adapter Anthropic Messages API, `X-Task`, `X-Sensitive`.

## Mulai cepat

```bash
npm install
cp .env.example .env     # isi CLIENT_KEYS, ADMIN_KEY, dan key provider yang kamu punya
npm test                 # uji dengan provider palsu; TEST_DATABASE_URL=... untuk Postgres
npm start
curl -X POST localhost:20128/admin/discover -H "x-admin-key: ADMIN_KEY_MU"   # cari model free sekarang
```

## Provider dan statusnya

| Provider | Jenis | Catatan penting |
|---|---|---|
| NVIDIA NIM | free (prototipe) | Dev/uji; kira-kira 40 req/menit. Bukan untuk produksi ramai. |
| Groq | free | Batas per organisasi, bukan per key. |
| Google Gemini | free | Prompt free tier dapat dipakai Google untuk perbaikan produk; ada syarat khusus EEA/UK/CH (lihat bawah). |
| Cerebras | free | Nama model sering berubah; penemuan otomatis menanganinya. |
| OpenRouter | free (`:free`) | ±50 req/hari untuk semua model free sekaligus (`sharedLimits`); prompt dapat dicatat provider. |
| Mistral | free | Free tier dapat memakai data untuk training. |
| Z.ai | free (GLM Flash) | Hanya model `flash` yang disaring sebagai gratis. |
| Xiaomi MiMo | **kredit lalu berbayar** | Masuk tier `cheap` dengan biaya terlacak (bukan `free`), supaya tidak ada tagihan tak terduga. Header auth `api-key`; kalau 401, ganti `authStyle` ke `bearer`. |
| DeepSeek | kredit lalu berbayar | Tier `cheap`. |
| Anthropic | berbayar | Haiku (cheap), Sonnet/Opus (premium). |

Provider lain yang OpenAI-compatible: tambahkan satu blok di `providers` (`baseUrl`, `keyEnv`, opsional `discover`) lalu isi key. Radar akan memberi tahu kandidatnya.

## Soal "ganti API key" (penting dibaca)

- Router **berganti antar key yang kamu masukkan** (`GROQ_API_KEYS=key1,key2`) saat satu key mati atau kena limit.
- Batas free tier umumnya berlaku **per akun/organisasi, bukan per key**. Beberapa key dari akun yang sama **tidak menambah kuota**; fungsinya cadangan bila satu key dicabut.
- Router **tidak membuat akun atau key otomatis**, dan tidak dirancang untuk mengakali kuota dengan banyak akun. Itu umumnya melanggar syarat layanan provider dan bisa membuat akunmu diblokir.

## Admin

Header `x-admin-key`:
`GET /admin/stats` (pemakaian, belanja, kesehatan key, jumlah model temuan), `POST /admin/discover`, `GET /admin/discovered`, `GET /admin/radar?refresh=1`.

## Deploy ke Railway

1. Project baru + tambahkan **Postgres**, lalu deploy folder ini (Dockerfile ada).
2. Variables: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `CLIENT_KEYS`, `ADMIN_KEY`, key provider, `HOST=::`, `NODE_ENV=production`.
3. Jalankan 1 replika dulu. Job penemuan memakai lease di database, jadi hanya satu instance yang menjalankannya.
4. Backend webapp memanggil `http://<nama-service>.railway.internal:20128`. Mobile app memanggil backend-mu, bukan gateway.

## Yang WAJIB kamu cek sendiri

- **Free tier berubah tanpa pemberitahuan** (limit, model, syarat). Contoh yang ditemukan saat riset: Google membatasi pelayanan pengguna akhir di EEA/CH/UK pada free tier; ToS OpenRouter melarang menjual ulang akses API atau membangun layanan pesaing; NVIDIA menyebut tier gratis untuk prototipe. **Baca syarat tiap provider sebelum melayani pengguna sungguhan lewat free tier.**
- Free tier cocok untuk pengembangan dan beban kecil. Untuk produksi, siapkan tier berbayar sebagai tulang punggung (`cheap`/`premium`), bukan cadangan.
- Nama model, `limits`, `cost` di `router.config.json` adalah contoh/placeholder. Harga model Claude dan Xiaomi harus kamu samakan dengan halaman harga resmi.
- **Belum diuji ke API provider asli**: semua tes memakai provider tiruan (termasuk penemuan model, adapter Anthropic, dan auth `api-key` Xiaomi). Coba satu key dan satu provider dulu.
- Penyaring model non-chat memakai pola nama; model yang lolos filter tapi bukan chat akan gagal saat uji dan ditandai `failed`/`dead`, tidak dipakai.
- Flag `privacy` penilaian kasar, bukan jaminan kontrak. Free tier bisa memakai datamu untuk training; jangan kirim data pribadi lewat tier gratis.
- Batas `rpm` dihitung per instance (di memori); dengan beberapa replika batasnya berlipat. Batas harian dan budget dibagi lewat Postgres.
- Radar membaca README komunitas yang bisa usang atau salah parse; anggap sebagai petunjuk, bukan fakta.
