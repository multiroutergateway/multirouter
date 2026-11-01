# Troubleshooting

Organised by symptom. Every entry names the actual cause seen during development, not a generic
checklist.

---

## Startup

### `Error: JWT_SECRET is required` / `must be at least 32 characters`

`config.js` validates the secret at import time and refuses to start. This is intentional — a
backend running with a weak or default secret is worse than one that will not boot.

```bash
openssl rand -hex 32
```

Put the result in `.env` as `JWT_SECRET`. In production it must not match
`/^replace-|change-this|example|secret$/i`, or startup fails again with
`JWT_SECRET still looks like a placeholder value`.

### `Error: Missing required env var: DATABASE_URL`

`.env` is not being read, or the variable is empty. Check:

```bash
node -e "console.log(process.env.DATABASE_URL)"   # from the app directory
```

Note that `docker compose` reads `.env` from the directory containing the compose file, not from the
app subdirectory.

### `ECONNREFUSED 127.0.0.1:5432`

Postgres is not running, or is not reachable at that address.

```bash
docker compose ps app-db
docker compose logs app-db | tail -20
```

Inside a container, `localhost` is the container itself — use the service name (`app-db`) instead.

### `password authentication failed for user "freefirst"`

`APP_DB_PASSWORD` in `.env` does not match the password the volume was initialised with. Postgres
only applies `POSTGRES_PASSWORD` on first creation; changing `.env` afterwards has no effect on an
existing volume. Either use the original password, or destroy and re-create the volume
(**destroys all data** — confirm first).

### Migrations appear to hang

`migrate.js` takes `pg_advisory_lock(918273645)`. If another migrator crashed while holding it, the
lock is released when that connection dies — but a hung container may still hold it.

```bash
docker compose exec app-db psql -U freefirst -d freefirst_app \
  -c "select pid, state, query from pg_stat_activity where query like '%advisory%';"
```

Terminate the stale backend with `pg_terminate_backend(pid)` if it is genuinely dead.

---

## Authentication

### Register returns `403 registration_disabled`

`ALLOW_REGISTRATION` must be the literal string `true`. `1`, `yes`, `TRUE` all disable it.

### Register returns `400 weak_password`

`PASSWORD_MIN_LENGTH` defaults to **12**. Lower it in `.env` if you genuinely need shorter passwords
for a local test account, but do not lower it in production.

### Login succeeds but the next request returns `401 unauthorized`

The token was issued, then the session row was revoked or deleted. Common causes:

- `JWT_SECRET` changed between issuing and using the token (a restart with a new secret invalidates
  everything — that is the intended effect).
- The `sessions` table was restored from a backup that predates the login.
- The token expired (`JWT_TTL`, default `12h`).

Verify with a fresh login:

```bash
curl -s -X POST http://localhost:3001/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"..."}' | head -c 200
```

### Admin panel is missing

`role` is assigned at **registration** from `ADMIN_EMAILS`. Adding your email afterwards does not
promote an existing account. Either promote it through the API as an existing admin, or update the
row directly:

```sql
UPDATE app_users SET role = 'admin' WHERE email = 'you@example.com';
```

Log out and back in so the new `/me` response is fetched.

### `429` on login after a few attempts

`AUTH_RATE_MAX` defaults to 20 per 15 minutes. Wait, or raise it for development. Do not disable the
limiter — it is the only brute-force protection.

---

## Chat

### The reply appears all at once instead of streaming

A proxy is buffering the SSE stream. In order of likelihood:

1. **Caddy** — `deploy/Caddyfile` must have `flush_interval -1` on the `/api/*` route.
2. **nginx** — `apps/frontend/nginx.conf` must have `proxy_buffering off` for `/api/`.
3. **curl** — add `-N`, otherwise curl buffers and it looks like the server is at fault.

Isolate it:

```bash
curl -N -X POST http://localhost:3001/api/chat \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

Streams directly but not through the proxy → the proxy config is the problem, not the backend.

### `502 gateway_error` on every message

The router has no eligible route. In order:

```bash
curl -s http://localhost:20128/health
docker compose logs router | tail -50
```

Most common causes:

- No provider API keys configured (`GROQ_API_KEYS`, `GEMINI_API_KEYS`, … all empty).
- Discovery has not run yet. Trigger it from Settings → Admin, or
  `POST /api/admin/gateway/discover`.
- Every route is in cooldown after a burst of `429`s from a provider. Wait for the cooldown window.
- Pricing for a candidate route could not be verified — the router fails closed by design. This is
  correct behaviour, not a bug; it means the router refuses to guess that a model is free.

### `503 ai_not_configured`

`AI_GATEWAY_URL` or `AI_GATEWAY_KEY` is empty. Both are required for chat. `/api/models` still works
and reports `gatewayOnline: false`.

### `409 request_in_flight`

A previous request on the same conversation never released its lock. The lock is an in-memory
`Set` keyed by `userId:conversationId`. It is released when the request completes, errors, or the
client disconnects. A lock survives only if the process is mid-request, so:

- If it persists for more than the gateway timeout (`AI_TIMEOUT_MS`, default 120 s), restart the
  backend. The lock does not survive a restart.
- If it happens on the *first* message of a new chat, the key is `userId:new`, so a stuck earlier
  new-chat request is the cause.

Do not "fix" this by removing the lock. It is what prevents double billing on a double-click.

### Message stops mid-sentence and history shows `finish_reason: aborted`

Expected. The client disconnected (or pressed stop), the upstream request was aborted, and the
partial content was persisted deliberately so the history matches what was billed.

### `413 message_too_large`

Total characters across `messages` exceeds 48 000, or a single message exceeds 16 000. Trim the
history client-side or raise `config.limits` deliberately — the caps exist to bound provider cost.

### The model list is empty or only shows four entries

By design. The product surface is four aliases (`auto`, `auto-fast`, `auto-smart`, `auto-heavy`).
Discovered router route ids are returned **only to admins**. If you are an admin and still see four,
the router is unreachable — check `gatewayOnline` in the same response.

---

## Frontend

### Blank page after deploy

Almost always a base-path or cache problem.

```bash
docker compose logs frontend | tail -30
```

Hard-reload with the service worker unregistered (DevTools → Application → Service Workers →
Unregister), or bump the cache name in `public/sw.js` from `freefirst-shell-v2` to `-v3` and rebuild.

### Requests go to the wrong host

The API base is resolved as: `localStorage.ff_api_base` → `VITE_API_BASE` → same-origin.

```js
localStorage.getItem('ff_api_base')   // in the browser console
```

Reset it from Settings → Connection → **Reset**, or:

```js
localStorage.removeItem('ff_api_base')
```

For a container deployment built with an empty `VITE_API_BASE`, same-origin is correct and nginx
proxies `/api` to the backend. A non-empty value pointing at `http://localhost:3001` will break every
remote user's browser, because *their* localhost is not your server.

