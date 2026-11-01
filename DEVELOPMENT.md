# Development

## 1. Layout

```
freefirst-ai/
├── apps/
│   ├── backend/          Express API — auth, history, chat relay, usage, admin
│   │   ├── src/          config, auth, db, logger, middleware, gateway, app, server, migrate
│   │   │   └── routes/   auth, conversations, chat, models, usage, admin
│   │   ├── migrations/   001_init · 002_sessions_roles · 003_usage_indexes
│   │   └── test/         integration tests (pg-mem + real HTTP)
│   ├── frontend/         React 18 + Vite 6
│   │   ├── src/
│   │   │   ├── components/   15 components
│   │   │   ├── context/      AuthContext, ThemeContext
│   │   │   ├── hooks/        useChat
│   │   │   └── lib/          api, markdown, format
│   │   ├── public/       manifest, sw.js, icons
│   │   └── test/         unit tests
│   └── desktop/          Tauri 2 shell
├── services/
│   └── router/           FreeFirst Router v3.2 — unmodified baseline
├── deploy/               Caddyfile
├── docs/                 this documentation set
├── legacy/               superseded material, kept for reference
├── docker-compose.yml    dev stack
└── docker-compose.prod.yml
```

## 2. Commands

| Command | Does |
|---|---|
| `npm install` | Install all workspaces |
| `npm test` | Backend → frontend → router, in sequence |
| `npm run test:backend` | 31 integration tests |
| `npm run test:frontend` | 9 unit tests |
| `npm run test:router` | 4 upstream router suites |
| `npm run test:e2e` | Full chain against a real router + local fake provider |
| `npm run build` | Vite production build |
| `npm run check` | Parse-check 22 backend + router source files |
| `npm run check:compose` | 60 structural assertions on the compose files and Dockerfiles |
| `npm run migrate` | Apply pending migrations (needs only `DATABASE_URL`) |
| `npm run dev:backend` | `node --watch`, port 3001 |
| `npm run dev:frontend` | Vite dev server, port 5173, proxies `/api` |
| `npm run dev:router` | Router, port 20128 |

### 2.1 Running against real PostgreSQL

By default the backend suite runs on `pg-mem`. Point `TEST_DATABASE_URL` at a real server to run
the identical suite against real PostgreSQL instead:

```bash
TEST_DATABASE_URL=postgresql://freefirst:devpass@127.0.0.1:5432/freefirst_app \
  npm run test:backend
```

Each test file gets its own throwaway schema (`t_<12 hex>`, set via `options=-c search_path=…`) and
drops it on teardown, so the suite is safe to run against a database that already has data. The
schema name is never reused, so a crashed run cannot poison the next one.

The e2e suite uses the same idea for the router store:

```bash
E2E_PG_URL=postgresql://freefirst:devpass@127.0.0.1:5432/freefirst_router npm run test:e2e
```

Without `E2E_PG_URL` the four PgStore tests are reported as **skipped**, not as passed. Do not read a
green run without that variable as evidence that persistence works.

### 2.2 Compose validation without Docker

`npm run check:compose` parses `docker-compose.yml`, `docker-compose.prod.yml` and every Dockerfile
and asserts 60 structural properties (no host port on the databases, healthchecks present, env vars
required rather than defaulted, no secrets baked into images, `.dockerignore` present). It is a
substitute for `docker compose config`, **not** an equivalent: it cannot catch an invalid image tag,
a broken build context, or a runtime health-transition problem. Those still need a Docker host.


The backend loads `.env` automatically (`src/loadEnv.js`), so `npm run dev:backend` and `npm run
migrate` work with no exported variables. The router is the unmodified v3.1/v3.2 baseline and reads
its environment directly — either export the variables in your shell, or run it through Docker
Compose, which injects them. On Windows Git Bash:

```bash
set -a; source .env; set +a
npm run dev:router
```

## 3. Backend conventions

