# Cloudflare Pages + Tencent Lighthouse — Domainless Staging

Deployment guide for running FreeFirst AI **without buying a domain**: the web app is
served from Cloudflare Pages (`*.pages.dev`), the API lives on a Tencent Cloud
Lighthouse VPS, and a Pages Function bridges the two on the same origin.

> Scope: this is a **temporary staging architecture**. It is not a production
> topology. Nothing in this document has been executed against real Cloudflare or
> Tencent infrastructure yet — see
> [CLOUDFLARE-PAGES-IMPLEMENTATION-REPORT.md](CLOUDFLARE-PAGES-IMPLEMENTATION-REPORT.md)
> for the exact verification status.

---

## 1. Why this shape

| Constraint | Consequence |
| --- | --- |
| No purchased domain | The public entry point is `https://freefirst-ai.pages.dev`, a hostname Cloudflare owns. |
| No public production exposure | The VPS API is never published on a public port. It is reachable only through an encrypted tunnel. |
| Frontend must stay same-origin | The browser only talks to the Pages host; every `/api/*` call is proxied server-side. |
| No backend secrets in the browser | `BACKEND_ORIGIN` is a Pages environment secret, read only inside the Function. |
| Existing code must keep working | Paths are forwarded verbatim; auth, SSE, PWA and CSP behaviour are unchanged. |

```
                    https://freefirst-ai.pages.dev
   Browser  ─────────────────────────────────────────────┐
     │  GET /                    → static asset (dist)    │
     │  GET /settings            → SPA fallback           │
     │  GET /api/* , POST /api/* → Pages Function         │
     │  POST /api/chat (SSE)     → Pages Function (stream)│
                                                          ▼
                                        functions/api/[[path]].js
                                        reads BACKEND_ORIGIN (secret)
                                                          │
                                        HTTPS (encrypted, no public port)
                                                          ▼
                              https://<random>.trycloudflare.com
                                        cloudflared on the VPS
                                                          │
                                                          ▼
                              Tencent Lighthouse · 127.0.0.1:3001
                              backend + router + PostgreSQL (docker compose)
```

Two hops, one browser origin. The browser never learns the VPS address, the tunnel
hostname, or any credential.

---

## 2. What the repository already provides

| File | Role |
| --- | --- |
| `functions/api/[[path]].js` | Same-origin API proxy (Pages Function, ESM). |
| `apps/frontend/public/_routes.json` | Restricts Function invocation to `/api` and `/api/*`. Copied into `dist/` by Vite. |
| `apps/frontend/public/_redirects` | SPA fallback `/* → /index.html 200`, mirroring the nginx rule. |
| `apps/frontend/public/_headers` | CSP and security headers, mirroring `deploy/nginx-freefirst.conf`. |
| `wrangler.toml` | Project name, `pages_build_output_dir`, compatibility date. **No secrets.** |
| `scripts/cloudflare-pages-verify.mjs` | 106 local assertions over build, routing, proxy, SSE, CSP and secret hygiene. |
| `apps/backend/src/app.js` | Adds `/api/health` alongside the existing `/health` and `/ready`. |

The frontend needed almost nothing: `apps/frontend/src/lib/api.js` already builds
every URL from an empty base, so all requests are relative (`/api/...`). The only
change was pointing the health probe at `/api/health`, because a `/api/*`-only
proxy cannot route a bare `/health`.

---

## 3. Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js ≥ 22 | `node --version` |
| Cloudflare account (free plan) | Needed to own the `pages.dev` project. |
| `wrangler` CLI | `npx wrangler@latest --version` (no global install required). |
| Tencent Cloud Lighthouse 2 vCPU / 2 GB | See [TENCENT-LIGHTHOUSE-DEPLOYMENT.md](TENCENT-LIGHTHOUSE-DEPLOYMENT.md). |
| `cloudflared` on the VPS | Installed in step 6. |

No domain, no DNS zone, and no paid Cloudflare feature is required.

---

## 4. Step 1 — Build the frontend

From the repository root:

```bash
npm ci
npm run build
```

Output goes to `apps/frontend/dist` and must contain:

