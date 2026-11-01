# API Reference

Base path: `/api`. All endpoints return JSON unless noted. The backend is mounted behind a reverse
proxy; the frontend calls it same-origin by default (`/api/...`).

**Source of truth:** this document is derived from `apps/backend/src/routes/*.js`. If the two ever
disagree, the code wins and this file is the bug.

---

## Conventions

### Authentication

Every endpoint except `/api/auth/register`, `/api/auth/login`, `/health` and `/ready` requires:

```
Authorization: Bearer <jwt>
```

The token is verified for signature, issuer, audience and expiry, and then its `jti` is checked
against the `sessions` table. A valid signature on a revoked session is still rejected with `401`.

### Error envelope

```json
{ "error": "machine_readable_code", "message": "Human readable, Indonesian" }
```

`message` is omitted only for `5xx`, where it is replaced by a generic string so internal details
never leak. Stack traces are never returned. In non-production only, a gateway `502` may include a
`detail` field with the first 800 characters of the upstream body.

### Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `invalid_credentials` | 401 | Wrong email or password |
| `unauthorized` | 401 | Missing, malformed, expired or revoked token |
| `forbidden` | 403 | Authenticated but not permitted (e.g. non-admin on `/api/admin`) |
| `registration_disabled` | 403 | `REGISTRATION_ENABLED=false` |
| `conversation_not_found` | 404 | Does not exist **or** belongs to another user |
| `email_exists` | 409 | Email already registered |
| `request_in_flight` | 409 | A previous message on this conversation is still streaming |
| `weak_password` | 400 | Fails the configured length policy |
| `invalid_messages` | 400 | Empty array, or no `user` message present |
| `invalid_model` | 400 | Model id longer than 120 chars |
| `rate_limited` | 429 | Chat quota for the window exhausted |
| `message_too_large` | 413 | Total characters across messages exceeds the cap |
| `gateway_error` | 502 | Router or provider failed |
| `invalid_gateway_response` | 502 | Upstream returned an unusable body |
| `internal_error` | 500 | Unhandled server error |

Ownership is never trusted from the client. A conversation belonging to another user returns `404`,
not `403`, so the endpoint does not confirm that the id exists.

### Rate limits

| Bucket | Default | Env |
|---|---|---|
| Auth (`/register`, `/login`) | 20 per 15 min | `AUTH_RATE_MAX` |
| Chat (`POST /api/chat`) | 20 per 60 s | `CHAT_RATE_MAX` |
| General API | 240 per 60 s | `API_RATE_MAX` |

Keyed per authenticated user, falling back to IP for unauthenticated routes. `trustProxy` is off, so
a spoofed `X-Forwarded-For` cannot reset the counter. Limits are in-memory per process — with N
replicas the effective limit is N× (see `SECURITY.md` §7.8).

### Request limits

| Limit | Value |
|---|---|
| JSON body | 256 kB |
| Messages per request | 40 |
| Characters per message | 16 000 |
| Characters per request | 48 000 |

---

## Health

### `GET /health`

No auth. Liveness only.

```json
{ "status": "ok", "service": "freefirst-backend" }
```

### `GET /ready`

No auth. Executes `SELECT 1` against the database. Returns `200` when ready, `503` otherwise.

---

## Auth

### `POST /api/auth/register`

```json
{
  "email": "user@example.com",
  "password": "at-least-min-length",
  "displayName": "Optional"
}
```

`email` is trimmed and lowercased. `displayName` max 80 chars. Password length is bounded by
`PASSWORD_MIN_LENGTH` (default **12**) and a fixed maximum of 128.

`201`:

```json
{
  "token": "eyJhbGciOi...",
  "expiresAt": "2026-11-02T10:00:00.000Z",
  "user": { "id": "uuid", "email": "...", "role": "user", "display_name": null, "created_at": "..." }
}
```

If the email appears in `ADMIN_EMAILS`, the account is created with `role: "admin"`.

Errors: `409 email_exists`, `400 weak_password`, `403 registration_disabled`.

### `POST /api/auth/login`

```json
{ "email": "user@example.com", "password": "..." }
```

`200` with the same shape as register. On an unknown email the server still performs a bcrypt
comparison against a fixed dummy hash, so response time does not reveal whether the account exists.

