# Backup and Restore

Two databases need backing up, and they are not equally replaceable:

| Database | Contents | If lost |
|---|---|---|
| `freefirst_app` | users, sessions, conversations, messages | **Unrecoverable.** This is the product. |
| `freefirst_router` | route catalogue, spend ledger, reservations | Rebuildable, but you lose spend history and cooldowns, which can cause a budget overshoot |

Back up both. The app database is the one that matters, but a lost ledger means the router forgets
what has already been spent today.

Container and service names below match `docker-compose.prod.yml` (`app-db`, `router-db`). If you
run on a VPS without Docker, drop the `docker compose exec` wrapper and use `pg_dump` directly.

## 1. Manual backup

```bash
STAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p /opt/backups

docker compose -f docker-compose.prod.yml exec -T app-db \
  pg_dump -U freefirst -d freefirst_app -Fc \
  > /opt/backups/app_${STAMP}.dump

docker compose -f docker-compose.prod.yml exec -T router-db \
  pg_dump -U router -d freefirst_router -Fc \
  > /opt/backups/router_${STAMP}.dump
```

`-Fc` (custom format) is preferred over plain SQL: it compresses, and it lets `pg_restore` work
selectively instead of replaying the whole file.

A plain-SQL variant, if you need something readable:

```bash
docker compose -f docker-compose.prod.yml exec -T app-db \
  pg_dump -U freefirst -d freefirst_app | gzip > /opt/backups/app_${STAMP}.sql.gz
```

### Verify immediately

An unverified backup is not a backup.

```bash
ls -lh /opt/backups/app_${STAMP}.dump
docker compose -f docker-compose.prod.yml exec -T app-db \
  pg_restore --list < /opt/backups/app_${STAMP}.dump | head -20
```

The listing must include the tables `app_users`, `sessions`, `conversations`, `messages` and
`schema_migrations`. If it is empty or the file is a few hundred bytes, the dump failed silently —
check that the container is running and the credentials in `.env` are current.

## 2. Scheduled backup

Two options:

- **Shipped script:** `node scripts/backup.mjs` (plain-SQL + gzip, argv-based `pg_dump`, retention,
  manifest, failure detection). Run it on a host that has `pg_dump` on `PATH`.
- **Docker wrapper:** the shell snippet below runs `pg_dump -Fc` *inside* the database container
  and writes a custom-format archive. Install it at `/usr/local/bin/freefirst-backup.sh` — **not**
  in the repo's `scripts/` directory, which contains `backup.mjs`.

`/usr/local/bin/freefirst-backup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR=/opt/backups
COMPOSE=/opt/freefirst-ai/docker-compose.prod.yml
STAMP=$(date +%Y%m%d_%H%M%S)
RETAIN_DAYS=30

mkdir -p "$BACKUP_DIR"

docker compose -f "$COMPOSE" exec -T app-db \
  pg_dump -U freefirst -d freefirst_app -Fc > "$BACKUP_DIR/app_${STAMP}.dump"

docker compose -f "$COMPOSE" exec -T router-db \
  pg_dump -U router -d freefirst_router -Fc > "$BACKUP_DIR/router_${STAMP}.dump"

# Fail loudly if a dump is implausibly small.
for f in "$BACKUP_DIR/app_${STAMP}.dump" "$BACKUP_DIR/router_${STAMP}.dump"; do
  if [ "$(stat -c%s "$f")" -lt 1024 ]; then
    echo "BACKUP FAILED: $f is too small" >&2
    exit 1
  fi
done

find "$BACKUP_DIR" -name '*.dump' -mtime +$RETAIN_DAYS -delete

echo "$(date -Is) backup ok: app_${STAMP}.dump router_${STAMP}.dump"
```

```bash
chmod +x /usr/local/bin/freefirst-backup.sh
sudo crontab -e
```

```cron
0 2 * * * /usr/local/bin/freefirst-backup.sh >> /var/log/freefirst-backup.log 2>&1
```

Or, using the shipped script directly (host has `pg_dump`):

```cron
0 2 * * * cd /opt/freefirst-ai && APP_DATABASE_URL="$APP_DATABASE_URL" ROUTER_DATABASE_URL="$ROUTER_DATABASE_URL" BACKUP_DIR=/opt/backups /usr/bin/node scripts/backup.mjs >> /var/log/freefirst-backup.log 2>&1
```

The size check matters more than it looks. A cron job that "succeeds" while writing an empty file
is the classic way to discover you have no backups only when you need one.

## 3. Offsite copy

A backup on the same disk as the database is not disaster recovery.

```bash
sudo apt install -y rclone
rclone config          # add an S3-compatible or remote target
```

```bash
rclone sync /opt/backups remote:freefirst-backups --max-age 40d
```

Add it to the cron job after the dump step, or run it nightly. Encrypt at rest if the remote is not
trusted:

```bash
gpg --symmetric --cipher-algo AES256 /opt/backups/app_${STAMP}.dump
```

Store the passphrase somewhere that is **not** the server being backed up.

## 4. Restore

> **Destructive action.** Restoring overwrites live data. Confirm with the user before executing,
> and take a fresh dump of the current state first — even a corrupt database may contain the rows
> you are about to lose.