```
dist/index.html
dist/assets/index-<hash>.js
dist/assets/index-<hash>.css
dist/manifest.webmanifest
dist/sw.js
dist/icons/...
dist/_routes.json
dist/_redirects
dist/_headers
```

The three `_*` files are the entire Cloudflare routing contract. If they are
missing from `dist`, the deployment will silently lose SPA routing, CSP, or
Function scoping — `npm run verify:pages` fails in that case.

Verify locally before deploying:

```bash
npm run verify:pages      # exits 0 only when all 106 assertions pass
```

---

## 5. Step 2 — Create the Pages project (Direct Upload)

The project uses **Direct Upload**, not Git integration: there is no repository
connection, so no build runs on Cloudflare and no build-time secret is needed.

Dashboard route:

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Upload assets**.
2. Project name: `freefirst-ai` (this fixes the hostname `freefirst-ai.pages.dev`).
3. Upload the contents of `apps/frontend/dist` (or use Wrangler in step 4).
4. Note the assigned URL: `https://freefirst-ai.pages.dev`.

CLI route (equivalent, and what the rest of this document assumes):

```bash
npx wrangler login                     # one-time browser auth
npx wrangler pages project create freefirst-ai --production-branch main
```

`wrangler.toml` already declares `name = "freefirst-ai"` and
`pages_build_output_dir = "apps/frontend/dist"`, so later deploys need no flags.

---

## 6. Step 3 — Configure `BACKEND_ORIGIN`

`BACKEND_ORIGIN` is the **only** server-side binding the proxy needs. It is an
encrypted Pages secret, never a build-time variable, and never part of the bundle.

```bash
npx wrangler pages secret put BACKEND_ORIGIN --project-name freefirst-ai
# paste: https://<your-tunnel-hostname>   (must be https, no trailing slash)
```

Rules enforced by the Function:

| Value | Result |
| --- | --- |
| `https://abc.trycloudflare.com` | Accepted. |
| `http://203.0.113.10:3001` | **Rejected** (`backend_origin_insecure`, HTTP 500) — plaintext auth traffic is never allowed. |
| `http://127.0.0.1:3001` | Accepted **only** for loopback development. |
| missing / empty | `backend_origin_not_configured`, HTTP 500. |
| not a URL | `backend_origin_invalid`, HTTP 500. |

**Secrets are applied per deployment.** After changing `BACKEND_ORIGIN` you must
redeploy (step 4) for the new value to take effect in production traffic.

Optional diagnostic (off by default):

```bash
npx wrangler pages secret put PROXY_LOG --project-name freefirst-ai   # value: 1
```

When `PROXY_LOG=1`, the Function logs `{method, pathname, status}` only. Query
strings, headers, cookies, bodies and tokens are never logged.

---

## 7. Step 4 — Deploy

```bash
npm run build
npx wrangler pages deploy            # uses wrangler.toml
```

Wrangler prints the deployment URL and the permanent alias:

```
✨ Deployment complete! Take a peek over at https://<hash>.freefirst-ai.pages.dev
✨ Deployment alias: https://freefirst-ai.pages.dev
```

Exit code `0` means Cloudflare accepted the upload. It does **not** mean the API
works — that depends on the tunnel in step 6.

Smoke test from any machine:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://freefirst-ai.pages.dev/          # 200
curl -sS -o /dev/null -w '%{http_code}\n' https://freefirst-ai.pages.dev/settings  # 200 (SPA)
curl -sS https://freefirst-ai.pages.dev/api/health                                 # {"status":"ok",...}
curl -sS -D- -o /dev/null https://freefirst-ai.pages.dev/ | grep -i content-security-policy
```

The last command must show the CSP from `_headers`. If it is missing, `_headers`
did not reach `dist`.

---

## 8. Step 5 — Prepare the Tencent Lighthouse origin

Follow [TENCENT-LIGHTHOUSE-DEPLOYMENT.md](TENCENT-LIGHTHOUSE-DEPLOYMENT.md) for
sizing and compose details. The parts that matter for this architecture:

1. **Do not publish 3001 or 5432 to the internet.** The compose file already binds
   the API to `127.0.0.1:3001` and keeps PostgreSQL on the internal network.
2. **Firewall**: allow inbound `22` (your IP only) and `443`/`80` only if you
   later add a custom domain. Nothing else. The tunnel is *outbound*; no inbound
   port is needed for the API.
3. **Bring the stack up**:

   ```bash
   cd /opt/freefirst-ai
   docker compose -f docker-compose.yml -f deploy/docker-compose.lighthouse.yml up -d
   curl -sS http://127.0.0.1:3001/health   # {"status":"ok","service":"freefirst-backend"}
   curl -sS http://127.0.0.1:3001/ready    # {"status":"ready"}
   ```

4. **Verify the SPA-facing alias exists**:

   ```bash
   curl -sS http://127.0.0.1:3001/api/health   # {"status":"ok",...}
   ```

If `/ready` returns 503, PostgreSQL is not reachable — fix that before tunnelling.

---

## 9. Step 6 — Expose the origin (staging only)

### Option A — Quick Tunnel (temporary, zero configuration)

On the VPS:

```bash
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared

cloudflared tunnel --url http://127.0.0.1:3001 --no-autoupdate
```

The process prints a URL such as:

```
https://random-words-1234.trycloudflare.com
```

Then:

```bash
npx wrangler pages secret put BACKEND_ORIGIN --project-name freefirst-ai
# https://random-words-1234.trycloudflare.com
npx wrangler pages deploy
```

Characteristics you must accept:

| Property | Behaviour |
| --- | --- |
| Hostname | Random, **changes on every restart**. |
| Account | None required. |
| Lifetime | Dies with the process; no uptime guarantee. |
| TLS | Terminated by Cloudflare — the hop is encrypted. |
| Suitability | Staging demos only. Never treat it as production infrastructure. |

Because the hostname rotates, every `cloudflared` restart means: update the
secret, redeploy, done. If that churn is unacceptable, use Option B.

### Option B — Permanent origin (later)

Once a domain is available: point `api.example.com` at the VPS, terminate TLS with
Caddy (already in the compose file), open `443` in the Lighthouse firewall, and set
`BACKEND_ORIGIN=https://api.example.com`. No code change is needed — the proxy
only cares that the origin is `https`.

---

## 10. Security model

| Property | How it holds |
| --- | --- |
| Secrets never reach the browser | `BACKEND_ORIGIN` exists only in `env` inside the Function; the bundle is scanned for it (`verify:pages`). |
| No auth bypass | The proxy is a dumb forwarder: it never adds, rewrites or removes `Authorization`. The backend still validates every JWT. |
| `X-User-ID` never trusted from a browser | The proxy **strips** `x-user-id`, `x-userid`, `x-user`, `x-forwarded-user`, `x-auth-user`, `x-role`, `x-admin` on the way in. Identity comes from the session only. |
| Router internals stay internal | `services/router` trusts `x-user-id` and guards `/admin/*` with `x-admin-key`. It is never published; only the backend reaches it, server-to-server. |
| Admin authorisation | Enforced by backend middleware (`401` unauthenticated, `403` non-admin), verified by Stage 11 F9–F11. |
| CORS not weakened | The proxy adds **no** `Access-Control-*` header. Same-origin needs none. Backend CORS config is untouched. |
| No API caching | Every proxied response gets `cache-control: no-store` and `cdn-cache-control: no-store`. |
| SSE works | Upstream `ReadableStream` is passed through untouched; no `await response.text()`, no buffering. Client disconnect aborts the upstream request. |
| CSP preserved | `_headers` ships the same policy the container edge used; `connect-src 'self'` is exactly what same-origin `/api` needs. |
| Hop-by-hop hygiene | `connection`, `keep-alive`, `te`, `trailer`, `transfer-encoding`, `upgrade`, `proxy-*` are stripped both ways (RFC 9110 §7.6.1). |
| No secret logging | Zero logs by default; `PROXY_LOG=1` logs method, path and status only. |

One residual risk worth stating plainly: **the tunnel hostname is a secret in
practice.** Anyone who learns `https://<random>.trycloudflare.com` can reach the
API directly, bypassing Cloudflare Pages. The API is still protected by JWT and
admin checks, but it becomes directly reachable. Rotate the tunnel (restart it) if
the URL leaks, and do not paste it into public channels.

---