### CORS errors

`CORS_ORIGIN` must match the browser's `Origin` exactly — scheme, host, port, no trailing slash.
Multiple origins are comma-separated.

```
CORS_ORIGIN=https://app.example.com,https://staging.example.com
```

`*` is not a valid value here; the middleware uses an allowlist.

### Desktop app cannot reach the backend

The packaged app has no origin. On first launch, open **Settings → Connection**, enter the full API
base URL (`https://app.example.com`), and press **Test**. Then reload.

If the CSP blocks it, the console shows a `connect-src` violation. `tauri.conf.json` allows `https:`
and `http://localhost:3001`; an `http://` non-localhost backend will be blocked, correctly.

---

## Tests

### `npm test` passes but hangs for ~60 seconds at the end

`express-rate-limit` keeps a store timer alive after the tests finish. The test script already passes
`--test-force-exit`; if you invoked `node --test` manually without it, this is expected.

### Backend suite takes minutes

`BCRYPT_ROUNDS` is not pinned. `test/env.js` sets it to `4`. At the production default of 12 the
suite takes roughly 150 seconds instead of ~18. Check that `test/env.js` is still being imported
first in each test file.

### A `429` appears in an unrelated test

Some test set `CHAT_RATE_MAX` and leaked it into a shared process. That is exactly why
`ratelimit.test.js` runs in its own file — env overrides are process-wide. Do not merge rate-limit
tests back into a shared file.

### `column "c.id" does not exist` or `type "float8" does not exist`

`pg-mem` does not support every Postgres construct. Correlated subqueries in the `SELECT` list and
`::float8` casts both fail. Rewrite to `LEFT JOIN ... GROUP BY` and convert with `Number()` in JS.
This is a portability constraint of the test double, and the resulting SQL is also more portable in
production.

---

## Docker

### `Set APP_DB_PASSWORD in .env` and the stack refuses to start

Working as designed. The compose file uses `${VAR:?message}` for every critical secret so a
half-configured stack cannot come up. Fill in the variable.

### Backend container exits immediately

```bash
docker compose logs backend
```

The start command is `node src/migrate.js && node src/server.js`. A migration failure stops the
container before the server starts — read the migration error, not the server error.

### `docker compose up` rebuilds everything every time

Expected when build args change. `VITE_API_BASE` is a build arg for the frontend, so changing it
invalidates that layer. Set it once in `.env`.

### Port already in use

```bash
# Windows
netstat -ano | findstr :3001
# Linux / macOS
lsof -i :3001
```

The dev compose file binds `127.0.0.1:3001` and `127.0.0.1:5173`; a local `npm run dev:backend` will
collide with the container.

---

## Data

### A conversation belongs to the wrong user

It should be impossible — every query filters on `user_id`. If you see it, treat it as a security
bug and stop: capture the request, the query, and the row, then investigate before doing anything
else. Do not "fix" it by loosening a filter.

### `cost_usd` is non-zero on a free-only deployment

The router selected a paid route. Check `/api/admin/gateway/stats` for the route list, and confirm
the price table is current. A stale table can mark a route as free when it no longer is. The router
fails closed on *unknown* pricing, but it cannot detect a price change it has not re-discovered.

### Messages are missing after a restart

They should not be — messages are persisted before the response completes. If a restart happened
mid-stream, the partial message is written with `finish_reason: 'aborted'` on the next request
completion, not lost. If messages are genuinely absent, check that the backend is pointing at the
database you think it is:

```bash
docker compose exec backend node -e "console.log(process.env.DATABASE_URL)"
```

---

## Getting more detail

Set `LOG_LEVEL=debug` in `.env` and restart the backend. Debug logs include the request path and
timing. They do **not** include message content, tokens, or keys — the redaction in `logger.js`
applies at every level.

If a problem is not covered here, capture:

1. the exact request (method, path, body shape — not real user content),
2. the response status and `error` code,
3. the matching backend log line,
4. `docker compose ps` output.

That set is usually enough to identify the cause without reproducing it.
