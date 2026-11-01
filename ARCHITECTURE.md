# Architecture

## 1. Shape of the system

Four runnable pieces and one shared contract.

```
                      ┌──────────────────────────────┐
   browser / PWA ────▶│  frontend (React + Vite)     │
                      │  nginx: static + /api proxy  │
                      └──────────────┬───────────────┘
                                     │ HTTP, same-origin /api
                                     ▼
                      ┌──────────────────────────────┐
   Tauri shell ──────▶│  backend (Express)           │
   (same bundle)      │  auth · history · usage      │
                      │  streaming relay · admin     │
                      └──────┬───────────────┬───────┘
                             │ pg            │ HTTP + client key
                             ▼               ▼
                    ┌────────────┐   ┌───────────────────────┐
                    │ PostgreSQL │   │  router (v3.2)        │
                    │ app db     │   │  free-first policy    │
                    └────────────┘   │  pricing · budget     │
                                     │  discovery · cooldown │
                                     └──────┬────────────────┘
                                            │ provider API keys
                                            ▼
                                   Groq · Gemini · Cerebras
                                   NVIDIA · OpenRouter · Mistral
                                   Z.ai · DeepSeek · Anthropic
```

Two separate databases, deliberately:

- **`freefirst_app`** — users, sessions, conversations, messages. Owned by the backend.
- **`freefirst_router`** — router state: route catalogue, spend ledger, reservations, cooldowns.
  Owned by the router.

The backend has no credentials for the router database, and the router has none for the app
database. An injection bug in the chat surface cannot read the spend ledger, and a bug in the
router cannot delete a user's conversations.

## 2. Trust boundaries

| Boundary | Rule |
|---|---|
| Browser → backend | Only a JWT. No provider keys, no `ADMIN_KEY`, no router client key. |
| Backend → router | Router client key from `AI_GATEWAY_KEY`, server-side env only. |
| Router → provider | Provider API keys, held only by the router process. |
| Desktop webview → backend | Same as browser; the backend URL is user-configurable, so the CSP allows `https:` for `connect-src`. |
| Admin UI → backend | Requires `role = 'admin'`; the router admin key stays on the backend. |

The frontend bundle contains **no** secret of any kind. `VITE_*` variables are compile-time public
by definition, which is why `VITE_API_BASE` is the only one used and it holds a URL, not a key.

## 3. Backend

### 3.1 Composition

`src/app.js` exports `createApp({ pool })`. Everything downstream is a factory that receives its
dependencies:

```
createApp({ pool })
 ├── createAuthRouter(pool, limiters, requireAuth)
 ├── createConversationsRouter(pool, requireAuth)
 ├── createChatRouter(pool, requireAuth, limiters)
 ├── createModelsRouter(requireAuth)
 ├── createUsageRouter(pool, requireAuth)
 └── createAdminRouter(pool, requireAuth)
```

This is the reason the test suite is meaningful: tests construct the **same** `createApp` with a
`pg-mem` pool and drive it over real HTTP. There is no second implementation of the routing logic
that exists only for tests.

`src/server.js` is the only file that touches process lifecycle — pool creation, the hourly session
prune, and `SIGTERM`/`SIGINT` shutdown.

### 3.2 Request pipeline

```
helmet → cors(allowlist) → express.json(256kB) → request log
      → route → validate(zod) → requireAuth → handler → errorHandler
```

- `requireAuth` verifies the JWT (HS256, pinned issuer + audience) and then checks the `jti`
  against `sessions`. Signature validity alone is not enough.
- `validate(schema)` parses and replaces `req.body` with the parsed result, so downstream code only
  ever sees validated, coerced data.
- `asyncHandler` forwards rejected promises to `errorHandler`, which maps `HttpError` to its status
  and code and everything else to a generic `500`.

### 3.3 Chat flow (the interesting one)

The ordering here exists to prevent two specific bugs: orphan rows and double billing.

