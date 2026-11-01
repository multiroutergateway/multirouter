# Monitoring

What to watch, what "normal" looks like, and what to do when a signal moves.

## 1. Health endpoints

| Endpoint | Auth | Meaning |
|---|---|---|
| `GET /health` (backend, :3001) | none | Process is alive. No database check. |
| `GET /ready` (backend) | none | `SELECT 1` succeeded. `503` means the database is unreachable. |
| `GET /health` (router, :20128) | none | Router process is alive. |
| `GET /ready` (router) | none | Router can reach its database. |

`/health` says the process is running; `/ready` says it can serve. Alert on `/ready` — a process
that is up but cannot reach Postgres will happily return `500` to every request while `/health`
stays green.

```bash
curl -fsS http://127.0.0.1:3001/health  && echo ok
curl -fsS http://127.0.0.1:3001/ready   && echo ready
curl -fsS http://127.0.0.1:20128/health && echo router-ok
```

From outside the network, only the public origin is reachable:

```bash
curl -fsS https://app.example.com/api/models -o /dev/null -w '%{http_code}\n'   # 401 = healthy
```

A `401` here is the **good** outcome: the proxy reached the backend and the backend enforced auth.
A `502` or a timeout means the chain is broken.

## 2. Container state

```bash
docker compose -f docker-compose.prod.yml ps
docker stats --no-stream
docker compose -f docker-compose.prod.yml logs --tail=100 backend
```

Expected steady state: five services `Up`, backend RSS well under 200 MB, router under 150 MB.
Anything climbing steadily is a leak — restart the container and investigate, do not ignore it.

## 3. Logs

Both services emit single-line JSON. The backend's `logger.js` redacts `password`, `token`,
`authorization`, `apiKey`, `secret` before writing, so logs are safe to ship off-box — but treat
them as sensitive anyway, because they contain user ids and paths.

```bash
# Errors only
docker compose -f docker-compose.prod.yml logs backend | grep '"level":"error"'

# Slow or failing gateway calls
docker compose -f docker-compose.prod.yml logs backend | grep -E 'gateway|request_failed'

# Registration and login events
docker compose -f docker-compose.prod.yml logs backend | grep -E 'user_registered|user_login'
```

Events worth alerting on:

| Event | Meaning | Action |
|---|---|---|
| `request_failed` with `status >= 500` | Unhandled error | Inspect the message; it is logged, the client only saw a generic string |
| `gateway_unreachable` | Router is down or the URL is wrong | Check `docker compose ps router` and `AI_GATEWAY_URL` |
| `gateway_timeout` | Provider is slow | Check the router's radar; a slow provider should be cooling down automatically |
| `rate_limited` (429) repeated | A user or the whole client is over quota | Check `USER_RATE_LIMIT_RPM` and whether one account is looping |

Log rotation is configured in `docker-compose.prod.yml` (`max-size` / `max-file` per service). If
you run outside Compose, configure the same in `/etc/docker/daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
```

## 4. Admin surface

The backend exposes the router's admin data behind the app's own admin role — the router admin key
never leaves the server.

```bash
TOKEN=<admin jwt>

curl -s -H "authorization: Bearer $TOKEN" https://app.example.com/api/admin/status
curl -s -H "authorization: Bearer $TOKEN" https://app.example.com/api/admin/gateway/stats
curl -s -H "authorization: Bearer $TOKEN" https://app.example.com/api/admin/gateway/radar
```

`/api/admin/gateway/stats` is the primary cost signal: daily spend per scope, route usage, key
status, and which routes are active versus cooling. If spend is climbing while all traffic is on
free routes, the price table is wrong and paid routes are being selected — investigate before the
daily cap is reached, not after.

The same data is in the UI under Settings → Admin.

## 5. Database queries