Errors: `401 invalid_credentials`.

### `GET /api/auth/me`

Returns the current account. Used on app boot to restore a session.

```json
{ "user": { "id": "uuid", "email": "...", "role": "user", "display_name": null, "created_at": "..." } }
```

### `POST /api/auth/logout`

Revokes the current session (`jti`). `204 No Content`. The token is unusable immediately, even
though it has not expired.

### `POST /api/auth/logout-all`

Revokes every session for the user. `200`:

```json
{ "revoked": 3 }
```

### `GET /api/auth/sessions`

```json
{
  "sessions": [
    { "jti": "...", "created_at": "...", "expires_at": "...", "revoked_at": null, "user_agent": "...", "ip_hash": "..." }
  ]
}
```

IPs are stored as a salted SHA-256 prefix, never in clear text.

---

## Conversations

All routes require auth and are scoped to the caller.

### `GET /api/conversations`

Query: `limit` (1–100, default 50), `before` (ISO datetime, keyset pagination on `updated_at`).

```json
{
  "conversations": [
    { "id": "uuid", "title": "...", "model": "auto", "created_at": "...", "updated_at": "...", "message_count": 4 }
  ]
}
```

Ordered by `updated_at DESC`.

### `POST /api/conversations`

```json
{ "title": "Optional, max 120", "model": "Optional, max 120" }
```

`201` with `{ "conversation": { id, title, model, created_at, updated_at } }`. Default title is
`"Percakapan baru"`.

### `GET /api/conversations/:id`

`{ "conversation": { id, title, model, created_at, updated_at } }` — `404` if not owned.

### `GET /api/conversations/:id/messages`

```json
{
  "messages": [
    {
      "id": "uuid", "role": "user", "content": "...", "model": "auto",
      "route_id": null, "tier": null, "tokens_in": null, "tokens_out": null,
      "cost_usd": null, "finish_reason": null, "created_at": "..."
    }
  ]
}
```

Ordered ascending by creation. `route_id` / `tier` are populated on assistant messages from the
router response headers; `finish_reason` may be `stop`, `length`, or `aborted`.

### `PATCH /api/conversations/:id`

```json
{ "title": "New title" }
```

`title` required, 1–120 chars. Returns the updated conversation.

### `DELETE /api/conversations/:id`

Deletes the conversation and, via `ON DELETE CASCADE`, its messages. `204`.

### `GET /api/conversations/:id/export`

Returns the full conversation as a JSON download (`Content-Disposition: attachment`). Contains
conversation metadata and every message.

---

## Chat

### `POST /api/chat`

The only streaming endpoint.

```json
{
  "conversationId": "uuid, optional — omitted means create a new conversation",
  "model": "auto",
  "stream": true,
  "messages": [
    { "role": "user", "content": "Hello" }
  ]
}
```

`role` is `user` or `assistant` only — there is no `system` role, so a client cannot inject
instructions that outrank the router's own policy.

#### Behaviour

1. If `conversationId` is given, ownership is verified **before** anything else happens.
2. An in-flight lock on `userId:conversationId` (or `userId:new`) rejects a second concurrent send
   with `409 request_in_flight`, preventing double billing on a double-click.
3. The request is forwarded to the router. **Nothing is written to the database yet.**
4. If the gateway fails, the lock is released and an error is returned — leaving no orphan
   conversation or half-written message.
5. Only once the gateway accepts the request is the conversation created (if new) and the user turn
   persisted. The title is derived from the first 60 characters of the user message.
6. The upstream stream is relayed to the client while being parsed, so the assistant message can be
   reconstructed and persisted when the stream ends.

#### Response headers

| Header | Meaning |
|---|---|
| `x-conversation-id` | The conversation, newly created or existing |
| `x-router-route` | The route the router actually chose |
| `x-router-tier` | `free` / `cheap` / `premium` |
| `x-accel-buffering: no` | Tells nginx/Caddy not to buffer the stream |

#### Streaming response (`stream: true`, default)

`Content-Type: text/event-stream`. Frames are standard OpenAI-shaped SSE:

```
data: {"choices":[{"delta":{"content":"Hel"}}]}

data: {"choices":[{"delta":{"content":"lo"}}]}

data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":5}}

data: [DONE]
```