```
1. validate body
2. if conversationId: SELECT ... WHERE id=$1 AND user_id=$2   → 404 if not owned
3. acquire in-flight lock on `${userId}:${convId ?? 'new'}`   → 409 if held
4. call router (may take seconds)
   ├─ failure → release lock, return error, NOTHING was written
   └─ success ↓
5. create conversation if new (title = first 60 chars of user message)
6. insert user message, touch conversation.updated_at
7. relay the SSE stream to the client while parsing frames
8. on stream end: insert assistant message with content, route_id, tier,
   tokens_in, tokens_out, finish_reason
9. release lock
```

Consequences worth stating explicitly:

- A provider outage leaves no empty conversation in the sidebar.
- A double-submit gets `409` instead of two billed completions.
- A client disconnect aborts the upstream request and persists what was actually generated with
  `finish_reason = 'aborted'` — the history matches the bill.
- Streaming is a *relay*, not a re-serialisation: the client receives the router's frames with
  minimal added latency, while the backend parses a copy for persistence.

### 3.4 Data model

```
app_users (id uuid pk, email unique, password_hash, role, display_name, created_at, updated_at)
   │ 1
   │ n
sessions (jti pk, user_id fk, created_at, expires_at, revoked_at, user_agent, ip_hash)

conversations (id uuid pk, user_id fk, title, model, created_at, updated_at)
   │ 1
   │ n
messages (id uuid pk, conversation_id fk on delete cascade, role, content, model,
          route_id, tier, tokens_in, tokens_out, cost_usd, finish_reason, created_at)
```

`ON DELETE CASCADE` on messages means deleting a conversation is a single statement with no
orphans. `route_id` and `tier` on assistant messages are what let the usage panel say *which* route
was actually used, rather than guessing from the requested alias.

Migrations are applied by `src/migrate.js`, which records each filename in `schema_migrations` and
wraps the run in `pg_advisory_lock(918273645)` so two containers starting at once cannot both apply
migration 003.

## 4. Router (v3.2, unmodified)

The router is carried over as-is because it is the security and cost-control baseline. Its
guarantees, as exercised by its own suites:

- **Fail-closed discovery.** A route whose availability or pricing cannot be established is not
  eligible. Absence of evidence is not evidence of free.
- **Pricing verification.** `pricingVerified` and `validPricing` gate paid routes. Unknown price is
  never treated as free, and never treated as cheap.
- **Atomic budget reservation.** `store.reserve` / `store.settle` rather than read-then-write, so
  two concurrent requests cannot both observe the same remaining budget.
- **Per-provider cooldown.** Shared-quota providers cool down as a unit (`accountLimits`), so one
  user exhausting a free tier does not silently degrade every other user.
- **Privacy gate.** `X-Sensitive` requests are restricted to routes that do not retain data.
- **Per-user identity.** The backend sends the internal user id in `X-User-ID`; the router HMACs it
  with `USER_ID_HASH_SECRET` before using it as a ledger key, so stored spend records are opaque and
  cannot be joined back to an email without the secret.

The backend treats the router as the sole authority on *which* model answers. It forwards the
requested alias (`auto`, `auto-fast`, `auto-smart`, `auto-heavy`) and reports back whatever
`x-router-route` and `x-router-tier` come out.

## 5. Frontend

### 5.1 State

Two React contexts, one hook, no state library.

- `AuthContext` — token in `localStorage`, boot-time `/me` refresh, login/register/logout.
- `ThemeContext` — `ff_theme`, applies `data-theme` on `<html>`, updates `theme-color`.
- `useChat` — conversations, messages, models, usage, streaming state. Owns all side effects.

Every list mutation is optimistic with rollback: rename updates the sidebar immediately and reverts
if the PATCH fails; delete removes the row and restores it on error. The UI stays responsive without
ever showing a state the server does not agree with.

### 5.2 Markdown safety