## 11. SSE through the proxy

Chat completions are `POST /api/chat` with `stream: true`. The chain is
browser → Pages Function → tunnel → backend.

What the proxy guarantees:

- the response body is never read into memory, so tokens arrive as produced;
- `content-type: text/event-stream` and the router metadata headers
  (`x-router-route`, `x-router-tier`, `x-conversation-id`) pass through;
- `accept-encoding` is dropped on the way in, so the origin returns an
  uncompressed stream and no proxy layer can decide to buffer a compressed body;
- a client abort propagates: the Function's `request.signal` aborts the upstream
  fetch, so the backend stops generating instead of streaming into a void;
- the proxy allows up to **300 s** for `/api/chat` and **30 s** for everything else.

Measured locally: 5 SSE frames, first frame at ~64 ms of a ~231 ms stream
(incremental, not buffered), and the origin observed the disconnect within 250 ms
of a client abort.

Known unknown, to be measured on real infrastructure: very long generations
(>100 s) may be cut by Cloudflare platform limits. If you see truncation, cap the
model's `max_tokens` or move the origin to a custom domain. This is explicitly
**not** verified — see the implementation report.

---

## 12. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `/api/*` returns 500 `backend_origin_not_configured` | Secret not set, or set after the last deploy | `wrangler pages secret put BACKEND_ORIGIN`, then redeploy. |
| `/api/*` returns 500 `backend_origin_insecure` | Origin is `http://` | Use the tunnel's `https://` URL. |
| `/api/*` returns 502 `backend_unreachable` | `cloudflared` is down, or backend is not listening on 3001 | Restart the tunnel; `curl 127.0.0.1:3001/health` on the VPS. |
| `/api/*` returns 504 `backend_timeout` | Origin accepted the connection but never answered | Check backend logs and PostgreSQL. |
| Deep link 404 on refresh | `_redirects` missing from `dist` | Rebuild; confirm `dist/_redirects`. |
| Browser blocks API calls with a CSP error | `connect-src` no longer `'self'`, or an absolute API base was configured | Clear `ff_api_base` in localStorage; redeploy `_headers`. |
| Login works but the app shows stale data | Service worker cached the old shell | Bump the cache name in `public/sw.js`, redeploy. |
| Everything 404s except `/` | `_routes.json` was widened to `/*` | Restore `include: ["/api", "/api/*"]`. |

---

## 13. Rollback

| Situation | Action |
| --- | --- |
| Bad frontend deploy | `npx wrangler pages deployment list --project-name freefirst-ai`, then roll back to the previous deployment in the dashboard (Deployments → ⋯ → Rollback). |
| Proxy misconfigured | Revert `functions/api/[[path]].js` and redeploy. Static assets keep working; only `/api/*` is affected. |
| Tunnel hostname changed | Update the secret, redeploy. No rebuild needed. |
| Take staging offline entirely | Delete the Pages project (removes `*.pages.dev`) and stop `cloudflared` on the VPS. |

Rolling back Pages never touches the database: PostgreSQL lives on the VPS and is
unaffected by frontend deployments.

---

## 14. Migrating to a custom domain later

1. Add the domain to Cloudflare (nameservers or a CNAME).
2. Pages → project → **Custom domains** → add `app.example.com`; Cloudflare issues
   the certificate automatically.
3. Point `api.example.com` at the VPS and terminate TLS with Caddy.
4. `wrangler pages secret put BACKEND_ORIGIN` → `https://api.example.com`, redeploy.
5. Delete the tunnel.
6. Optional cleanup: once the API host is stable, you may bypass the Function
   entirely by serving the SPA and API from the same Caddy origin, as in
   [DEPLOYMENT.md](DEPLOYMENT.md).

Nothing in the application code changes: the frontend still calls relative
`/api/*` paths, and the backend still serves the same routes.

---

## 15. What this document does not claim

- Cloudflare Pages has **not** been deployed or contacted.
- The Tencent Lighthouse origin has **not** been reached from Cloudflare.
- Quick Tunnel behaviour is documented from its specification, not measured here.
- No production readiness is implied.

The verification that *was* performed is entirely local and reproducible:
`npm run verify:pages` (106 assertions, exit 0).
