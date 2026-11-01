# FreeFirst Router v3.2 — audit dan perubahan

Tanggal audit: 2026-10-30

## Temuan utama dari v3.1

1. Discovery dapat memperlakukan model dengan metadata harga yang tidak tersedia sebagai gratis. Ini berisiko mengaktifkan model berbayar sebagai route `free`.
2. Route non-free yang tidak memiliki harga valid tidak mempunyai perlindungan biaya yang cukup eksplisit.
3. `auto-heavy` mencoba premium sebelum model gratis besar, bertentangan dengan kebijakan free-first yang diminta.
4. Provider dengan kuota tingkat akun/org dapat terkena 429 berulang saat router mencoba API key lain dari akun yang sama.
5. `privacy: "private"` pada route Anthropic bawaan tidak dibuktikan oleh konfigurasi sebagai jaminan kontrak/data handling.
6. Limit per pengguna sebelumnya hanya berada di contoh backend dan bersifat in-memory; belum ada enforcement per pengguna di gateway berbasis Postgres.
7. Dockerfile sebelumnya berjalan sebagai root dan belum ada Compose stack untuk VPS + Postgres + bind WireGuard.

## Perubahan v3.2

- Discovery fail-closed: harga nol atau suffix `:free` dapat dianggap terverifikasi; harga positif diberi `not_free`; harga tak diketahui diberi `unverified_free`. `discover.assumeFree: true` tersedia hanya sebagai opt-in operator per provider setelah memeriksa syarat akun/provider.
- Route `cheap`/`premium` dan route apa pun dengan biaya positif memerlukan `pricingVerified: true`, nilai biaya input/output yang valid, dan biaya total positif sebelum dipanggil. Default route berbayar sengaja belum aktif sampai operator memverifikasi harga resmi.
- `auto-heavy` kini urutannya free large → cheap → premium.
- Groq dan OpenRouter ditandai memiliki kuota bersama; 429 membuat cooldown tingkat provider, bukan rotasi key tanpa manfaat.
- `web` dan `mobile` mewajibkan `X-User-ID`, dengan batas RPM per user dan budget harian paid per user. ID di-HMAC dengan `USER_ID_HASH_SECRET`; ID mentah tidak disimpan di tabel rate/spend.
- Route Anthropic default menjadi `privacy: "unverified"`. Untuk mengizinkan `X-Sensitive: true`, operator perlu memverifikasi kontrak/data handling lalu secara sadar mengubah label route menjadi `private`.
- Bearer auth lebih ketat dan produksi mewajibkan admin/client key minimal 32 karakter serta `USER_ID_HASH_SECRET` terpisah dan stabil.
- Estimasi token dibuat lebih konservatif; overrun aktual dibanding reservasi dicatat sebagai event JSON.
- Ditambahkan Docker Compose Postgres + gateway, bind localhost secara default, opsi bind ke IP WireGuard, container non-root, read-only, dan pengurangan capability.
- Backend Express/Next.js meneruskan `X-User-ID` dari identitas yang sudah terautentikasi.

## Verifikasi yang dilakukan

- `node --check` pada JavaScript/MJS dalam `src`, `examples`, dan `test`: lulus.
- `npm test`: discovery/radar, adapter Anthropic, store memory, smoke test termasuk pricing gate, user limit/budget, dan shared-account 429: lulus.
- Parsing YAML `docker-compose.yml`: lulus.

## Belum diverifikasi

- `npm run test:examples` belum lulus di lingkungan audit karena dependensi `express` tidak tersedia; perlu menjalankan `npm --prefix examples/express install` dan mengulang tes.
- Tes Postgres (`TEST_DATABASE_URL`) belum dijalankan terhadap server Postgres nyata.
- Docker tidak tersedia di lingkungan audit, sehingga image build dan `docker compose up` belum diuji.
- Belum ada tes live ke API provider asli; model ID, harga, streaming, tool calls, kuota, dan ketentuan komersial tiap provider harus diuji satu per satu.

## Catatan penting tentang batas biaya

Reservasi anggaran atomik mencegah request bersamaan menggunakan estimasi biaya yang sama dua kali, tetapi estimasi token bukan hard cap tagihan provider. Jika provider melaporkan pemakaian aktual lebih besar daripada reservasi, gateway mencatat `budget_estimate_overrun`; pemakaian aktual dapat melampaui batas sebelum request berikutnya ditolak. Untuk hard cap finansial, aktifkan spending limit/billing alert di provider juga dan pantau log overrun.

## Lisensi dan syarat layanan

Kode FreeFirst Router tetap MIT. Perubahan ini tidak menyalin kode sumber proyek router lain. Provider API mempunyai syarat layanan, aturan data, batas free tier, dan ketentuan komersial masing-masing; lisensi MIT aplikasi tidak memberi izin untuk menjual ulang akses provider. Verifikasi syarat setiap provider sebelum layanan multi-user dibuka ke publik.