```sql
-- Messages per day, last 14 days
SELECT date_trunc('day', created_at)::date AS day, count(*) AS messages
FROM messages
WHERE created_at > now() - interval '14 days'
GROUP BY 1 ORDER BY 1 DESC;

-- Top users by message volume
SELECT u.email, count(m.id) AS messages
FROM app_users u
JOIN conversations c ON c.user_id = u.id
JOIN messages m ON m.conversation_id = c.id
GROUP BY u.email ORDER BY messages DESC LIMIT 10;

-- Recorded cost per day
SELECT date_trunc('day', created_at)::date AS day,
       sum(cost_usd) AS cost,
       count(*) FILTER (WHERE tier <> 'free') AS non_free_messages
FROM messages
WHERE role = 'assistant' AND created_at > now() - interval '30 days'
GROUP BY 1 ORDER BY 1 DESC;

-- Which routes are actually answering
SELECT route_id, tier, count(*) AS messages, sum(cost_usd) AS cost
FROM messages
WHERE role = 'assistant' AND created_at > now() - interval '7 days'
GROUP BY route_id, tier ORDER BY messages DESC;

-- Table sizes
SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC;

-- Sessions that should have been pruned
SELECT count(*) FROM sessions WHERE expires_at < now() AND revoked_at IS NULL;
```

The `non_free_messages` column is the one to watch. A non-zero value on a deployment that is supposed
to be free-only means the router is selecting paid routes and the pricing gate is not doing what you
think it is.

## 6. Alerts

There is no built-in alerting. A cron-driven script is enough for a single-VPS deployment.

```bash
#!/usr/bin/env bash
# /opt/freefirst-ai/scripts/healthcheck.sh
set -uo pipefail
FAIL=0

curl -fsS --max-time 5 http://127.0.0.1:3001/ready >/dev/null || { echo "backend not ready"; FAIL=1; }
curl -fsS --max-time 5 http://127.0.0.1:20128/ready >/dev/null || { echo "router not ready"; FAIL=1; }

USAGE=$(df --output=pcent / | tail -1 | tr -dc '0-9')
[ "$USAGE" -gt 85 ] && { echo "disk ${USAGE}% full"; FAIL=1; }

if [ "$FAIL" -ne 0 ]; then
  # Replace with your notification path: mail, curl to a webhook, ntfy, etc.
  echo "$(date -Is) HEALTHCHECK FAILED" | tee -a /var/log/freefirst-health.log
fi
exit "$FAIL"
```

```cron
*/5 * * * * /opt/freefirst-ai/scripts/healthcheck.sh
```

Budget alert, using the app's admin API rather than the router directly:

```bash
#!/usr/bin/env bash
# /opt/freefirst-ai/scripts/check-budget.sh
TOKEN="$ADMIN_TOKEN"
STATS=$(curl -fsS -H "authorization: Bearer $TOKEN" \
  https://app.example.com/api/admin/gateway/stats)

SPEND=$(printf '%s' "$STATS" | grep -o '"spend_usd":[0-9.]*' | head -1 | cut -d: -f2)
CAP=$(printf '%s' "$STATS" | grep -o '"global_daily_usd":[0-9.]*' | head -1 | cut -d: -f2)

if [ -n "$SPEND" ] && [ -n "$CAP" ]; then
  awk -v s="$SPEND" -v c="$CAP" 'BEGIN { exit !(c > 0 && s > c * 0.8) }' && \
    echo "$(date -Is) WARNING spend $SPEND approaching cap $CAP"
fi
```

The exact JSON keys depend on the router version — print `$STATS` once and adjust the `grep`
patterns to what you actually see rather than trusting this snippet blindly.

Recommended tools: **Uptime Kuma** (self-hosted uptime), **Grafana + Prometheus** (metrics),
**Sentry** (error tracking). All optional for a single-instance deployment.

## 7. Performance

### Connection pool

`DB_POOL_SIZE` (default 10) per backend replica. Postgres `max_connections` defaults to 100, so
**ten replicas at the default pool size will exhaust it**. Either raise `max_connections`, add
PgBouncer, or lower the pool size as you scale out.

### Slow queries

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

SELECT query, mean_exec_time, calls
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
```

The indexes in `003_usage_indexes.sql` cover the usage aggregation and the conversation list. If the
sidebar gets slow, check that `conversations (user_id, updated_at DESC)` exists.

### Streaming latency

If time-to-first-token degrades but total time is fine, the cause is usually proxy buffering, not
the database. Confirm with `curl -N` against the backend directly: if that streams and the browser
does not, it is Caddy or nginx.

## 8. What is not instrumented

Be aware of the gaps before you rely on this page:

- No Prometheus metrics endpoint. `/api/admin/gateway/stats` is a snapshot, not a time series.
- No distributed tracing. A slow request is diagnosed from logs, not spans.
- No error aggregation. `request_failed` lines must be read manually or shipped to a log service.
- No per-route latency tracking on the backend side; the router's radar is the closest thing.
- No alerting on admin actions, because there is no audit log yet.
