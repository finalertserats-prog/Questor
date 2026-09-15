#!/usr/bin/env bash
#
# Move a running Questor deployment from SQLite to PostgreSQL, on the same host.
#
#   ./scripts/cutover-to-postgres.sh --rehearse   copy real data into a throwaway
#                                                 database while the app keeps running
#   ./scripts/cutover-to-postgres.sh --apply      the real cutover (short downtime)
#
# Run as root from the repo on the VPS, after deploy.sh has shipped this commit.
# The Postgres cluster on this host is shared with another site: this script
# only ever creates, reads and drops the questor role and databases, and never
# restarts or reconfigures the cluster.
set -Eeuo pipefail

REPO_DIR="${REPO_DIR:-/root/Questor/repo}"
PM2_NAME="${PM2_NAME:-questor}"
APP_PORT="${APP_PORT:-4000}"
SECRETS_DIR=/root/Questor/secrets
PG_ENV_FILE="$SECRETS_DIR/questor-postgres.env"
BACKUP_DIR=/root/Questor/backups
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_DIR="$(mktemp -d)"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m  %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m   %s\n' "$*"; }
die()  { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

# Never pipe a command whose exit status matters (see deploy.sh).
run_logged() {
  local label="$1"; shift
  local log="$LOG_DIR/${label}.log"
  if ! "$@" >"$log" 2>&1; then
    printf '\n\033[31m--- %s failed, last 25 lines ---\033[0m\n' "$label" >&2
    tail -25 "$log" >&2
    return 1
  fi
  tail -2 "$log" | sed 's/^/    /'
}

MODE="${1:-}"
case "$MODE" in
  --rehearse|--apply) ;;
  *) echo "usage: $0 --rehearse | --apply" >&2; exit 2 ;;
esac

# The export holds password hashes, portal tokens, résumés and transcripts. It
# lives in RAM (/dev/shm), owner-only, and is removed on every exit path.
umask 077
EXPORT="/dev/shm/questor-export-$STAMP.json"
WORK=""
cleanup() {
  [ -f "$EXPORT" ] && { shred -u "$EXPORT" 2>/dev/null || rm -f "$EXPORT"; }
  [ -n "$WORK" ] && [ -d "$WORK" ] && rm -rf "$WORK"
  rm -rf "$LOG_DIR"
}
trap cleanup EXIT

pg_admin() { sudo -u postgres psql -X -v ON_ERROR_STOP=1 -qtA "$@"; }

cd "$REPO_DIR"

# ---------------------------------------------------------------------------
say "Pre-flight"

command -v psql >/dev/null || die "psql not on PATH"
command -v sqlite3 >/dev/null || die "sqlite3 not on PATH"
systemctl is-active --quiet postgresql || die "postgresql service is not active"
[ -f server/.env ] || die "server/.env not found"
[ -f scripts/migrate-sqlite-to-postgres.mjs ] || die "this commit has no migration script — deploy first"

DB_URL="$(grep -E '^DATABASE_URL=' server/.env | head -1 | cut -d= -f2- | tr -d '"' || true)"
case "$DB_URL" in
  file:*) ;;
  postgresql://*|postgres://*) die "server/.env already points at PostgreSQL — nothing to cut over" ;;
  *) die "unrecognised DATABASE_URL in server/.env" ;;
