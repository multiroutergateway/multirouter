# Security

This document states what is actually implemented, what is deliberately not, and what must be done
before public launch. It is written to be auditable: every claim maps to a file.

## 1. Threat model

| Asset | Attacker | Vector |
|---|---|---|
| Provider API keys (cost, quota theft) | Anyone with network access to the backend or router | Leaked env, exposed admin endpoint, bundle inspection |
| User conversations (privacy) | Another authenticated user | IDOR on `/api/conversations/:id` |
| Account (takeover) | Credential stuffing, token theft | Weak passwords, XSS, token in a readable store |
| Spend budget (financial) | Concurrent or repeated requests | Race on reservation, double submit |
| Server secrets (`ADMIN_KEY`, `USER_ID_HASH_SECRET`) | Compromised frontend | Accidental bundling, verbose error output |

Out of scope for this document: physical access, supply-chain compromise of npm, and provider-side
breaches.

## 2. Controls that are implemented

### 2.1 Secret containment

- The frontend bundle contains **no** secret. The only `VITE_*` variable is `VITE_API_BASE`, a URL.
- Provider API keys are read only by the router process.
- `ADMIN_KEY` and `USER_ID_HASH_SECRET` are router-side only. The backend holds a router *client*
  key, not the admin key, and never forwards either to a client.
- `logger.js` redacts `password`, `token`, `authorization`, `apiKey`, `secret`, and `api_key`
  before emitting JSON.
- `config.js` refuses to start if `JWT_SECRET` is missing, shorter than 32 characters, or (in
  production) still looks like a placeholder. A default-secret deployment cannot happen silently.
- `.env` is gitignored; `.env.example` contains only `CHANGE_ME` placeholders.

### 2.2 Authentication

- bcrypt hashing, cost configurable (`BCRYPT_ROUNDS`, default 12). Cost is lowered only in tests.
- Login performs a bcrypt comparison against a fixed dummy hash when the email is unknown, so
  response timing does not reveal account existence.
- JWT is HS256 with pinned `issuer` and `audience`, so a token minted for another service with the
  same secret is rejected.
- Every token carries a `jti`, recorded in `sessions`. `requireAuth` checks the session is present
  and not revoked — signature validity is not sufficient. This is what makes logout real.
- `POST /api/auth/logout` revokes one session; `/logout-all` revokes every session for the user.
- Sessions are pruned hourly and on demand, so the table does not grow without bound.

### 2.3 Authorization

- Every conversation, message, export and usage query filters on `user_id` taken from the verified
  token. No endpoint accepts a user id from the client as authority.
- Cross-user access returns `404`, not `403`, so the API does not confirm that an id exists.
- Admin routes are gated by `requireAdmin`; role changes are themselves admin-only.
- Discovered router route ids are returned only to admins.

### 2.4 Input handling

- Zod schemas on every mutating endpoint. Parsed output replaces `req.body`.
- Body size capped at 256 kB; messages at 40 per request, 16 000 characters each, 48 000 total.
- `role` in chat messages is restricted to `user` / `assistant` — no `system` role, so a client
  cannot inject instructions that outrank the router's policy.
- SQL uses parameterised queries throughout. No string interpolation of user input.

### 2.5 Output safety

- Markdown is rendered to React elements. There is no `dangerouslySetInnerHTML` in the codebase.
- Link hrefs are filtered by `safeHref`; `javascript:` and `data:` are rejected.
- Errors return a code and a message; stack traces and internal paths never reach the client.
  Upstream bodies appear only in non-production, truncated to 800 characters.

### 2.6 Abuse and cost control

- Three rate-limit buckets (auth, chat, general), keyed per user with an IP fallback.
- `validate: { trustProxy: false, xForwardedForHeader: false }` — a spoofed `X-Forwarded-For` cannot
  reset a counter.
- An in-flight lock per `userId:conversationId` returns `409` instead of billing a second
  completion for a double submit.
- The router enforces free-first selection, price verification, atomic budget reservation, and
  per-provider cooldown. Unknown pricing is not free.
- Per-user and per-client daily USD caps are enforced by the router, not by the UI.

### 2.7 Transport and headers

- helmet sets standard security headers.
- CORS is an explicit allowlist from `CORS_ORIGIN`.
- Production compose publishes only Caddy on 80/443; backend and router have no host ports.
- Router container runs `read_only`, with tmpfs `/tmp`, `no-new-privileges`.
- `deploy/Caddyfile` terminates TLS automatically and disables buffering for `/api/*`.

## 3. Known weaknesses

Full detail and remediation in `WORKBUDDY-EXECUTION-REPORT.md` §7.

| # | Weakness | Severity |
|---|---|---|
| 1 | Desktop CSP allows any `https:` connect target | Medium |
| 2 | JWT stored in `localStorage` (no XSS sink today, but no HttpOnly protection) | Medium |
| 3 | No refresh-token rotation | Low/Medium |
| 4 | Minimal password policy, no per-account lockout | Low |
| 5 | No email verification, no password reset | Low |
| 6 | Reported cost depends on router price table freshness | Low |
| 7 | In-flight lock is per-process (single-replica assumption) | Low |
| 8 | Rate limiting is in-memory (multiplies by replica count) | Low |
| 9 | No admin audit log | Low |

Items 7 and 8 are the reason this build should run as **one** backend replica until a shared store
is introduced. That constraint is real, not theoretical.

## 4. Before public launch

Ordered; the first block is blocking.

**Blocking**

- [ ] Run migrations against real PostgreSQL and re-run the backend suite against it.
- [ ] Verify `docker compose -f docker-compose.prod.yml config` and a real Caddy TLS handshake.
- [ ] Set `JWT_SECRET`, `ROUTER_CLIENT_KEYS`, `ROUTER_ADMIN_KEY`, `USER_ID_HASH_SECRET` to unique
      high-entropy values from a secret manager, never from a shell history.
- [ ] Confirm the router port is unreachable from the internet.
- [ ] Replace the `https:` allowance in the desktop CSP with an explicit allowlist, or bind it to
      the configured origin.
- [ ] Set provider-side spend limits as a second line of defence behind the router budget.

**Strongly recommended**

- [ ] Move the token to an `HttpOnly; Secure; SameSite=Strict` cookie with CSRF protection.
- [ ] Add refresh-token rotation with short access-token TTLs.
- [ ] Add per-account failed-login throttling and a breach-list check.
- [ ] Add email verification and a password reset flow.
- [ ] Move the in-flight lock to `pg_try_advisory_lock` and rate limiting to Redis before scaling
      past one replica.
- [ ] Add an `admin_audit` table written on every privileged mutation.
- [ ] Run `npm audit`, a container image scan, and a restore-from-backup drill.
- [ ] Review provider data-retention terms before routing sensitive content. A `X-Sensitive` flag is
      a routing constraint, not a contractual guarantee.

## 5. Reporting

This is a self-hosted project without a security contact yet. Before publishing, add a `SECURITY.md`
contact address at the repository root and a disclosure policy. Do not open a public issue for a
vulnerability.

## 6. Operator rules

1. Never commit `.env`, keys, or dumps. `.gitignore` covers them; verify with `git status` before
   every push.
2. Never paste a provider key into the browser console, a screenshot, or a chat message.
3. Rotate `JWT_SECRET` by deploying a new value; this invalidates all sessions, which is the
   intended effect.
4. Rotate a provider key at the provider, then update the router env and restart the router.
5. Treat `docker compose exec` on the database as a privileged action — it can read every user's
   data.