`src/lib/markdown.jsx` converts Markdown into **React elements**, not an HTML string. There is no
`dangerouslySetInnerHTML` anywhere in the codebase, so there is no injection sink for model output.
Link hrefs pass through `safeHref`, which rejects `javascript:` and `data:` schemes. Fenced code
blocks are handed to `CodeBlock` for the copy button.

This is why `marked` and `DOMPurify` are not dependencies — fewer moving parts, and the sanitiser
cannot be misconfigured because it does not exist.

### 5.3 Streaming client

`streamChat()` in `src/lib/api.js` reads the response body with a `ReadableStream` reader, buffers
by newline, parses `data:` frames, and calls `onDelta` per token and `onMeta` for headers. An
`AbortController` is threaded through so the stop button cancels the network request rather than
just hiding the output.

### 5.4 Responsive strategy

Single column below 640 px with a drawer sidebar, two-pane from 900 px, three-zone (sidebar, chat,
optional panel) from 1100 px. Layout uses CSS Grid with `minmax()` rather than fixed widths, so the
tablet range does not need its own breakpoint set.

## 6. PWA

`public/sw.js` is hand-written, not generated by a plugin, because the caching rules matter:

| Request | Strategy | Why |
|---|---|---|
| Navigation | network-first, offline shell fallback | Users must see fresh app code, but still get a shell offline |
| Static assets (`/assets/*`, icons) | cache-first | Immutable, hashed filenames |
| `/api/*` | **never cached** | Chat content is private and must not land in the Cache API |
| Everything else | network, no cache | Conservative default |

Updates use `SKIP_WAITING` + `clients.claim()`. Registration happens only in production builds so
the dev server is never shadowed by a stale worker.

## 7. Desktop

Tauri 2 wraps the same built frontend. The shell adds nothing to app logic — its job is a native
window, native installers, and a CSP that does not exist in a plain browser tab.

Because the packaged app has no origin-bound backend, the API base URL is runtime-configurable
(Settings → Connection, stored in `localStorage` under `ff_api_base`). The same mechanism makes
self-hosted PWA deployments work without a rebuild.

`tauri.conf.json` declares `msi`, `dmg`, `appimage`, `deb`, `rpm`. **No installer has been built in
this workspace** — no Rust toolchain was available. See `WORKBUDDY-EXECUTION-REPORT.md` §6.

## 8. Deployment topology

### Development

`docker-compose.yml` — five services, every published port bound to `127.0.0.1`:

| Service | Port | Notes |
|---|---|---|
| `app-db` | internal | postgres:17-alpine, named volume |
| `router-db` | internal | separate instance |
| `router` | `expose` only | `read_only`, tmpfs `/tmp`, `no-new-privileges` |
| `backend` | `127.0.0.1:3001` | runs migrations, then serves |
| `frontend` | `127.0.0.1:5173` | nginx, proxies `/api` to backend |

### Production

`docker-compose.prod.yml` removes the host ports from backend and router entirely; only Caddy is
published, on 80/443, terminating TLS with automatic certificates.

`deploy/Caddyfile` sets `flush_interval -1` on `/api/*`. Without it, Caddy buffers the SSE stream
and the chat appears to hang until the whole response is ready — the single most common way to
break this architecture.

## 9. Why these choices

| Decision | Reason |
|---|---|
| Router kept unmodified | It is the verified baseline; refactoring it would invalidate the guarantees it already tests for |
| `createApp({ pool })` factories | Makes integration tests exercise the real code path, not a parallel one |
| JWT + server-side sessions | Stateless verification for speed, revocability for logout. Neither alone is enough |
| Custom Markdown renderer | Removes an entire class of XSS and two dependencies |
| Two databases | Blast-radius containment between user data and spend data |
| Deferred writes in chat | An outage must not create history, and a retry must not create duplicates |
| `pg-mem` in tests | Real SQL without requiring a live server in CI |
| Portable SQL | Correlated subqueries and `::float8` casts were rewritten so the tested path is the deployed path |