esac
SQLITE_REL="${DB_URL#file:}"; SQLITE_REL="${SQLITE_REL%%\?*}"
case "$SQLITE_REL" in
  /*) SQLITE_PATH="$SQLITE_REL" ;;
  *)  SQLITE_PATH="$REPO_DIR/server/prisma/${SQLITE_REL#./}" ;;
esac
[ -f "$SQLITE_PATH" ] || die "SQLite database not found at the path server/.env names"
[ "$(sqlite3 "$SQLITE_PATH" 'PRAGMA integrity_check;')" = ok ] || die "SQLite integrity check failed"
CANDIDATES="$(sqlite3 "$SQLITE_PATH" 'SELECT COUNT(*) FROM Candidate;')"
ok "SQLite database healthy ($CANDIDATES candidates)"

# ---------------------------------------------------------------------------
say "Postgres role"

mkdir -p "$SECRETS_DIR" && chmod 700 "$SECRETS_DIR"
if [ -f "$PG_ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$PG_ENV_FILE"
else
  # Hex only, so the password never needs URL-escaping. Written straight to an
  # owner-only file; never echoed.
  PG_PASSWORD="$(openssl rand -hex 32)"
  printf 'PG_PASSWORD=%s\n' "$PG_PASSWORD" > "$PG_ENV_FILE"
  chmod 600 "$PG_ENV_FILE"
fi
[ -n "${PG_PASSWORD:-}" ] || die "no password in $PG_ENV_FILE"

if [ "$(pg_admin -c "SELECT 1 FROM pg_roles WHERE rolname = 'questor';")" != 1 ]; then
  pg_admin -v pw="$PG_PASSWORD" <<'SQL'
CREATE ROLE questor LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
SQL
  ok "role questor created"
else
  pg_admin -v pw="$PG_PASSWORD" <<'SQL'
ALTER ROLE questor PASSWORD :'pw';
SQL
  ok "role questor exists; password synced with $PG_ENV_FILE"
fi

create_database() {
  local name="$1"
  if [ "$(pg_admin -c "SELECT 1 FROM pg_database WHERE datname = '$name';")" = 1 ]; then
    return 1
  fi
  pg_admin -c "CREATE DATABASE \"$name\" OWNER questor;"
  # Nobody but questor (and the superuser) can connect to candidate data.
  pg_admin -c "REVOKE ALL ON DATABASE \"$name\" FROM PUBLIC;"
}

pg_url() { printf 'postgresql://questor:%s@127.0.0.1:5432/%s?schema=public&connection_limit=10' "$PG_PASSWORD" "$1"; }

# Export from a SQLite file with the currently generated (SQLite) client, then
# import into a Postgres database with a Postgres client generated in $1.
migrate_into() {
  local server_dir="$1" sqlite_file="$2" database="$3"
  local url; url="$(pg_url "$database")"
  (cd "$server_dir" && DATABASE_URL="file:$sqlite_file" run_logged export node ../scripts/migrate-sqlite-to-postgres.mjs export --out "$EXPORT") || return 1
  (cd "$server_dir" && run_logged pg-schema node ../scripts/generate-postgres-schema.mjs) || return 1
  (cd "$server_dir" && run_logged pg-generate npx prisma generate --schema prisma/postgres/schema.prisma) || return 1
  (cd "$server_dir" && DATABASE_URL="$url" run_logged pg-push npx prisma db push --skip-generate --schema prisma/postgres/schema.prisma) || return 1
  (cd "$server_dir" && DATABASE_URL="$url" run_logged import node ../scripts/migrate-sqlite-to-postgres.mjs import --in "$EXPORT") || return 1
  local pg_candidates
  pg_candidates="$(PGPASSWORD="$PG_PASSWORD" psql -X -h 127.0.0.1 -U questor -d "$database" -qtAc 'SELECT COUNT(*) FROM "Candidate";')"
  [ "$pg_candidates" = "$(sqlite3 "$sqlite_file" 'SELECT COUNT(*) FROM Candidate;')" ] || { echo "candidate count mismatch" >&2; return 1; }
  ok "imported and verified: every table matches row for row ($pg_candidates candidates)"
}

# ---------------------------------------------------------------------------
if [ "$MODE" = --rehearse ]; then
  say "Rehearsal (the app keeps running on SQLite)"

  # A private copy of the repo, so generating the Postgres client never touches
  # the node_modules the live process is using.
  WORK="$(mktemp -d /root/Questor/rehearsal-XXXXXX)"
  run_logged copy-repo cp -a "$REPO_DIR/." "$WORK/" || die "could not copy the repo for the rehearsal"
  # A consistent snapshot of the live database, taken online.
  run_logged snapshot sqlite3 "$SQLITE_PATH" ".backup '$WORK/rehearsal.db'" || die "SQLite snapshot failed"

  pg_admin -c 'DROP DATABASE IF EXISTS "questor_rehearsal";'
  create_database questor_rehearsal || die "could not create questor_rehearsal"
  if migrate_into "$WORK/server" "$WORK/rehearsal.db" questor_rehearsal; then
    pg_admin -c 'DROP DATABASE "questor_rehearsal";'
    say "Rehearsal passed — the rehearsal database has been dropped"
    exit 0
  fi
  pg_admin -c 'DROP DATABASE IF EXISTS "questor_rehearsal";'
  die "rehearsal failed; production was not touched"
fi

# ---------------------------------------------------------------------------
say "Cutover"

ACTIVE="$(sqlite3 "$SQLITE_PATH" "
  SELECT COUNT(*) FROM InterviewSession s
  WHERE s.state NOT IN ('REVIEW_READY','HUMAN_REVIEWED','CLOSED','CANCELLED','NO_SHOW',
                        'TECHNICAL_FAILURE','POLICY_STOP','CANDIDATE_WITHDREW','INVITED','PROVISIONED')
    AND EXISTS (SELECT 1 FROM Turn t WHERE t.sessionId = s.id
                AND t.createdAt > (strftime('%s','now','-15 minutes') * 1000));")"
[ "${ACTIVE:-0}" -eq 0 ] || die "$ACTIVE interview(s) active in the last 15 minutes — not cutting over"
ok "no interview activity in the last 15 minutes"

create_database questor || die "database questor already exists — refusing to import over it (drop it by hand only if you know it is empty)"
ok "database questor created"

ENV_BACKUP="$SECRETS_DIR/server.env.sqlite-$STAMP"
cp -p server/.env "$ENV_BACKUP" && chmod 600 "$ENV_BACKUP"

rollback() {
  warn "rolling back to SQLite"
  cp -p "$ENV_BACKUP" server/.env
  (cd server && npx prisma generate >"$LOG_DIR/rollback-generate.log" 2>&1) || warn "SQLite client regeneration failed — see $LOG_DIR"
  pm2 restart "$PM2_NAME" --update-env >/dev/null 2>&1 || pm2 start "$PM2_NAME" >/dev/null 2>&1 || true
  warn "rolled back: the app is on SQLite again; the questor database is left for inspection"
}

pm2 stop "$PM2_NAME" >/dev/null
ok "questor stopped (other pm2 apps untouched)"

mkdir -p "$BACKUP_DIR"
SNAPSHOT="$BACKUP_DIR/pre-postgres-$STAMP.db"
if ! sqlite3 "$SQLITE_PATH" ".backup '$SNAPSHOT'" || [ "$(sqlite3 "$SNAPSHOT" 'PRAGMA integrity_check;')" != ok ]; then
  pm2 start "$PM2_NAME" >/dev/null
  die "pre-cutover SQLite snapshot failed; the app was restarted on SQLite"
fi
chmod 600 "$SNAPSHOT"
ok "SQLite snapshot $(basename "$SNAPSHOT") verified"

if ! migrate_into "$REPO_DIR/server" "$SNAPSHOT" questor; then
  rollback
  die "migration failed"
fi

# Point the app at Postgres. Only the DATABASE_URL line changes.
NEW_URL="$(pg_url questor)"
awk -v url="$NEW_URL" 'BEGIN{done=0} /^DATABASE_URL=/{ if(!done){print "DATABASE_URL=\"" url "\""; done=1}; next } {print}' "$ENV_BACKUP" > server/.env
chmod 600 server/.env

pm2 restart "$PM2_NAME" --update-env >/dev/null
HEALTHY=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 2
done
# A login attempt forces a database query; the app must then hold a connection
# to the questor database, proving it is really on Postgres and not on a
# DATABASE_URL set somewhere else.
curl -fsS -o /dev/null -X POST -H 'Content-Type: application/json' \
  -d '{"email":"cutover-check@invalid.local","password":"not-a-real-password"}' \
  "http://127.0.0.1:$APP_PORT/api/auth/login" 2>/dev/null || true
CONNECTIONS="$(pg_admin -c "SELECT COUNT(*) FROM pg_stat_activity WHERE datname = 'questor' AND usename = 'questor';")"
if [ "$HEALTHY" -ne 1 ] || [ "${CONNECTIONS:-0}" -lt 1 ]; then
  rollback
  die "app did not come up on Postgres (healthy=$HEALTHY, connections=$CONNECTIONS)"
fi
ok "app healthy on Postgres ($CONNECTIONS connection(s) to questor)"

# The old file stays, read-only, as a restore point.
chmod 400 "$SQLITE_PATH"

# Nightly Postgres backups, verified readable, kept 14 days.
cat > /root/Questor/backup-questor-pg.sh <<EOF
#!/usr/bin/env bash
set -euo pipefail
umask 077
. "$PG_ENV_FILE"
OUT="$BACKUP_DIR/questor-\$(date +%Y%m%d-%H%M%S).dump"
PGPASSWORD="\$PG_PASSWORD" pg_dump -h 127.0.0.1 -U questor --format=custom --file="\$OUT" questor
# Listed to a file rather than piped: grep -q closing the pipe early would fail pipefail.
pg_restore --list "\$OUT" > "\$OUT.list"
grep -q 'TABLE DATA public "Candidate"' "\$OUT.list"
rm -f "\$OUT.list"
find "$BACKUP_DIR" -name 'questor-*.dump' -mtime +14 -delete
EOF
chmod 700 /root/Questor/backup-questor-pg.sh
CRON_TMP="$LOG_DIR/crontab"
crontab -l > "$CRON_TMP" 2>/dev/null || true
{ grep -v 'backup-questor-pg.sh' "$CRON_TMP" || true; echo '30 2 * * * /root/Questor/backup-questor-pg.sh >> /root/Questor/backups/pg-backup.log 2>&1'; } > "$CRON_TMP.new"
crontab "$CRON_TMP.new"
run_logged first-pg-backup /root/Questor/backup-questor-pg.sh || warn "first Postgres backup failed — check /root/Questor/backup-questor-pg.sh"
ok "nightly Postgres backup installed and run once"

say "Cutover complete"
ok "SQLite restore point: $SNAPSHOT (and the original file, now read-only)"
ok "previous server/.env: $ENV_BACKUP"
