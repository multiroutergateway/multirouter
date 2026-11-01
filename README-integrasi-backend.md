# Contoh integrasi backend: Express & Next.js

Alur: **mobile/web → backend-mu (login user) → FreeFirst Router → provider AI**.
Browser dan mobile app tidak pernah memegang key gateway. Hanya backend yang memanggil gateway.

```
examples/
  shared/gateway.js     klien gateway (X-Task, X-Project, X-Sensitive), sanitasi pesan, penerjemah error
  shared/limit.js       pembatas per user (di memori)
  shared/demo-auth.js   auth CONTOH, ganti dengan JWT/sesi milikmu
  express/server.js     3 endpoint contoh
  nextjs/               route handler App Router (.js; ganti ke .ts bila perlu)
```

## Variabel lingkungan di backend

```
AI_GATEWAY_URL=http://<nama-service>.railway.internal:20128   # atau http://127.0.0.1:20128 saat lokal
AI_GATEWAY_KEY=<salah satu nilai di CLIENT_KEYS gateway, mis. key milik "web">
AI_PROJECT=digium            # harus ada di "projects" pada router.config.json (anggaran per proyek)
```

## Siapa yang menentukan apa

| Hal | Ditentukan oleh | Alasan |
|---|---|---|
| `X-Task` (fast/smart/heavy) | **Backend**, per endpoint | Kalau dari client, user bisa memaksa model mahal |
| `X-Project` | Backend (env) | Anggaran harian per aplikasi/proyek |
| `X-Sensitive` | Backend, per endpoint | Endpoint yang menangani data pribadi tidak boleh lewat free tier |
| `model` | Selalu `"auto"` | Field `model` dari client diabaikan |
| System prompt | Backend | Client hanya boleh mengirim pesan `user`/`assistant` |
| `max_tokens` | Backend | Batas biaya per request |

Contoh pemetaan di kode: `/api/chat` → `fast` (gratis dulu), `/api/analyze` → `heavy` (premium), `/api/private-summary` → `smart` + `sensitive`.

Catatan: kalau key yang dipakai (mis. milik client `mobile`) tidak berhak atas `auto-heavy`, gateway **menurunkan** ke `auto-smart`, bukan menolak.

## Jalankan

```bash
# Express
cd examples/express && npm install
AI_GATEWAY_URL=http://127.0.0.1:20128 AI_GATEWAY_KEY=kunci-web AI_PROJECT=digium node server.js

curl -s localhost:3000/api/chat -H "authorization: Bearer demo-user1" -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"Halo!"}]}'
```

Next.js: salin `shared/` dan `nextjs/lib` + `nextjs/app/api` ke proyekmu (sesuaikan path import `../../shared/...`), lalu isi env di atas.
Tambahkan `"stream": true` pada body untuk respons streaming (SSE diteruskan apa adanya).

## Dari mobile app (memanggil backend, bukan gateway)

Flutter:
```dart
final res = await http.post(Uri.parse('$apiBase/api/chat'),
  headers: {'content-type': 'application/json', 'authorization': 'Bearer $userToken'},
  body: jsonEncode({'messages': [{'role': 'user', 'content': text}]}));
final reply = jsonDecode(utf8.decode(res.bodyBytes))['reply'];
```

React Native:
```js
const res = await fetch(`${API_BASE}/api/chat`, { method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${userToken}` },
  body: JSON.stringify({ messages: [{ role: "user", content: text }] }) });
const { reply, error } = await res.json();   // 503 = AI sibuk: tampilkan pesan & izinkan coba lagi
```

## Sebelum dipakai sungguhan

- Ganti `demo-auth.js` dengan verifikasi JWT/sesi asli. **Contoh auth ini tidak aman.**
- Pembatas per user ada di memori; dengan beberapa instance backend pindahkan ke Redis.
- Kirim riwayat percakapan seperlunya (batas 30 pesan / 20.000 karakter di `shared/gateway.js`); sesuaikan.
- Respons 503 berarti semua route sibuk atau budget habis; tampilkan pesan ramah dan jangan coba ulang berkali-kali otomatis.
- Properti `route` di respons hanya muncul di non-produksi (untuk debugging).
- Tes: `npm run test:examples` (setelah `npm --prefix examples/express install`).