### 4.1 Stop the writers

```bash
docker compose -f docker-compose.prod.yml stop backend
```

The router can keep running; it writes only to its own database. Stop it too if you are restoring
the router database.

### 4.2 Snapshot the current state

```bash
docker compose -f docker-compose.prod.yml exec -T app-db \
  pg_dump -U freefirst -d freefirst_app -Fc > /opt/backups/pre-restore_$(date +%s).dump
```

### 4.3 Restore

```bash
# Drop and recreate so the restore starts from a clean schema.
docker compose -f docker-compose.prod.yml exec -T app-db \
  psql -U freefirst -d postgres -c 'DROP DATABASE freefirst_app WITH (FORCE);'
docker compose -f docker-compose.prod.yml exec -T app-db \
  psql -U freefirst -d postgres -c 'CREATE DATABASE freefirst_app OWNER freefirst;'

docker compose -f docker-compose.prod.yml exec -T app-db \
  pg_restore -U freefirst -d freefirst_app --no-owner --clean --if-exists \
  < /opt/backups/app_20261030_020000.dump
```

`--no-owner` avoids failures when the restore role differs from the dump role.
`--clean --if-exists` is safe here because the database was just recreated.

Plain-SQL dump:

```bash
gunzip -c /opt/backups/app_20261030.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T app-db \
  psql -U freefirst -d freefirst_app
```

### 4.4 Restart and verify

```bash
docker compose -f docker-compose.prod.yml start backend
docker compose -f docker-compose.prod.yml exec backend \
  node -e "fetch('http://127.0.0.1:3001/ready').then(r=>r.text()).then(console.log)"
```

Then check data, not just health:

```bash
docker compose -f docker-compose.prod.yml exec -T app-db psql -U freefirst -d freefirst_app -c \
  "select (select count(*) from app_users) users,
          (select count(*) from conversations) conversations,
          (select count(*) from messages) messages,
          (select max(created_at) from messages) latest;"
```

Log in with a real account and open an old conversation. If the session table was restored, existing
tokens keep working; if not, users are simply asked to log in again — annoying, not broken.

### 4.5 Rehearse the round trip without a client toolchain

`scripts/backup-restore-drill.mjs` proves the *logical* round trip — seed → export → drop schema →
re-run migrations → re-import → compare — using only `pg` and the real migration files. It exists
because `pg_dump` / `pg_restore` are not always available (they were not in the environment where
this project was built).

```bash
DRILL_DATABASE_URL=postgres://freefirst:devpass@127.0.0.1:5432/ff_backup_drill \
  node scripts/backup-restore-drill.mjs
```

A passing run prints identical before/after row counts and an identical content hash:

```
[drill] content hash — ae382538354413a7 → ae382538354413a7
[drill] PASSED: backup → drop → migrate → restore reproduced the data exactly
```

**This is not a substitute for a `pg_dump` rehearsal.** It uses a dedicated database and drops its
schema, so never point `DRILL_DATABASE_URL` at a database holding real data. It also does not test
what `pg_dump` tests: binary format compatibility, `--clean` semantics, ownership/ACL handling, or
restoring into a different server version. Run both before trusting a restore procedure.

## 5. Point-in-time recovery

Not configured. It requires WAL archiving, which needs a `postgresql.conf` change and a durable
archive target. Without it, the recovery point objective is "the last nightly dump" — up to 24 hours
of lost messages.

If that is unacceptable:

1. Set `archive_mode = on` and `archive_command` to ship WAL to object storage.
2. Take a base backup with `pg_basebackup`.
3. Practise a recovery into a scratch database before relying on it.

## 6. Failure scenarios

### Database corruption

1. Stop the backend.
2. Attempt `pg_dump` of the corrupt database; if it fails, proceed with the last good dump.
3. Restore per §4.
4. Verify counts, then restart.

### Full server loss

1. Provision a new host; install Docker and Compose.
2. Clone the repository at the same tag.
3. Restore `.env` from your secret manager — **not** from the repository.
4. Restore both databases per §4.
5. `docker compose -f docker-compose.prod.yml up -d --build`
6. Point DNS at the new host; wait for Caddy to issue a certificate.
7. Verify per `DEPLOYMENT.md` §5.

### Lost provider keys

Not a backup concern. Re-issue keys at each provider, update the router env, restart the router.
Budget history survives because it lives in `router-db`.

### Application rollback

```bash
cd /opt/freefirst-ai
git checkout <previous-tag>
docker compose -f docker-compose.prod.yml up -d --build
```

Migrations are forward-only. If the previous tag predates an applied migration, the old code runs
against a newer schema. Read the migration before rolling back past it — additive changes are
usually fine, renames are not.

## 7. Drill schedule

| Frequency | Task |
|---|---|
| Daily | Automated dump + size check, log reviewed |
| Weekly | Offsite sync confirmed |
| Monthly | Restore the latest dump into a scratch database and query it |
| Quarterly | Full recovery rehearsal on a fresh host, timed |

The monthly restore is the only step that proves the backups work. Skipping it means the first real
test happens during an outage.
