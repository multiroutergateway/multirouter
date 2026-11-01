# Installation

Two paths: run it locally for development, or run the full stack in containers.

## 1. Requirements

| Tool | Version | Needed for |
|---|---|---|
| Node.js | 22 or newer | everything |
| npm | 10+ (ships with Node 22) | everything |
| PostgreSQL | 16 or 17 | the app database and the router database |
| Docker + Compose v2 | latest | container path only |
| Rust + cargo | 1.77+ | desktop builds only |

Check what you have:

```bash
node -v
npm -v
psql --version        # optional if you use Docker for Postgres
docker compose version
```

Node 22 is a hard requirement — the backend uses `node --test` and `node:test` features that are not
stable on older versions.

## 2. Local development

### 2.1 Install dependencies

From the repository root:

```bash
npm install
```

This installs all three workspaces (`apps/backend`, `apps/frontend`, `services/router`) via npm
workspaces. There is no separate install step per app.

### 2.2 Create the databases

If you have PostgreSQL locally:

```bash
createdb freefirst_app
createdb freefirst_router

psql -d freefirst_app -c "CREATE USER freefirst WITH PASSWORD 'dev-password';"
psql -d freefirst_app -c "GRANT ALL ON DATABASE freefirst_app TO freefirst;"
```

If you would rather not install PostgreSQL, use only the database services from the dev compose
file:

```bash
docker compose up -d app-db router-db
```

Then point `DATABASE_URL` at `localhost:5432` and use the passwords you set in `.env`
(`APP_DB_PASSWORD`, `ROUTER_DB_PASSWORD`).

### 2.3 Configure the environment

```bash
cp .env.example .env
```

Open `.env` and replace **every** `CHANGE_ME`. Generate secrets with:

```bash
openssl rand -hex 32
```

Minimum set for a working local run:

```dotenv
DATABASE_URL=postgres://freefirst:dev-password@localhost:5432/freefirst_app
JWT_SECRET=<64 hex chars>
ALLOW_REGISTRATION=true
PASSWORD_MIN_LENGTH=12
AI_GATEWAY_URL=http://127.0.0.1:20128
AI_GATEWAY_KEY=dev-client-key
AI_GATEWAY_ADMIN_KEY=<same value as ROUTER_ADMIN_KEY>
ROUTER_CLIENT_KEYS=dev=dev-client-key
ROUTER_ADMIN_KEY=<64 hex chars>
USER_ID_HASH_SECRET=<64 hex chars>
```

Notes that save time later:

- `ALLOW_REGISTRATION` must be the literal string `true`. Anything else disables registration.
- `ROUTER_CLIENT_KEYS` is `name=key` pairs, comma-separated. The `key` half must equal
  `AI_GATEWAY_KEY`.
- The backend refuses to boot if `JWT_SECRET` is missing, under 32 characters, or looks like a
  placeholder. That is intentional.
- Provider keys (`GROQ_API_KEYS`, `GEMINI_API_KEYS`, …) can stay empty. Without them the router has
  no routes and chat returns `502` — the rest of the app still works.

### 2.4 Run migrations

```bash
npm run migrate
```

Expected output lists each applied migration and exits 0. Re-running is safe: applied files are
recorded in `schema_migrations` and skipped.

### 2.5 Start the services

Three terminals, or use a process manager:

```bash
npm run dev:router     # http://localhost:20128
npm run dev:backend    # http://localhost:3001
npm run dev:frontend   # http://localhost:5173
```

Start order matters only in that the router should be up before the first chat request. The backend
does not crash if the router is down; `/api/models` reports `gatewayOnline: false`.

The backend reads `.env` automatically. The router does not — it is the unmodified v3.2 baseline and
takes its configuration from the environment. Export it before starting the router, or just use the
container stack, which injects it:

```bash
set -a; source .env; set +a   # bash
npm run dev:router
```

### 2.6 Create your account

Open <http://localhost:5173> and register. To get an admin account, put your email in `ADMIN_EMAILS`
in `.env` **before** registering — the role is assigned at registration time.

```dotenv
ADMIN_EMAILS=you@example.com
```

An existing account can also be promoted by an admin through
`PATCH /api/admin/users/:id/role`.

### 2.7 Verify

```bash
curl http://localhost:3001/health
# {"status":"ok","service":"freefirst-backend"}

curl http://localhost:3001/ready
# {"status":"ready"}   ← 503 here means the database is unreachable
```

Then send a message in the UI. If it fails with `502`, the router has no usable route — see
`TROUBLESHOOTING.md`.

## 3. Container stack

### 3.1 Prepare

```bash
cp .env.example .env
# fill in APP_DB_PASSWORD, ROUTER_DB_PASSWORD, JWT_SECRET,
# ROUTER_CLIENT_KEYS, ROUTER_ADMIN_KEY, USER_ID_HASH_SECRET, AI_GATEWAY_KEY
```

`docker-compose.yml` uses `${VAR:?message}` syntax for the critical values, so a missing variable
fails immediately with a readable message instead of starting a half-configured stack.

### 3.2 Start

```bash
docker compose up -d --build
docker compose ps
```

Migrations run automatically as part of the backend container's start command
(`node src/migrate.js && node src/server.js`).

### 3.3 Reach it

- Frontend: <http://localhost:5173>
- Backend: <http://localhost:3001> (bound to `127.0.0.1` only)

Both are bound to localhost on purpose. To expose the stack, put a TLS terminator in front — see
`DEPLOYMENT.md`.

### 3.4 Logs and shutdown

```bash
docker compose logs -f backend
docker compose down          # keeps volumes
docker compose down -v       # destroys both databases
```

## 4. Desktop build

Requires Rust and the platform toolchain (MSVC on Windows, Xcode CLI tools on macOS, `webkit2gtk`
and `libappindicator` on Linux).

```bash
npm --workspace apps/frontend run build
cd apps/desktop
npm install
npm run tauri build
```

Artifacts land in `apps/desktop/src-tauri/target/release/bundle/`.

The packaged app has no fixed backend, so on first launch open **Settings → Connection**, enter your
API base URL (e.g. `https://app.example.com`), and press **Test**.

**This has not been built in this workspace** — no Rust toolchain was available. Treat the commands
above as the intended path, not a verified one. See `WORKBUDDY-EXECUTION-REPORT.md` §6.

## 5. Verify your installation

```bash
npm run check   # parse-check 22 backend + router files
npm test        # backend 20, frontend 5, router 4 suites
npm run build   # vite production build
```

Both must exit 0. If `npm test` hangs at the end, you are on a Node version without
`--test-force-exit` support — see `TROUBLESHOOTING.md`.

## 6. What to change before real users

| Setting | Change to |
|---|---|
| `JWT_SECRET` | unique 64 hex chars from a secret manager |
| `ALLOW_REGISTRATION` | `false` if accounts are provisioned manually |
| `ADMIN_EMAILS` | your real admin address, set before registering |
| `CORS_ORIGIN` | your exact frontend origin, not `*` |
| `BCRYPT_ROUNDS` | 12 or higher in production |
| Provider keys | real keys with provider-side spend caps |
| `GLOBAL_DAILY_USD` / `CLIENT_DAILY_USD` | values you are willing to lose |

Full checklist: `SECURITY.md` §4.
