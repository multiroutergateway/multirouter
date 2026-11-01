# FreeFirst AI — WorkBuddy Execution Report

**Version:** 0.2.0
**Workspace:** `freefirst-ai/`
**Report date:** 2026-10-30
**Stage:** 9 — Production Readiness

**Status:** production-ready codebase. All automated tests pass on both `pg-mem` **and** real
PostgreSQL 18.4, security hardening completed with CSP enforcement and new regression tests,
deployment package prepared (Docker Compose, Nginx, Caddy, backup/restore/monitor scripts,
Ubuntu 24.04 guide, rollback procedure), and provider verification procedure documented.

**Not** verified: Docker image builds and `docker compose config` (no Docker CLI on this machine),
`pg_dump`/`pg_restore` (no client tools), live provider calls (no keys, awaiting approval), native
desktop installers (no Rust toolchain), any deployment.

This report is deliberately conservative. Everything in §3–§5 was actually executed in this
workspace; everything else is explicitly marked unverified. Where a requirement could not be
satisfied because the toolchain was unavailable, the blocker is named rather than papered over with
a mock.

---

## 1. Features that are actually finished

### 1.1 Backend API (`apps/backend`)

| Capability | State | Notes |
|---|---|---|
| Email + password registration | Done | bcrypt (cost configurable, default 12), Zod validation, duplicate-email 409 |
| Login | Done | Constant-time-ish comparison via dummy hash on unknown email to reduce user enumeration timing signal |
| JWT access tokens | Done | HS256, issuer/audience pinned, `jti` claim, TTL from `JWT_TTL` |
| Server-side session records | Done | `sessions` table; every authenticated request checks the session is still active, not just the signature |
| Logout (single session) | Done | Revokes the current `jti` |
| Logout everywhere | Done | Revokes all sessions for the user |
| Session listing | Done | `GET /api/auth/sessions` |
| Session pruning | Done | Hourly interval in `server.js` + `pruneExpiredSessions()` |
| Auth middleware | Done | `makeRequireAuth(pool)` — token verify → session check → `req.user` |
| Roles | Done | `user` / `admin`; first admin assigned by `ADMIN_EMAILS` allowlist at registration, promotable via admin API; DB-level `CHECK (role IN ('user','admin'))` added in migration 004 |
| Input validation | Done | Zod schemas on every mutating endpoint; 400 with field-level `details` |
| Rate limiting | Done | Separate buckets for auth and chat, keyed per user (falls back to IP), `trustProxy: false` |
| PostgreSQL persistence | **Verified** | `pg` Pool, migrations 001–005 applied to PostgreSQL 18.4 and inspected |
| Migrations | Done | `schema_migrations` ledger + `pg_advisory_lock(918273645)`; forward-only; idempotent (re-run prints `migrations up to date`); needs only `DATABASE_URL` |
| Conversations API | Done | list / create / get / rename / delete / export |
| Messages API | Done | `GET /api/conversations/:id/messages` |
| Models API | Done | Product-facing aliases; discovered provider route IDs only exposed to admins |
| Usage API | Done | Totals, 14-day buckets, per-route breakdown, active limits |
| Chat API with SSE streaming | Done | Frame-parsed proxy of the gateway stream |
| Duplicate-request rejection | Done | `chat_requests` table, PK on `request_id`; a repeat is `409 duplicate_request` regardless of latency |
| Admin API | Done | Status, gateway stats, discovered routes, radar, discovery trigger, user list, role change |
| Error handling | Done | `HttpError`, `asyncHandler`, central `errorHandler`, no stack traces in responses |
| Structured logging | Done | Single-line JSON with case/separator-insensitive key redaction (see §2.8 #11) |
| Health / readiness | Done | `/health`, `/ready` (the latter does `SELECT 1`) |

**Ownership enforcement:** every conversation, message, usage and export query filters on `user_id` from the verified token. There is no endpoint that accepts a user id from the client as an authority.

### 1.2 Frontend (`apps/frontend`)

| Capability | State | Notes |
|---|---|---|
| Login / registration screen | Done | Wired to the real API, inline error surfacing |
| Session bootstrap | Done | `GET /api/auth/me` on load; 401 → auth screen |
| Dashboard / workspace shell | Done | Sidebar + topbar + chat |
| Conversation history sidebar | Done | Server-backed list, search filter, relative timestamps |
| Create / rename / delete conversation | Done | Rename and delete are optimistic with rollback on failure |
| Model selector | Done | Searchable dropdown, selection persisted in `localStorage` (`ff_model`) |
| Streaming responses | Done | `fetch` + `ReadableStream` SSE parser, incremental render |
| Stop generation | Done | `AbortController`; backend persists the partial message with `finish_reason = 'aborted'` |
| Retry on error | Done | Error card with retry; reuses the original `requestId` so a retry after a timeout cannot double-charge |
| Duplicate-send recovery | Done | `409 duplicate_request` reopens the conversation instead of showing an error |
| Safe Markdown rendering | Done | Custom renderer producing React elements — no `dangerouslySetInnerHTML`, no `marked`, no `DOMPurify` dependency |
| Link sanitisation | Done | `src/lib/safeHref.js`: `http(s)://` and `/` only; protocol-relative `//host` rejected |
| Code blocks + copy | Done | Fenced blocks with language label and clipboard button |
| Usage / budget panel | Done | Stat cards, 14-day bar chart, per-route table, server-side limits echoed |
| Settings | Done | Tabs: appearance, usage, connection, account, admin |
| Backend URL configuration | Done | `ff_api_base` in `localStorage`, save / test / reset; required for desktop and self-hosted PWA |
| Dark / light mode | Done | CSS variables, persisted in `ff_theme`, updates `<meta name="theme-color">` |
| Responsive layout | Done | Breakpoints at 1100 / 900 / 640 px; collapsible sidebar drawer on mobile; `prefers-reduced-motion` honoured |
| Admin panel | Done | Gateway status, stats, provider/route table, discovery trigger, radar |
| Toasts | Done | Single-toast queue with auto-dismiss |

### 1.3 PWA

| Item | State |
|---|---|
| `manifest.webmanifest` | Done — name, short name, `display: standalone`, theme/background colour, 192 + 512 icons, `start_url` |
| Icons | Done — `icons/icon-192.png`, `icons/icon-512.png` |
| Service worker | Done — `public/sw.js`, cache name `freefirst-shell-v2` |
| Caching strategy | Network-first for navigations, cache-first for static assets, **`/api/` never cached**, offline shell fallback |
| Update strategy | `SKIP_WAITING` message handler + `clients.claim()`; registration only in production builds |
| Private data in cache | Not cached — chat responses are fetched from the network only |

### 1.4 Desktop (Tauri 2)

| Item | State |
|---|---|
| Project scaffold | Done — `apps/desktop/src-tauri/` with `Cargo.toml`, `build.rs`, `main.rs`, `tauri.conf.json` |
| Window config | Done — 1280×820, min 760×560 |
| CSP | Done — see §7.1 for the deliberate `https:` allowance |
| Bundle targets declared | Done — `msi`, `dmg`, `appimage`, `deb`, `rpm` |
| Icons for all platforms | Done — `.ico`, `.icns`, PNG set |
| Backend URL configuration | Done via the in-app Settings → Connection tab |
| **Actual installer built** | **No** — no Rust/cargo toolchain in this environment. See §6. |

### 1.5 Router (`services/router`)

The v3.2 router is carried over **unmodified** as the security and routing baseline. No source file in `services/router/src` was edited. The only changes are `package.json` (test script), a new cross-platform test runner `test/run.mjs`, a `HEALTHCHECK` in its Dockerfile, and a test-only config `router.e2e.config.json`.

Verified behaviour by its own suites: fail-closed discovery, pricing verification, atomic budget reserve/settle, per-provider cooldown for shared quotas, `X-Sensitive` privacy gating, MemoryStore and PgStore parity.

Additionally verified against a real PostgreSQL server this stage: the router's own `schema.sql` applies, reservation is atomic under concurrency, cooldowns persist and expire, and route usage accumulates per day and per route (§3.4).

### 1.6 Infrastructure and tooling

| Item | State |
|---|---|
| `docker-compose.yml` (dev) | Done — postgres ×2, router, backend, frontend; only frontend bound to `127.0.0.1`; validated structurally (60 assertions) |
| `docker-compose.prod.yml` | Done — no host ports on backend/router, Caddy on 80/443, memory limits, log rotation; validated structurally |
| `deploy/Caddyfile` | Done — `{$DOMAIN}` auto-TLS, `flush_interval -1` on `/api/*` so SSE is not buffered |
| Backend `Dockerfile` | Done — node:22-alpine, `npm ci --omit=dev`, non-root `USER node`, healthcheck, `migrate-then-serve` via `exec` so signals reach node |
| Frontend `Dockerfile` + `nginx.conf` | Done — multi-stage build, `proxy_buffering off` for SSE, security headers |
| `.dockerignore` | Done — both apps; excludes `node_modules`, `.env`, `test`, build output |
| `.env.example` | Done — every variable documented, `CHANGE_ME` placeholders |
| `.gitignore` | Done — `.env`, keys, `node_modules`, `dist`, `target` |
| CI (`.github/workflows/ci.yml`) | Done — backend tests, frontend test + build (+ artifact upload), router tests with env, `docker compose config`, docker build |
| PostgreSQL for development | Done — real 18.4 server, migrations applied, schema inspected |
| Backup/restore rehearsal | Done — `scripts/backup-restore-drill.mjs`, content-hash compared |

---

## 2. Files created or changed

### 2.1 Backend — new

```
apps/backend/src/config.js              central env config, fails fast on weak JWT_SECRET
apps/backend/src/loadEnv.js             zero-dependency .env loader (env vars always win)
apps/backend/src/logger.js              JSON logger with redaction
apps/backend/src/middleware.js          HttpError, asyncHandler, requireAuth, requireAdmin,
                                        limiters, validate(), notFound, errorHandler
apps/backend/src/gateway.js             gateway client: chatCompletion, listGatewayModels,
                                        admin stats/discovered/radar/discover
apps/backend/src/routes/auth.js         register, login, me, logout, logout-all, sessions
apps/backend/src/routes/conversations.js list, create, get, messages, rename, delete, export
apps/backend/src/routes/chat.js         SSE streaming chat + persistence + in-flight lock
apps/backend/src/routes/models.js       product model aliases
apps/backend/src/routes/usage.js        usage aggregation
apps/backend/src/routes/admin.js        admin status, gateway, users
apps/backend/src/app.js                 createApp({ pool }) factory
apps/backend/migrations/002_sessions_roles.sql
apps/backend/migrations/003_usage_indexes.sql
apps/backend/migrations/004_integrity_cleanup.sql    (stage 8)
apps/backend/migrations/005_chat_requests.sql        (stage 8)
apps/backend/test/env.js                test environment variables (BCRYPT_ROUNDS=4)
apps/backend/test/helpers.js            makeTestApp (pg-mem or real PG), jsonRequest,
                                        registerUser, installFakeGateway, sseResponse
apps/backend/test/auth.test.js
apps/backend/test/chat.test.js
apps/backend/test/conversations.test.js
apps/backend/test/ratelimit.test.js
apps/backend/test/validation.test.js
apps/backend/test/env-loader.test.js
apps/backend/test/security.test.js                     (stage 8)
apps/backend/test/e2e/fake-provider.mjs                (stage 8)
apps/backend/test/e2e/router.test.js                   (stage 8)
apps/backend/test/e2e/pgstore.test.js                  (stage 8)
apps/backend/test/e2e/run.mjs                          (stage 8)
apps/backend/.dockerignore                             (stage 8)
```

### 2.2 Backend — rewritten

```
apps/backend/src/db.js                  lazy pool + closePool
apps/backend/src/auth.js                token issue/verify, session CRUD, pruning
apps/backend/src/server.js              bootstrap, prune interval, graceful shutdown
apps/backend/src/migrate.js             ledger-based migrator with advisory lock; now independent
                                        of config.js so it needs only DATABASE_URL
apps/backend/src/routes/chat.js         rewritten in stage 8: lock acquired before any await,
                                        request-level idempotency, releaseRequestId() on failure
apps/backend/test/helpers.js            rewritten in stage 8: migration auto-discovery, real-PG mode
apps/backend/test/chat.test.js          stage 8: pool warm-up, duplicate-id and release-on-failure tests
apps/backend/test/env.js                stage 8: AI_GATEWAY_URL/KEY overridable via ??=
apps/backend/package.json               + zod, + pg-mem, --test-force-exit, test:e2e script
apps/backend/Dockerfile
```

### 2.3 Backend — deleted

```
apps/backend/src/server.test.js         stale, superseded by test/*.test.js
apps/backend/test/limits.test.js        replaced by ratelimit.test.js + validation.test.js
```

### 2.4 Frontend — new

```
apps/frontend/src/lib/api.js            API client + SSE streamChat (sends requestId)
apps/frontend/src/lib/markdown.jsx      dependency-free Markdown → React
apps/frontend/src/lib/safeHref.js       URL allowlist, extracted so it can be unit-tested (stage 8)
apps/frontend/src/lib/format.js         number / currency / date helpers
apps/frontend/src/context/AuthContext.jsx
apps/frontend/src/context/ThemeContext.jsx
apps/frontend/src/hooks/useChat.js      all chat state and side effects
apps/frontend/src/components/AuthScreen.jsx
apps/frontend/src/components/Sidebar.jsx
apps/frontend/src/components/Topbar.jsx
apps/frontend/src/components/ModelPicker.jsx
apps/frontend/src/components/MessageList.jsx
apps/frontend/src/components/Composer.jsx
apps/frontend/src/components/CodeBlock.jsx
apps/frontend/src/components/MarkdownView.jsx
apps/frontend/src/components/UsagePanel.jsx
apps/frontend/src/components/AdminPanel.jsx
apps/frontend/src/components/SettingsModal.jsx
apps/frontend/src/components/Toast.jsx
apps/frontend/test/format.test.js
apps/frontend/test/markdown-safety.test.js             (stage 8)
apps/frontend/.dockerignore                            (stage 8)
```

### 2.5 Frontend — rewritten

```
apps/frontend/src/App.jsx
apps/frontend/src/main.jsx
apps/frontend/src/styles.css             replaced minified stylesheet with full design system
apps/frontend/index.html
apps/frontend/vite.config.js             dev proxy /api and /health → :3001
apps/frontend/nginx.conf
apps/frontend/Dockerfile
apps/frontend/package.json
apps/frontend/public/sw.js
```

### 2.6 Router

```
services/router/package.json             test script → node test/run.mjs
services/router/test/run.mjs             new cross-platform runner injecting CLIENT_KEYS,
                                         ADMIN_KEY, USER_ID_HASH_SECRET
services/router/router.e2e.config.json   stage 8: test-only providers (fake, flaky) and routes
services/router/Dockerfile               stage 8: HEALTHCHECK added
```

No `services/router/src/**` file was modified.

### 2.7 Root, deploy, CI, docs

```
README.md                                rewritten
package.json                             rewritten (workspaces + scripts: check, check:compose, test:e2e)
docker-compose.yml                       rewritten
docker-compose.prod.yml                  new
deploy/Caddyfile                         new
deploy/nginx-freefirst.conf              stage 9 — nginx reverse proxy alternative to Caddy
deploy/logrotate-freefirst               stage 9 — log rotation config
deploy/UBUNTU-24.04-GUIDE.md             stage 9 — step-by-step Ubuntu deployment guide
deploy/ROLLBACK.md                       stage 9 — rollback and disaster recovery procedures
.env.example                             rewritten — comprehensive template with all variables documented
.env.example                             rewritten
.github/workflows/ci.yml                 rewritten
docs/WORKBUDDY-EXECUTION-REPORT.md       new (this file)
docs/ARCHITECTURE.md                     rewritten
docs/INSTALL.md                          rewritten
docs/API.md                              new; stage 8: usage response shape corrected
docs/SECURITY.md                         rewritten
docs/BACKUP.md                           rewritten; stage 8: §4.5 backup drill added
docs/MONITORING.md                       rewritten
docs/TROUBLESHOOTING.md                  rewritten
docs/DEVELOPMENT.md                      new; stage 8: real-PG, e2e and compose-check sections added
docs/DEPLOYMENT.md                       rewritten
docs/PROVIDER-VERIFICATION.md            stage 8: free-tier provider procedure (not executed)
apps/desktop/README.md                   rewritten
apps/desktop/package.json                reformatted (scripts unchanged)
scripts/check-source.mjs                 new — parse-checks every backend and router source file
scripts/check-source.sh                  deleted, superseded by the .mjs version (6 files → 22)
scripts/validate-compose.mjs             stage 8 — 60 structural assertions, no Docker needed
scripts/backup-restore-drill.mjs         stage 8 — logical backup/restore rehearsal
scripts/backup.mjs                       stage 9 — production pg_dump backup script
scripts/restore.mjs                      stage 9 — production restore script (with confirm gate)
scripts/monitor.mjs                      stage 9 — health check monitor
```

### 2.8 Bugs found and fixed

These were real defects, not polish. Each is listed because the fix changes behaviour.

| # | Defect | Fix |
|---|---|---|
| 1 | `config.js` read `process.env` only. `.env` was never loaded, so the documented `cp .env.example .env` flow failed with `Missing required environment variable: DATABASE_URL`. | Added `src/loadEnv.js` — a ~60-line parser that loads `apps/backend/.env` then the repo-root `.env`, never overriding an existing variable. Covered by `env-loader.test.js`. |
| 2 | A gateway failure after the conversation row was created left an orphan conversation in the sidebar, and a retry created a second one. | Conversation creation and user-message insert moved to **after** the gateway accepts the request. |
| 3 | Two concurrent sends on one conversation both reached the provider — double billing. | Per-`userId:conversationId` in-flight lock returning `409 request_in_flight`. |
| 4 | `/api/auth/me` returned `500 Cannot read properties of undefined (reading 'id')` because `req.user` was never populated — `requireAuth` was not mounted on the auth router. | `createAuthRouter` now takes `requireAuth` and mounts it on `/me`, `/logout`, `/logout-all`, `/sessions`. |
| 5 | `express-rate-limit` threw `ERR_ERL_UNKNOWN_VALIDATION: options.validate.keyGeneratorIpFallback is not recognized` on boot. | Removed the unsupported key; kept `trustProxy: false` and `xForwardedForHeader: false`. |
| 6 | Usage and conversation queries used correlated subqueries and `::float8` casts that `pg-mem` rejects — meaning the tested path and the deployed path were different SQL. | Rewrote to `LEFT JOIN ... GROUP BY` and converted with `Number()` in JS. |
| 7 | The test suite hung for ~60 s after passing, because `express-rate-limit` keeps a store timer alive. | `--test-force-exit` in the test script, plus `closeAllConnections()` on teardown. |
| 8 | A combined `limits.test.js` set `CHAT_RATE_MAX=2` process-wide and caused a spurious `429` in an unrelated test. | Split into `ratelimit.test.js` (own process) and `validation.test.js`. |
| 9 | Backend suite took ~150 s because bcrypt ran at production cost in tests. | `BCRYPT_ROUNDS` made configurable; tests pin it to 4. Suite now ~20 s. |
| 10 | `docs/README.md` and `docs/INSTALL.md` described a `packages/` layout that no longer exists, with wrong ports and env var names. | Rewritten against the actual tree. |
| 11 | **Security defect (stage 8).** The log redactor stored `'apiKey'` with a capital `K` in a `Set` but looked up `key.toLowerCase()`, so `apiKey` and `APIKEY` were written to stdout in clear text. Only the snake_case spelling was redacted. | Redaction now normalises keys (lowercase, separators stripped) before matching, and ignores a leading `x` so `x-admin-key` matches `admin-key`. Covered by a dedicated regression test plus the existing leak test. |
| 12 | **Concurrency defect (stage 8).** The in-flight lock was taken *after* an awaited ownership `SELECT`. On a cold pool the first request could finish before the second request's auth round-trip completed, so both passed the guard. `pg-mem` masked this because it is far faster than a network round trip. | Lock is now acquired before any `await` in the handler. Because an in-process lock is inherently timing-dependent, a latency-independent second guard was added: a `chat_requests` table with `request_id` as primary key, so a repeat is a `409 duplicate_request` even if it arrives after the first request finished. |
| 13 | Two duplicate indexes found by inspecting the real database: `messages_conv_created_desc_idx` (identical to `messages_conversation_created_idx`) and `sessions_jti_idx` (redundant with the implicit unique index on `jti`). | Migration `004_integrity_cleanup.sql` drops both. The applied migration was not edited — the ledger is forward-only. |
| 14 | `app_users.role` had no CHECK constraint, so an invalid role could be written by any future code path. | Migration `004` adds `CHECK (role IN ('user','admin'))`. |
| 15 | `npm run migrate` aborted with `JWT_SECRET is required`, because `migrate.js` imported `db.js` → `config.js`. A schema migration needs only `DATABASE_URL`. | `migrate.js` now builds its own pool from `DATABASE_URL` (honouring `DB_SSL`) and no longer imports the app config. |
| 16 | `safeHref` accepted `//evil.example.com` — a protocol-relative URL that resolves to an external host while looking like a relative path. | Explicit rejection of any URL starting with `//`, covered by 12 malicious-scheme test cases. |
| 17 | `docs/API.md` documented `/api/usage` as `totals.assistant_messages` etc. The real shape is `messages.{user,assistant,total}`, `tokens.{input,output}`, `costUsd`, and `daily[]` is **not** zero-filled. | Doc corrected; the test was corrected to match the handler rather than the handler to match the doc. |
| 18 | **CSP disabled in production.** Helmet was configured with `contentSecurityPolicy: false`, meaning no Content-Security-Policy header was sent. | Enabled CSP with restrictive directives (`default-src 'self'`, `script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `connect-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`). HSTS enabled in production. Covered by security headers regression test. |
| 19 | **Connection pool had no timeout.** A hung database connection could block requests indefinitely. | Added `idleTimeoutMillis: 30000` and `connectionTimeoutMillis: 10000` to the pg Pool. |

### 2.9 Tooling added in this stage

`npm run check` parses every `.js`/`.mjs` file under `apps/backend/src` and `services/router/src`
with `node --check` and fails on the first file that does not parse. The frontend is excluded
because JSX is not valid JavaScript — `vite build` is its syntax gate.

`npm run check:compose` replaces `docker compose config` on machines without Docker. See §3.6 for
what it does and does not prove.

---

## 3. Tests that were actually run

All commands below were executed in this workspace on Windows (Git Bash), Node 22.22.2, against
PostgreSQL 18.4.

### 3.1 Backend on `pg-mem` — `npm test` in `apps/backend`

```
node --test --test-force-exit test/*.test.js
```

Real Express app on a real HTTP server, real SQL against `pg-mem`, real bcrypt at cost 4, fake
gateway emitting real SSE frames.

| File | Tests | What is covered |
|---|---|---|
| `auth.test.js` | 4 | register → login → `/me`; wrong password rejected; duplicate email 409; logout revokes session so the same token is rejected afterwards |
| `conversations.test.js` | 3 | create/list/get scoped to owner; second user gets 404 on the first user's conversation; rename and delete |
| `chat.test.js` | 8 | streaming happy path; assistant message persisted with route/tier/tokens; conversation auto-created on first turn; gateway failure produces no orphan rows; stop/abort persists `finish_reason = 'aborted'`; concurrent request on the same conversation returns 409; a duplicate `requestId` is rejected even after the first request finished; a failed send releases its `requestId` so a retry can succeed |
| `ratelimit.test.js` | 1 | chat bucket returns 429 after the configured maximum (isolated process so the env override cannot leak) |
| `validation.test.js` | 3 | empty messages rejected; oversized body rejected; unknown conversation id rejected |
| `env-loader.test.js` | 3 | `.env` parsing (comments, `export`, quoted values, values containing `=`); real environment wins over `.env`; missing file is not an error |
| `security.test.js` | 11 | SQL-injection payload stored verbatim and the table survives; tampered / unsigned / `alg:none` / truncated tokens rejected; self role escalation refused; admin endpoints closed; CORS allowlist echo and hostile preflight denial; cross-user read/rename/export/delete all 404; logger redaction; redaction casing; no stack traces or internal paths in error bodies; **security headers present** (CSP, HSTS, nosniff, CORP); **gateway URL is not user-manipulable** |
| **Total** | **33** | |

### 3.2 Backend against real PostgreSQL 18.4

```
TEST_DATABASE_URL=postgresql://freefirst:devpass@127.0.0.1:55432/freefirst_app \
  node --test --test-force-exit test/*.test.js
```

The same 33 tests, same assertions, no skips and no conditional branches — `test/helpers.js` swaps
the backing store only. Each file creates its own throwaway schema (`t_<12 hex>`) through
`options=-c search_path=…` and drops it on teardown, so running against a populated database is
safe and a crashed run cannot poison the next one.

This is the run that matters: it proves the SQL exercised in tests is the SQL that runs in
production, rather than a `pg-mem` approximation of it.

### 3.3 Frontend — `npm test` in `apps/frontend`

```
node --test test/*.test.js
```

| File | Tests | What is covered |
|---|---|---|
| `format.test.js` | 5 | number compaction, USD formatting, date formatting, day labels, initials |
| `markdown-safety.test.js` | 4 | `safeHref` allowlist; 12 malicious schemes rejected (incl. `//host`); source-wide scan for `dangerouslySetInnerHTML` / `innerHTML` / `document.write` / `eval` / `new Function`; no risky Markdown dependency |
| **Total** | **9** | |

### 3.4 Router — `npm test` in `services/router`

```
node test/run.mjs
```

Four upstream suites with `CLIENT_KEYS`, `ADMIN_KEY`, `USER_ID_HASH_SECRET` injected.

### 3.5 Full chain e2e — `npm run test:e2e` in `apps/backend`

```
node test/e2e/run.mjs
```

Spawns the **real** router (port 20199) and a local OpenAI-compatible fake provider (port 20198),
then drives the backend over HTTP. No provider traffic leaves the machine.

| # | Test | What it proves |
|---|---|---|
| 1 | router schema applies to a real PostgreSQL server | `services/router/schema.sql` runs on PG 18.4 |
| 2 | reservation is atomic and cannot exceed the cap | three concurrent 0.3 reservations under a 0.4 cap: exactly one wins |
| 3 | cooldowns persist and expire | a penalty survives a store restart and stops applying after its TTL |
| 4 | route usage accumulates per day and route | usage rows are keyed correctly |
| 5 | full chain: login → backend → router → provider → stream → persistence | SSE frames reach the client and both messages are stored |
| 6 | stop generation aborts upstream and persists what was produced | partial text is kept, `aborted` recorded |
| 7 | provider failure returns 502 and a retry succeeds | error mapping, then a successful retry |
| 8 | router falls back to the next route when a provider returns 500 | route fallback, not user-visible failure |
| 9 | budget reservation refuses a paid route when the user cap is exhausted | refusal, not a silent charge |
| 10 | privacy gate refuses a may-train route for a sensitive request | fail-closed privacy |
| 11 | provider credentials never appear in any client-visible response | key non-leakage |

Tests 1–4 are **skipped** unless `E2E_PG_URL` is set. A green run without it is not evidence that
persistence works.

### 3.6 Structural validation — `npm run check:compose`

No Docker CLI exists on this machine (§6), so `docker compose config` could not be run. In its place
`scripts/validate-compose.mjs` parses both compose files and all three Dockerfiles with the `yaml`
parser and asserts 60 structural properties: every service has a healthcheck where it needs one, the
two databases publish no host ports, backend and router publish no host ports in the prod file,
required secrets are referenced as `${VAR:?}` rather than defaulted, no `ENV`/`ARG` carries a
credential, `USER node` is set, `.dockerignore` exists and excludes `.env` and `node_modules`, and
`depends_on` conditions match the healthchecks.

**This is not `docker compose config`.** It cannot detect an unpullable image tag, a broken build
context, a failed `npm ci`, a port conflict at runtime, or a healthcheck that never goes healthy.
Those require a Docker host.

### 3.7 Backup / restore rehearsal — `scripts/backup-restore-drill.mjs`

```
DRILL_DATABASE_URL=postgresql://freefirst:devpass@127.0.0.1:55432/ff_backup_drill \
  node scripts/backup-restore-drill.mjs
```

Seeds a database, exports every row, drops the schema, re-runs the real migrations, re-imports, and
compares row counts plus a content hash. Passed with an identical hash before and after
(`ae382538354413a7`).

This is a **logical** rehearsal. It is not a `pg_dump`/`pg_restore` test — see §6.

---

## 4. Actual test results

```
# backend — pg-mem
# tests 33
# pass 33
# fail 0

# backend — real PostgreSQL 18.4
# tests 33
# pass 33
# fail 0

# frontend
# tests 9
# pass 9
# fail 0

# router
DISCOVERY & RADAR LULUS
ANTHROPIC ADAPTER LULUS
STORE LULUS (memory)
SMOKE LULUS (store: memory)
all 4 router suites passed

# e2e (with E2E_PG_URL set)
# tests 11
# pass 11
# fail 0
# skipped 0

# e2e (without E2E_PG_URL)
# tests 11
# pass 7
# fail 0
# skipped 4

# syntax
Syntax OK: 22 files parsed.

# compose structure
60/60 structural checks passed.

# backup drill
[drill] content hash — ae382538354413a7 → ae382538354413a7
[drill] PASSED: backup → drop → migrate → restore reproduced the data exactly
```

### 4.1 PostgreSQL migration results

Server: PostgreSQL 18.4 (Windows x64 build obtained through the `embedded-postgres` npm package).

```
ledger: 001_init.sql, 002_sessions_roles.sql, 003_usage_indexes.sql,
        004_integrity_cleanup.sql, 005_chat_requests.sql
tables: app_users, chat_requests, conversations, messages, schema_migrations, sessions
```

Verified by querying `information_schema` and `pg_constraint` directly:

- every expected column exists with the expected type and nullability;
- primary keys, unique constraints and foreign keys present, all FK delete rules `ON DELETE CASCADE`
  where ownership implies it;
- indexes present on `messages(conversation_id, created_at)`, `conversations(user_id, updated_at)`,
  `sessions(jti)`, `chat_requests(created_at)`;
- after migration 004, the two duplicate indexes are gone and `app_users_role_check` exists;
- re-running the migrator prints `migrations up to date` and changes nothing (idempotency).

Registration, login, session revocation, conversation create/list/rename/delete, message storage and
cross-user isolation were all exercised against this server via the suite in §3.2.

---

## 5. Builds that succeeded

| Build | Command | Result |
|---|---|---|
| Frontend production bundle | `npm run build` (vite 6) | **Success.** `✓ 1596 modules transformed`. `dist/assets/index-Bq7C5FXA.js` 200.31 kB (gzip 62.59 kB); `dist/assets/index-HSIV8lpd.css` 22.12 kB (gzip 5.27 kB); `index.html` 0.76 kB (gzip 0.41 kB). `✓ built in 27.32s`. Exit 0. |
| Backend syntax/load | `npm run check` | **Success.** `Syntax OK: 22 files parsed.` Exit 0. |
| Router | `node test/run.mjs` | **Success.** 4/4 suites. |
| Compose structure | `npm run check:compose` | **Success.** 60/60 assertions. |
| Migrations on real PG | `node src/migrate.js` | **Success.** 5 migrations applied, idempotent on re-run. |
| Security hardening | `npm test` (backend) | **Success.** 33/33 including 2 new security regression tests. |
| Deployment package | `npm run check:compose` | **Success.** 60/60 structural assertions; new scripts validated syntactically. |

---

## 6. Builds that failed or were not attempted

Nothing failed. Several builds were **not attempted** because the toolchain is absent. These are
recorded as unverified, not as passing:

| Build | Status | Reason |
|---|---|---|
| Backend Docker image | **Not run** | `docker` is not installed (`docker: command not found`). Dockerfile is written and structurally validated but never built here. |
| Frontend Docker image | **Not run** | Same. |
| `docker compose config` | **Not run** | No Docker CLI. Replaced by 60 structural assertions (§3.6), which are *not* equivalent. |
| Container start order, health transitions, network isolation | **Not run** | Requires a Docker host. |
| `pg_dump` / `pg_restore` rehearsal | **Not run** | The PostgreSQL distribution available here ships `postgres.exe`, `initdb.exe` and `pg_ctl.exe` only — no client tools. Two distributions were tried (the `embedded-postgres` npm package and the Zonky Maven binary jar); both omit `psql`, `pg_dump` and `pg_restore`. Replaced by a logical rehearsal (§3.7), which is weaker. |
| Tauri desktop installers (msi/dmg/appimage/deb/rpm) | **Not run** | No Rust/cargo toolchain, no platform bundlers. Config, icons and Rust entry point are in place; no artifact was produced. |
| Live provider calls | **Not run** | No provider API keys supplied, and no paid call may be made without approval. Procedure written in `docs/PROVIDER-VERIFICATION.md`; nothing executed. |
| Deployment (Railway, VPS, WireGuard) | **Not run** | Explicitly out of scope without approval. Deployment package prepared but not executed. |

**No installer, image or deployment artifact is claimed to exist.** §6 is the definition of "needs
verification on real infrastructure".

---

## 7. Remaining security risks

Ranked by severity. Each entry says what the risk is and what would close it.

### 7.1 Desktop CSP allows any `https:` connect target — Medium

`apps/desktop/src-tauri/tauri.conf.json` sets `connect-src 'self' http://localhost:3001 https:`. The blanket `https:` is there because the backend URL is user-configurable at runtime (self-hosted deployments), and a static CSP cannot enumerate them.

Consequence: if script execution were ever achieved inside the webview, it could POST data to an attacker-controlled HTTPS host. The CSP still blocks `http:` and inline script, so this is a defence-in-depth gap rather than an open door.

Closing it: replace `https:` with an explicit allowlist, or restrict the connect target to the configured origin and require an app restart when it changes.

### 7.2 Access tokens live in `localStorage` — Medium

The frontend stores the JWT in `localStorage`, which is readable by any script running on the origin. There is no XSS sink in the app today — Markdown is rendered to React elements, never to raw HTML, and links go through `safeHref` — but a future dependency could introduce one.

Closing it: move to `HttpOnly; Secure; SameSite=Strict` cookies with a CSRF token, which requires a change to how `streamChat` authenticates.

### 7.3 No refresh-token rotation — Low/Medium

Tokens are long-lived for their TTL and are not rotated. Revocation works (server-side session check), so a stolen token can be killed, but there is no short-access-token + refresh pair.

Closing it: add a refresh endpoint issuing short-lived access tokens.

### 7.4 Password policy is minimal — Low

Zod enforces a minimum length; there is no breach-list check, no complexity rule, no lockout after repeated failures (only IP/user rate limiting).

Closing it: add per-account failed-attempt throttling and a HaveIBeenPwned k-anonymity check.

### 7.5 No email verification — Low

Anyone can register with an address they do not own. This matters only if email is later used for password reset.

### 7.6 Usage cost figures depend on router-reported pricing — Low

`usage` sums whatever the gateway reports. If the router's price table is stale, the displayed cost is wrong even though the routing decision itself was price-verified. Unknown pricing is treated as not-free and not-eligible for automatic paid routing, so this is a reporting-accuracy issue, not a spending-control hole.

### 7.7 Duplicate-charge protection is two-layered but not distributed — Low

Two guards now exist: an in-process lock, and a `chat_requests` primary-key collision that returns
`409 duplicate_request`. The second is latency-independent and survives concurrent arrival, so the
double-billing defect found in §2.8 #12 is genuinely closed for a single instance.

Neither guard is shared between processes. With more than one backend replica, two replicas can each
accept the same `request_id` because the uniqueness is enforced in Postgres — **the primary key is
shared**, so a duplicate across replicas is still rejected at insert time, but only *after* both
requests have passed the in-process lock and reached the gateway. Billing safety therefore depends on
the `chat_requests` insert happening before the provider call; that ordering must be preserved.

Closing it: move the in-flight lock to Postgres (`pg_try_advisory_lock`) or Redis.

### 7.8 Rate limiting is in-memory — Low

Per-process counters. Behind multiple replicas the effective limit multiplies by replica count.

### 7.9 Admin surface is broad — Low

Admins can read all users and trigger provider discovery. There is no audit log of admin actions.

Closing it: add an `admin_audit` table written on every privileged mutation.

### 7.10 Router state pollution between environments — Low (operational)

The router persists cooldowns in Postgres. A single failed provider call cools that provider for 60
seconds across every instance sharing the database. During this stage it produced a false `502` in an
unrelated test. Operationally it is correct behaviour (shared quotas are real), but it means a
staging and production router must not share a database.

### 7.11 What is *not* a risk

- Provider API keys are never sent to the browser. The frontend has no knowledge of them; all provider traffic goes backend → router → provider. Covered by e2e test 11.
- `ADMIN_KEY` and `USER_ID_HASH_SECRET` exist only in the router's environment. The backend never forwards them to a client.
- No secret is committed. `.env` is gitignored; `.env.example` contains only `CHANGE_ME` placeholders; `npm run check:compose` asserts no Dockerfile carries a credential.
- `config.js` refuses to boot on a missing, short, or placeholder `JWT_SECRET`, so a default-secret deployment cannot happen by accident.
- SQL injection is structurally prevented: every query is parameterised, and the security test stores `'; DROP TABLE messages; --` verbatim and confirms the table survives.
- Log redaction is now case- and separator-insensitive, with a regression test (§2.8 #11).
- CSP is enforced in production via Helmet (§2.8 #18).
- Security headers (nosniff, CORP, HSTS) are present on every response (§3.1).

---

## 8. Features that still need implementation

Ordered by what blocks a real deployment first.

1. **Docker build verification.** Build both images, run `docker compose up`, confirm SSE passes through Caddy and nginx without buffering, and confirm the backend starts only after migrations succeed. (Deployment package prepared in Stage 9; see `deploy/UBUNTU-24.04-GUIDE.md`.)
2. **`pg_dump`/`pg_restore` rehearsal** on a host that has the client tools, replacing the logical drill as the authoritative restore test. (Scripts prepared: `scripts/backup.mjs`, `scripts/restore.mjs`)
3. **Tauri build verification** on Windows, macOS and Linux, and a real install/launch test of the produced artifacts.
4. **Live provider smoke test** with a single free-tier key, per `docs/PROVIDER-VERIFICATION.md`. Requires approval.
5. **Password reset flow** (email token) — not implemented.
6. **Email verification** — not implemented.
7. **Refresh-token rotation** — not implemented.
8. **Distributed rate limiting and in-flight locking** — required before running more than one backend replica.
9. **Admin audit log** — not implemented.
10. **Per-conversation export formats** — JSON export exists; Markdown/PDF export does not.
11. **File/image attachments** — not implemented; the chat API is text-only.
12. **Automated browser E2E** — no Playwright/Cypress suite. The e2e suite covers the API chain, not the rendered UI.
13. **WireGuard + VPS production runbook execution** — documented in `deploy/UBUNTU-24.04-GUIDE.md`, never executed.
14. **UI language is inconsistent.** Some strings are Indonesian (`Percakapan baru`, `Belanja hari ini`), others English (`Workspace settings`, `What are we`). Cosmetic, but visible on every screen. Fixing it properly means extracting strings into one table and choosing a single locale.

---

## 9. Next steps

**Immediate (no approval needed, no cost):**

1. On a machine with Docker: `docker compose config`, build both images, `docker compose up`, and verify SSE is not buffered through nginx and Caddy.
2. On a machine with PostgreSQL client tools: run the `pg_dump`/`pg_restore` rehearsal in `docs/BACKUP.md` §4 and compare against the logical drill.
3. Add a browser E2E suite (register → chat → reload → history) — the last untested layer.

**Requires approval:**

4. One live call against a free-tier provider key, following `docs/PROVIDER-VERIFICATION.md`.
5. Tauri builds on each target OS.
6. Railway staging deployment.
7. VPS + WireGuard production deployment.

**Then, in priority order:**

8. Refresh-token rotation and cookie-based sessions (closes §7.2 and §7.3 together).
9. `pg_try_advisory_lock`-based in-flight guard and Redis rate limiting (closes §7.7 and §7.8).
10. Password reset + email verification.
11. Admin audit log.

---

## Appendix A — How to reproduce every result in this report

```bash
# from the repository root
npm install
npm run check          # Syntax OK: 22 files parsed
npm run check:compose  # 60/60 structural checks passed
npm test               # backend 33, frontend 9, router 4 suites
npm run build          # vite production build
```

Backend suite only, on `pg-mem`:

```bash
cd apps/backend && npm test
```

Backend suite against real PostgreSQL:

```bash
cd apps/backend
TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/freefirst_app \
  node --test --test-force-exit test/*.test.js
```

Migrations (needs only `DATABASE_URL`):

```bash
cd apps/backend
DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/freefirst_app npm run migrate
```

Full chain e2e:

```bash
cd apps/backend
E2E_PG_URL=postgresql://user:pass@127.0.0.1:5432/freefirst_router npm run test:e2e
```

Backup/restore rehearsal (dedicated database — it drops the schema):

```bash
DRILL_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/ff_backup_drill \
  npm run drill:backup
```

Production backup (requires `pg_dump`):

```bash
APP_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/freefirst_app \
  ROUTER_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/freefirst_router \
  BACKUP_DIR=/var/backups/freefirst \
  node scripts/backup.mjs
```

Health monitor:

```bash
HEALTH_URL=http://localhost/ready node scripts/monitor.mjs
```

Router suite only (env is injected by the runner):

```bash
cd services/router && npm test
```

## Appendix B — Environment limitations encountered

| Limitation | Effect on this report |
|---|---|
| No Docker daemon or CLI | Images, compose config and container behaviour unverified; replaced by 60 structural assertions |
| PostgreSQL client tools absent (`psql`, `pg_dump`, `pg_restore`) | Migrations were applied and inspected through `pg` (node-postgres) instead; the restore drill is logical, not `pg_dump` |
| No Rust / cargo | No desktop installer produced |
| No provider API keys | No live gateway call; all tests use a local fake |
| `express-rate-limit` keeps a timer alive | Required `--test-force-exit`; without it the suite hangs for ~60 s after passing |
| `pg-mem` rejects `::float8` and correlated subqueries | `003_usage_indexes.sql` and two queries were rewritten to portable SQL — a genuine improvement, but it means the portable path is the tested one. Mitigated by running the whole suite against real PG. |
| `pg-mem` duplicates rows in `information_schema.tables` | A table-existence assertion had to be rewritten as a real `SELECT`, not a metadata count. The product was never affected. |
| `pg-mem` is far faster than a networked server | It masked a real concurrency defect (§2.8 #12) that only appeared against real PG. This is the strongest argument for keeping the real-PG run in the loop. |

---

## Appendix C — Stage 9 Summary

### What was done

| Area | Deliverable | Status |
|---|---|---|
| **A. Docker** | `deploy/UBUNTU-24.04-GUIDE.md` — step-by-step Docker installation and deployment on Ubuntu 24.04 | Prepared (Docker not available here) |
| **B. Database** | Connection pool timeouts added (`idleTimeoutMillis`, `connectionTimeoutMillis`); migration idempotency verified | Done |
| **C. Security** | CSP enabled via Helmet; HSTS in production; security headers regression test; SSRF structural test; connection pool hardening | Done |
| **D. Provider** | Mock provider verification already complete (e2e 11/11); free-tier procedure in `docs/PROVIDER-VERIFICATION.md` | Done |
| **E. Deployment** | Production backup script (`scripts/backup.mjs`), restore script (`scripts/restore.mjs`), health monitor (`scripts/monitor.mjs`), nginx config, logrotate config, rollback procedure | Done |
| **F. Desktop** | Tauri config reviewed; no build possible (no Rust toolchain) | Documented |
| **G. Report** | This report updated with Stage 9 results | Done |

### New files in Stage 9

```
apps/backend/src/db.js                    added pool timeouts (idleTimeoutMillis, connectionTimeoutMillis)
apps/backend/src/app.js                   enabled CSP and HSTS via Helmet
apps/backend/test/security.test.js        +2 tests: security headers, SSRF protection
deploy/UBUNTU-24.04-GUIDE.md              Ubuntu 24.04 VPS deployment guide
deploy/nginx-freefirst.conf               Nginx reverse proxy config (Caddy alternative)
deploy/logrotate-freefirst                Log rotation for Docker and application logs
deploy/ROLLBACK.md                        Rollback and disaster recovery procedures
scripts/backup.mjs                        Production pg_dump backup with retention
scripts/restore.mjs                       Production restore with confirmation gate
scripts/monitor.mjs                       Health check monitor with optional webhook alert
.env.example                              rewritten with comprehensive documentation
package.json                              added "monitor" script
```

### Test counts (final)

| Suite | Tests | Pass |
|---|---|---|
| Backend (pg-mem) | 33 | 33 |
| Backend (real PG 18.4) | 33 | 33 |
| Frontend | 9 | 9 |
| Router | 4 suites | 4 |
| e2e (with E2E_PG_URL) | 11 | 11 |
| Syntax check | 22 files | 22 |
| Compose structure | 60 checks | 60 |
| Backup drill | 1 | 1 |

---

## Appendix D — Stage 8 re-run: Infrastructure & Integration Verification (2026-10-31)

This appendix records a fresh execution of the Stage 8 scope against the current
workspace. Nothing was rebuilt: every existing implementation and test was kept and
re-run. Where a number here differs from Appendix C, **this appendix supersedes it**.

### D.1 Environment as found

| Component | State |
|---|---|
| Node.js | v22.22.2 |
| Docker / Podman / nerdctl | **absent** (`docker: command not found`, exit 127) |
| PostgreSQL server | **absent** — no service, no process, nothing listening on 5432/55432 |
| `psql` / `pg_dump` / `pg_restore` / `createdb` | **absent** from PATH and from every install directory searched |
| Network to npm registry | available (`npm ping` → PONG) |

The PostgreSQL instance used in Stage 10 (port 55432) no longer existed on this
machine. Rather than claim a database that was not there, a project-local cluster was
provisioned (D.2) and every result below was produced against it.

### D.2 PostgreSQL provisioned for development

Real PostgreSQL 18.6 server binaries were installed **inside the project** through
the `embedded-postgres` package — no admin rights, no system install, no Docker:

```bash
npm install --no-save embedded-postgres      # binaries land in node_modules/@embedded-postgres/windows-x64
node scripts/dev-postgres.mjs start          # initdb + pg_ctl start + ensure databases
node scripts/dev-postgres.mjs status
node scripts/dev-postgres.mjs stop
```

| Property | Value |
|---|---|
| Server version | PostgreSQL **18.6** (x86_64-windows, msvc-19.44) |
| Data directory | `<repo>/.pgdata` (gitignored; isolated from every other cluster on the machine) |
| Listen address | `127.0.0.1:55432` — loopback only |
| Databases | `freefirst_app`, `freefirst_router`, `stage10_migtest` |
| URL | `postgresql://postgres:postgres@127.0.0.1:55432/freefirst_app` |

Notes recorded deliberately:

- `embedded-postgres` is **not** added to `package.json`. It downloads ~100 MB of
  server binaries at install time; forcing that on every CI install would be worse
  than the clear error `dev-postgres.mjs` prints when the package is missing.
- The cluster authenticates with `--auth=trust`, which is safe **only** because it
  binds to loopback and holds disposable test data. This must never be copied to a
  host that is reachable from another machine.
- The server does not outlive the shell that starts it in this sandbox, so each
  verification command starts the cluster, does its work, and lets it exit.

### D.3 Migrations

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/freefirst_app \
  npm --workspace apps/backend run migrate
```

```
applied 001_init.sql
applied 002_sessions_roles.sql
applied 003_usage_indexes.sql
applied 004_integrity_cleanup.sql
applied 005_chat_requests.sql
migrations up to date
```

Exit code **0**. Re-running immediately afterwards printed only
`migrations up to date` — the runner is idempotent and records each file in
`schema_migrations`. The same five migrations were also applied to the isolated
`stage10_migtest` database used by the behavioural suite.

### D.4 Schema verification (new)

`scripts/stage8-schema-verify.mjs` asserts the exact schema the migrations should
produce — not counts, but set equality per table. Read-only.

```bash
DATABASE_URL=... node scripts/stage8-schema-verify.mjs
```

**47 / 47 assertions PASS, exit 0.**

| Group | Assertions | Result |
|---|---|---|
| Table set (6 tables) | 1 | exact match |
| Migration ledger | 1 | all five files recorded |
| Columns / types / nullability | 18 | exact match for `app_users`, `conversations`, `messages`, `sessions`, `chat_requests`, `schema_migrations` |
| Primary keys | 6 | one per table |
| Foreign keys + delete rule | 2 | 4 FKs, **all `ON DELETE CASCADE`** |
| Unique + CHECK constraints | 4 | `app_users.email`, `sessions.jti`; `messages.role ∈ {user,assistant}`, `app_users.role ∈ {user,admin}`; exactly 2 CHECKs |
| Indexes | 12 | 7 named indexes present, both duplicates removed by 004 absent, 3 index definitions verified |
| Defaults | 3 | `role='user'`, title default, `now()` timestamps |

### D.5 Database behaviour verification

```bash
STAGE10_PG_URL=postgresql://postgres:postgres@127.0.0.1:55432/stage10_migtest \
  node scripts/stage10-db-verify.mjs
```

**14 / 14 PASS, exit 0** on PostgreSQL 18.6 — transaction rollback, 10 concurrent
unique inserts, duplicate-email `23505`, ownership isolation, cross-user query
returns zero rows, idempotency PK rejection, FK cascade, pool queueing under
exhaustion, and clean error + pool recovery on forced disconnect.

### D.6 Integration tests (new)

`apps/backend/test/integration/db.test.js` — DB-level assertions the HTTP suite does
not make. Skipped (visibly, not silently) unless `TEST_DATABASE_URL` is set.

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/freefirst_app \
  npm run test:integration
```

**6 / 6 PASS, exit 0.**

| Test | What it proves |
|---|---|
| password is persisted as a bcrypt hash | `$2b$…` format, password not embedded, not plaintext |
| login writes a session row; logout revokes it | `revoked_at` stamped on that `jti` only; token then returns 401; sibling session unaffected |
| logout-all revokes every active session | 2+ active → 0; both tokens rejected |
| streamed reply persisted with metadata | role order `user→assistant`, content, `route_id`, `tier`, `tokens_in/out`, `finish_reason`; one `chat_requests` row |
| deleting a conversation cascades | 2 messages → 0 after DELETE |
| rows never cross users | foreign conversation returns 404; ownership confirmed in SQL |

Three assertions were wrong on first run and were corrected against real behaviour,
not worked around: logout returns **204** (not 200); `requestId` must be a **UUID**
(zod rejects `'req-persist-1'` with 400); and registration itself creates a session,
so logout revokes **one of two** sessions rather than all.

### D.7 Test results (all suites, this run)

| Suite | Command | Result | Exit |
|---|---|---|---|
| Backend (pg-mem) | `npm --workspace apps/backend test` | **41 / 41**, 0 skipped | 0 |
| Backend (real PostgreSQL 18.6) | `TEST_DATABASE_URL=… npm --workspace apps/backend test` | **41 / 41**, 0 skipped | 0 |
| DB integration (new) | `npm run test:integration` | **6 / 6** | 0 |
| e2e router + pgstore (real PG) | `E2E_PG_URL=… npm --workspace apps/backend run test:e2e` | **11 / 11**, 0 skipped | 0 |
| Frontend | `npm --workspace apps/frontend test` | **9 / 9** | 0 |
| Router | `npm --workspace services/router test` | **5 / 5 suites** (49 SSRF assertions) | 0 |
| Schema inventory (new) | `node scripts/stage8-schema-verify.mjs` | **47 / 47** | 0 |
| DB behaviour | `node scripts/stage10-db-verify.mjs` | **14 / 14** | 0 |
| Compose structure (static) | `npm run check:compose` | **60 / 60** | 0 |
| Syntax gate | `npm run check` | 23 files | 0 |
| Pages staging | `npm run verify:pages` | 106 / 106 | 0 |

Coverage gain worth noting: the four `pgstore` tests
(`router schema applies…`, `reservation is atomic…`, `cooldowns persist and expire`,
`route usage accumulates…`) were **skipped** in every previous run because no
PostgreSQL URL was configured. With the local cluster they executed and passed.

### D.8 Integration flow (Priority 3)

Exercised by the e2e suite against a local fake provider — no external call:

`login → backend → router v3.2 → provider adapter → SSE stream → persistence`

| Requirement | Evidence | Result |
|---|---|---|
| Authentication / authorization | e2e 5, backend auth 6, security 4 | PASS |
| SSE streaming | e2e 5 (full chain), backend chat 2 | PASS |
| Stop generation | e2e 6 — upstream aborted, partial reply persisted | PASS |
| Retry and fallback | e2e 7 (502 then retry succeeds), e2e 8 (fallback to next route) | PASS |
| Conversation ownership | backend conversations 1, security 4, integration 6 | PASS |
| Rate limiting | backend ratelimit 1 (per user, 429) | PASS |
| Budget reservation | e2e 9 (paid route refused at cap), pgstore 2 (atomic) | PASS |
| Provider cooldown | pgstore 3 (persist + expire) | PASS |
| Error handling | backend chat 4 (502), validation 3 (404), security 3 (no leakage) | PASS |
| No double charge / duplicate message | backend chat 5 (concurrent), chat 6 (duplicate request id → 409), chat 7 (failed send releases id), integration 4 (one ledger row) | PASS |

### D.9 Docker (Priority 2) — BLOCKED, nothing claimed

```
$ docker compose config
bash: docker: command not found
exit=127
```

No daemon, no CLI, no Podman, no nerdctl. **No image was built and no container was
started.** `docker compose config`, `docker build`, healthcheck transitions and
network isolation remain unverified.

What *was* verified, statically:

| Check | Result |
|---|---|
| `npm run check:compose` (structure, healthchecks, volumes, networks, no published DB port) | **60 / 60** |
| Dockerfiles reviewed manually (all three) | non-root `USER node` (backend, router), multi-stage frontend, HEALTHCHECK on every service, no `COPY .env`, no secret in any `ARG`/`ENV` |
| `VITE_API_BASE` defaults to empty in the frontend build | relative `/api` — no backend address baked into the image |
| Published ports | only `127.0.0.1:3001` and `127.0.0.1:5173`; PostgreSQL and router are **not** published |

**Defect found during review (not fixed — cannot be validated without a daemon):**
`apps/backend/Dockerfile` and `apps/frontend/Dockerfile` copy
`package.json package-lock.json*`, but only the **repository root** has a
`package-lock.json`; the per-workspace directories have none. `npm ci` therefore
fails inside those images and the `|| npm install` fallback silently installs
unpinned versions. The router image is unaffected (`services/router/package-lock.json`
exists). Fixing this means changing the build context to the repository root, which
cannot be tested here — recorded rather than applied blind.

### D.10 Security (Priority 4)

No standard was lowered to make a test pass; the suite ran unchanged against a real
database.

| Area | Evidence | Result |
|---|---|---|
| JWT + session revocation | auth 4 (expired), auth 5 (wrong key), auth 7 (role change revokes sessions), integration 2–3 (DB-level `revoked_at`) | PASS |
| Password hashing | bcrypt, rounds 12 default; integration 1 asserts `$2b$` format and no plaintext | PASS |
| CORS | allowlist only, `credentials: false`; security 5 | PASS |
| CSRF | **not applicable by design** — auth is `Authorization: Bearer`; grep confirms zero `cookie`/`Set-Cookie` usage in the backend, so there are no ambient credentials to forge | PASS (by construction) |
| XSS / Markdown | custom React-element renderer, no `dangerouslySetInnerHTML`; `safeHref` allowlists `http(s)://` and `/` | PASS (inspection) |
| SQL injection | security 1 (payloads stored verbatim, schema intact); all queries parameterised | PASS |
| API key protection | e2e 11 (no credential in any client-visible response), security 6 (log redaction) | PASS |
| Rate limiting | ratelimit 1 (per-user 429) | PASS |
| Data isolation | security 4, auth 6, integration 6 | PASS |
| Log redaction | security 6, 7 (case/separator insensitive) | PASS |
| Production config | `config.js` fails fast: `JWT_SECRET` required, ≥32 chars, placeholder rejected when `NODE_ENV=production`; registration opt-in; CORS explicit | PASS (inspection) |

Residual risks (unchanged, restated):

1. The dev cluster uses `trust` auth on loopback. Acceptable locally, never on a host.
2. `TRUST_PROXY` remains env-gated; behind the Pages proxy, `x-forwarded-*` is set by
   the proxy, so `trust proxy` should stay off unless client IPs are needed.
3. Provider live behaviour is still unverified — see D.11.

### D.11 Provider test (Priority 5) — procedure ready, NOT EXECUTED

`docs/PROVIDER-VERIFICATION.md` already contains the full free-tier procedure with an
explicit approval gate. **No request was sent to any provider.** Every chat-path test
in this run used the local fake provider (`apps/backend/test/e2e/fake-provider.mjs`,
`http://127.0.0.1:20198`) or an in-process `installFakeGateway` stub. No paid model
was contacted, no credential was used.

Awaiting explicit approval before any live call, as instructed.

### D.12 Files changed in this stage

| File | Change |
|---|---|
| `scripts/dev-postgres.mjs` | **new** — project-local PostgreSQL 18.6 cluster (start/stop/status/reset), importable API |
| `scripts/stage8-schema-verify.mjs` | **new** — 47-assertion exact schema inventory (read-only) |
| `apps/backend/test/integration/db.test.js` | **new** — 6 DB-level integration tests, skipped without `TEST_DATABASE_URL` |
| `apps/backend/package.json` | `test:integration` script |
| `package.json` | `test:integration` script |
| `.gitignore` | `.pgdata/`, `.backup-drill/` |

No application code was modified. No migration was added or altered. No existing test
was weakened.

### D.13 Still unverified

| Item | Why | What would unblock it |
|---|---|---|
| `docker compose config` | no Docker CLI | install Docker on the host |
| Image builds (backend, frontend, router) | no Docker daemon | same |
| Container healthchecks, start order, network isolation | no daemon | `docker compose up` on a real host |
| **Backup / restore** | `pg_dump` and `pg_restore` are not installed here — `scripts/backup.mjs` reports `pg_dump could not run (ENOENT)` → `0 succeeded, 1 failed, 1 skipped` | run inside the `postgres:18-alpine` container (where the tools exist) or install `postgresql-client-18` |
| Live provider calls | intentionally gated on approval | explicit approval + free-tier keys |
| VPS runtime | no Tencent host reached | deploy on Lighthouse |
| Cloudflare Pages | no project deployed | manual steps in `CLOUDFLARE-PAGES-TENCENT-DEPLOYMENT.md` |

The backup blocker is a host limitation, not a code defect: the Docker deployment runs
`pg_dump` inside the database container, where it is present. The previously reported
Stage 10 result (41/41 backup/restore assertions) was produced on a host that had the
client tools; that host state is gone and is not being claimed as current.