If the client disconnects mid-stream, the upstream request is aborted, and the partial assistant
message is persisted with `finish_reason = 'aborted'` — so the user sees what was actually
generated and billed for.

#### Non-streaming response (`stream: false`)

```json
{
  "conversationId": "uuid",
  "messageId": "uuid",
  "reply": "...",
  "model": "resolved-model-id",
  "route": "route-id",
  "tier": "free",
  "usage": { "prompt_tokens": 12, "completion_tokens": 5 }
}
```

#### Errors

| Code | When |
|---|---|
| `404 conversation_not_found` | Id does not exist or is not yours |
| `409 request_in_flight` | Previous message still streaming |
| `429 rate_limited` | Chat bucket exhausted, or the router reported 429 |
| `413 message_too_large` | Over the character cap |
| `502 gateway_error` | Router/provider failure |
| `400 invalid_messages` | No user message in the array |

---

## Models

### `GET /api/models`

```json
{
  "models": [
    { "id": "auto", "name": "Auto · gratis dulu", "description": "...", "tier": "auto" },
    { "id": "auto-fast", "name": "Fast", "description": "...", "tier": "free" },
    { "id": "auto-smart", "name": "Smart", "description": "...", "tier": "free" },
    { "id": "auto-heavy", "name": "Heavy", "description": "...", "tier": "mixed" }
  ],
  "gatewayOnline": true
}
```

These four aliases are the product surface. **Route ids discovered from the router are returned only
to admins**, capped at 200, and carry no provider credentials — only identifiers that the router
already exposes on its own admin surface.

`gatewayOnline` is `false` when the router could not be reached; the list still returns so the UI
degrades gracefully.

---

## Usage

### `GET /api/usage`

```json
{
  "conversations": 7,
  "messages": { "user": 42, "assistant": 42, "total": 84 },
  "tokens": { "input": 18234, "output": 9102 },
  "costUsd": 0,
  "daily": [ { "day": "2026-10-17", "messages": 3, "tokensIn": 900, "tokensOut": 420, "costUsd": 0 } ],
  "byRoute": [ { "route_id": "fake/free-small", "tier": "free", "messages": 20 } ],
  "limits": {
    "chatPerMinute": 20,
    "maxMessagesPerRequest": 40,
    "maxCharsPerMessage": 16000,
    "maxTokensPerReply": 1600,
    "gatewayConfigured": true
  }
}
```

`daily` covers the last 14 days, **not** zero-filled — days with no messages are absent. Aggregation
for the daily series is done in JS over at most 5 000 rows so the SQL stays portable across Postgres
versions and the pg-mem test double.

`byRoute` counts assistant messages only and is capped at 10 routes.

`costUsd` reflects what the router reported. Free-tier routes show `0`; a non-zero value means a
paid route was actually used. Verified end to end in `apps/backend/test/e2e/router.test.js`.

---

## Admin

All routes require `role = 'admin'`; otherwise `403`.

| Endpoint | Purpose |
|---|---|
| `GET /api/admin/status` | Backend version, gateway reachability, user count |
| `GET /api/admin/gateway/stats` | Router stats passthrough |
| `GET /api/admin/gateway/discovered` | Discovered routes |
| `GET /api/admin/gateway/radar?refresh=1` | Provider radar |
| `POST /api/admin/gateway/discover` | Trigger a discovery run |
| `GET /api/admin/users?limit=&offset=` | User list with message counts |
| `PATCH /api/admin/users/:id/role` | `{ "role": "user" \| "admin" }` |

Admin responses pass through router data but never include provider API keys, `ADMIN_KEY`, or
`USER_ID_HASH_SECRET` — the backend does not hold those values in a form it could forward.

---

## Examples

Register and chat with `curl`:

```bash
BASE=http://localhost:3001

TOKEN=$(curl -s -X POST $BASE/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"demo@example.com","password":"demo-password-123"}' | jq -r .token)

curl -N -X POST $BASE/api/chat \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```

`-N` disables curl's buffering so the stream appears incrementally.

Fetch history:

```bash
curl -s $BASE/api/conversations -H "authorization: Bearer $TOKEN" | jq
```
