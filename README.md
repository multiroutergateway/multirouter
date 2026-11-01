# FreeFirst AI

Multi-user AI workspace built on **FreeFirst Router v3.2**. Free models are tried first; paid
models are only reached when the routing policy and budget allow it.

> **Status:** working development build. Backend, frontend, PWA and router pass their automated
> suites in this workspace. Live provider calls, container builds, native desktop installers and
> any deployment are **not** verified here — see
> [docs/WORKBUDDY-EXECUTION-REPORT.md](docs/WORKBUDDY-EXECUTION-REPORT.md) for the exact list.

---

## What it does

| Capability | Status |
|---|---|
| Email + password auth, JWT with server-side session revocation | Implemented, tested |
| Conversation history (create, rename, delete, export) with per-user ownership | Implemented, tested |
| Streaming chat (SSE) with stop, retry, regenerate | Implemented |
| Safe Markdown rendering (no raw HTML) + code blocks with copy | Implemented |
| Model picker (auto / fast / smart / heavy + admin-only routes) | Implemented |
| Usage & budget panel (tokens, estimated cost, route breakdown) | Implemented |
| Admin gateway panel (router stats, discovery, radar) | Implemented |
| PWA (manifest, service worker, offline shell, update strategy) | Implemented |
| Tauri 2 desktop shell for Windows/macOS/Linux | Configured, **not built** (no Rust toolchain here) |
| Free-first routing, pricing gate, per-user budget | From router v3.2, tested |

---

## Architecture

```
Browser / PWA / Tauri
        │  HTTPS, JWT bearer
        ▼
  ┌───────────────┐        ┌────────────────────┐        ┌─────────────────────┐
  │ apps/frontend │  /api  │  apps/backend      │  HTTP  │ services/router     │
  │ React + Vite  │───────▶│  Express + pg      │───────▶│ FreeFirst v3.2      │
  └───────────────┘        │  sessions, history │  key   │ free-first routing  │
                           └─────────┬──────────┘        └──────────┬──────────┘
                                     │                              │
                              ┌──────▼──────┐                ┌──────▼──────┐
                              │ app-db      │                │ router-db   │
                              │ PostgreSQL  │                │ PostgreSQL  │
                              └─────────────┘                └─────────────┘
```

The browser never receives a provider API key, the router admin key, or the router client key.
All model traffic goes through the backend, which attaches `X-User-ID` so the router can enforce
per-user rate limits and budgets.

---

## Quick start (local)

```bash
git clone <your-repo> freefirst-ai && cd freefirst-ai
cp .env.example .env          # then edit every CHANGE_ME value
npm install
```

You need PostgreSQL 16+ for the app database (the router can share the same server with a
separate database).

```bash
# 1. App database + schema (.env is read automatically)
npm run migrate

# 2. Router (terminal 1) — needs provider keys to serve models
set -a; source .env; set +a     # the router reads its config from the environment
npm run dev:router

# 3. Backend API (terminal 2)
npm run dev:backend

# 4. Web app (terminal 3)
npm run dev:frontend        # http://localhost:5173
```

The Vite dev server proxies `/api` to `http://localhost:3001`, so no CORS setup is needed.

### Docker (dev/staging)

```bash
cp .env.example .env        # fill in secrets
docker compose up --build
# web: http://localhost:5173 · api: http://localhost:3001 (both bound to 127.0.0.1)
```

### Production

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Caddy terminates TLS automatically; only ports 80/443 are published. See
[docs/INSTALL.md](docs/INSTALL.md).

---

## Repository layout

```
apps/
  backend/    Express API — auth, sessions, conversations, chat proxy, usage, admin
  frontend/   React 18 + Vite 6 — chat UI, PWA, settings
  desktop/    Tauri 2 shell (Rust) around the built frontend
services/
  router/     FreeFirst Router v3.2 (canonical baseline, unmodified behaviour)
deploy/       Caddyfile for production TLS
docs/         architecture, install, API, security, ops runbooks, execution report
legacy/       older router archives kept for comparison only
```

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev:router` | Start the router |
| `npm run dev:backend` | Start the API with watch mode |
| `npm run dev:frontend` | Start Vite dev server |
| `npm run migrate` | Apply database migrations |
| `npm run check` | Parse-check every backend, router, Pages Function and script file (37 files) |
| `npm run check:compose` | 139 structural Docker/compose checks — no daemon required |
| `npm test` | Backend + frontend + router suites |
| `npm run test:backend` | 41 API/auth/conversation/chat/security tests |
| `npm run test:frontend` | 9 frontend unit tests (formatting, markdown, safeHref) |
| `npm run test:router` | 5 router suites (discovery, anthropic, store, smoke, SSRF) |
| `npm run test:e2e` | 11 end-to-end tests (needs `E2E_PG_URL` for the 4 pgstore ones) |
| `npm run test:integration` | 6 DB-level tests (needs `TEST_DATABASE_URL`) |
| `npm run build` | Production build of the web app |

### Local PostgreSQL without Docker

`scripts/dev-postgres.mjs` runs a real PostgreSQL server from project-local binaries
(`npm install --no-save embedded-postgres`), bound to `127.0.0.1:55432`, data in `.pgdata/`:

```bash
node scripts/dev-postgres.mjs start | status | stop | reset | version
PG_PORT=55433 PG_DATA=/tmp/pg17-data PG_BIN=… node scripts/dev-postgres.mjs start   # second cluster
```

### Container builds

All three images build from the **repository root**, because the root `package-lock.json` is the only
lockfile for this workspace tree. `docker build ./apps/backend` will not work.

```bash
docker build -f apps/backend/Dockerfile  -t freefirst/backend  .
docker build -f apps/frontend/Dockerfile -t freefirst/frontend .
docker build -f services/router/Dockerfile -t freefirst/router .
```

`docker compose` handles this automatically. Details and the reasons:
[docs/DOCKER-BUILD-REPRODUCIBILITY-REPORT.md](docs/DOCKER-BUILD-REPRODUCIBILITY-REPORT.md).

---

## Security model (short version)

- Passwords hashed with bcrypt (cost 12, configurable).
- JWT (HS256, issuer/audience checked) **plus** a `sessions` row; logout revokes server-side.
- Every conversation/message query filters by `user_id`; cross-user access returns 404.
- Rate limits per user (chat) and per IP (auth).
- Zod validation on all bodies; 256 kB JSON cap; message/char caps.
- Markdown is rendered to React elements — model output cannot inject HTML or scripts.
- The frontend stores only the session token; provider keys live in the router's environment.

Full checklist and residual risks: [docs/SECURITY.md](docs/SECURITY.md).

---

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Install & deploy](docs/INSTALL.md)
- [API reference](docs/API.md)
- [Security](docs/SECURITY.md)
- [Backup & restore](docs/BACKUP.md)
- [Monitoring](docs/MONITORING.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Development guide](docs/DEVELOPMENT.md)
- [Execution report (what was actually verified)](docs/WORKBUDDY-EXECUTION-REPORT.md)

## License

Router source is MIT (see `services/router/LICENSE` if present). The rest of this workspace is
provided under the same MIT terms. Provider terms of service still apply to any model traffic.