### 3.1 Everything is a factory

No module reaches for a global pool or a global config value that tests cannot override.

```js
export function createConversationsRouter(pool, requireAuth) {
  const router = Router();
  router.use(requireAuth);
  router.get('/', asyncHandler(async (req, res) => { /* ... */ }));
  return router;
}
```

If you need a new dependency, add it as a parameter and thread it through `app.js`. Do not import
`db.js` directly from a route.

### 3.2 Errors

Throw `HttpError(status, code, message)`. Never build an error response by hand — `errorHandler`
owns the envelope, and it is the only place that decides what a `5xx` may reveal.

```js
throw new HttpError(404, 'conversation_not_found', 'Percakapan tidak ditemukan.');
```

Every async handler is wrapped in `asyncHandler` so a rejected promise cannot become an unhandled
rejection.

### 3.3 Validation

Declare a Zod schema at the top of the route file and pass it to `validate()`:

```js
const renameSchema = z.object({ title: z.string().trim().min(1).max(120) });
router.patch('/:id', validate(renameSchema), asyncHandler(async (req, res) => { /* ... */ }));
```

`validate()` replaces `req.body` with the parsed value. Do not re-parse inside the handler.

### 3.4 SQL

- Always parameterised. No exceptions, including `LIMIT` (use `$${params.length}`).
- Always scope by `user_id` for user-owned tables.
- Prefer `LEFT JOIN ... GROUP BY` over correlated subqueries. The test database (`pg-mem`) rejects
  some correlated forms, and keeping the SQL portable means the tested path is the deployed path.
- Avoid Postgres-specific casts in aggregate queries (`::float8`, `::bigint`); convert with
  `Number()` in JS instead. This was a real failure during development, not a stylistic preference.

### 3.5 Logging

```js
log.info('event_name', { userId, count });
```

`logger.js` redacts known-sensitive keys. Pass ids and counts, never message content, tokens, or
email addresses in bulk.

## 4. Adding a migration

1. Create `apps/backend/migrations/00N_name.sql`.
2. Write idempotent-ish DDL where practical (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT
   EXISTS`).
3. Run `npm run migrate`. The runner records the filename in `schema_migrations` inside an advisory
   lock, so it applies exactly once even with concurrent starts.
4. Add a test that exercises the new column through the API, not by querying the schema.

Never edit a migration that has already been applied anywhere. Add a new one.

## 5. Frontend conventions

### 5.1 Data flow

All network access goes through `src/lib/api.js`. Components do not call `fetch` directly.

State lives in `useChat` (chat domain) or a context (auth, theme). If a new feature needs shared
state, extend `useChat` first — do not add a state library for one screen.

### 5.2 Mutations

Follow the existing optimistic pattern:

```js
setConversations((list) => list.map((c) => (c.id === id ? { ...c, title } : c)));
try {
  await api.conversations.rename(id, title);
} catch (err) {
  setConversations(previous);   // roll back
  showToast(err.message);
}
```

The UI must never end up showing a state the server rejected.

### 5.3 Markdown

Never introduce `dangerouslySetInnerHTML`. If a new construct is needed, add a block or inline case
to `src/lib/markdown.jsx` returning React elements. New link targets must go through `safeHref`.

### 5.4 Styling

`src/styles.css` is one file with CSS custom properties for both themes. Add variables under
`:root` and `[data-theme="dark"]` rather than hard-coding colours. Breakpoints are 1100 / 900 / 640
px; keep new components inside those steps instead of inventing new ones.

### 5.5 Adding a component

1. Create `src/components/Thing.jsx`.
2. Take props, no global reads.
3. Use existing class conventions from `styles.css`.
4. If it fetches, go through `api.js` and handle the error path explicitly — a spinner that never
   resolves is a bug, not a loading state.

## 6. How the tests work

### 6.1 Backend

`test/helpers.js` builds a real app over `pg-mem`:

```js
const { app, close, pool } = await makeTestApp();
```

It applies the real migrations, starts an HTTP server on an ephemeral port, and returns helpers
(`jsonRequest`, `registerUser`, `installFakeGateway`, `sseResponse`). Tests hit it with `fetch`.

The fake gateway returns real SSE frames, so the streaming path — including frame parsing and
persistence — is genuinely exercised.

Two rules that keep this suite usable:

- **Pin bcrypt cost.** `test/env.js` sets `BCRYPT_ROUNDS=4`. At cost 12 the suite takes ~150 s.
- **Isolate env overrides.** `ratelimit.test.js` sets `CHAT_RATE_MAX=2` and therefore runs in its
  own process. Do not merge it back into a shared file; doing so previously caused a spurious `429`
  in an unrelated test.

`--test-force-exit` is required: `express-rate-limit` keeps a store timer alive, and without the
flag the suite hangs for ~60 s after every test has already passed.

### 6.2 Frontend

Pure-function unit tests on `src/lib/format.js`, plus `markdown-safety.test.js`, which checks that
`safeHref` rejects every non-`http(s)` scheme (including protocol-relative `//host`), that no source
file reaches for `dangerouslySetInnerHTML` / `innerHTML` / `document.write` / `eval`, and that no
risky Markdown dependency has been introduced. There is still no browser E2E suite — that is a known
gap (see `WORKBUDDY-EXECUTION-REPORT.md` §8).

### 6.3 Router

`test/run.mjs` injects `CLIENT_KEYS`, `ADMIN_KEY` and `USER_ID_HASH_SECRET`, then runs the four
upstream suites. It exists because the original suites assumed a POSIX shell; this runner works on
Windows too.

### 6.4 End-to-end (`test/e2e`)

Spawns the **real** router process and a local OpenAI-compatible fake provider, then drives the
backend over HTTP. Covers the full chain, stop-generation, 502 + retry, route fallback, budget
refusal, privacy gating and credential non-leakage.

Two things to know before editing it:

- The fake provider lives on port 20198, the router on 20199. Both are bound to `127.0.0.1`.
- The router is started with **no** `DATABASE_URL` (memory store) on purpose. PgStore persists
  cooldowns across runs, so a single failed attempt can cool a provider for 60 s and make an
  unrelated later test fail with `502`. Persistence is covered separately in `pgstore.test.js`.
  Do not "fix" this by pointing the router at a shared database.

`run.mjs` sets `AI_GATEWAY_URL` / `AI_GATEWAY_KEY` before the test modules are imported, because
`test/env.js` uses `??=` and a value set after import would be ignored.


## 7. Debugging streaming

The failure modes are specific and worth knowing:

| Symptom | Cause |
|---|---|
| Chat hangs, then dumps all text at once | A proxy is buffering. `flush_interval -1` in Caddy, `proxy_buffering off` in nginx |
| First token never arrives | Router has no eligible route — check `docker compose logs router` and `/api/admin/gateway/stats` |
| Text arrives, then `502` at the end | Gateway error mid-stream; the partial message is persisted with `finish_reason` from the last frame |
| `409 request_in_flight` persists | A previous request never released its lock — restart the backend; this is a per-process in-memory lock |
| `429 rate_limited` on the first message | `CHAT_RATE_MAX` is low, or the router's `USER_RATE_LIMIT_RPM` is exhausted |

To watch the raw stream:

```bash
curl -N -X POST http://localhost:3001/api/chat \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

`-N` disables curl buffering. If `curl -N` streams but the browser does not, the problem is in the
proxy layer, not the backend.

## 8. Before you commit

```bash
npm test
npm run build
git status          # confirm no .env, no key, no dist/
```

CI (`.github/workflows/ci.yml`) runs the same three suites plus `docker compose config` and a
Docker build, so a green local run is a good predictor — but the Docker steps only run in CI, not
here.
