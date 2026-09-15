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
# only ever creates, reads and drops the questor role and databases, caps the
# role's connections so it can never starve the other site, and never restarts
# or reconfigures the cluster.
set -Eeuo pipefail

REPO_DIR="${REPO_DIR:-/root/Questor/repo}"
PM2_NAME="${PM2_NAME:-questor}"
APP_PORT="${APP_PORT:-4000}"
SECRETS_DIR=/root/Questor/secrets
PG_ENV_FILE="$SECRETS_DIR/questor-postgres.env"
BACKUP_DIR=/root/Questor/backups
CRON_FILE=/etc/cron.d/questor-pg-backup
# Prisma's pool (connection_limit) stays below the role cap, which stays far
# below the cluster's max_connections shared with the other site.
ROLE_CONNECTION_LIMIT=20
POOL_SIZE=10
STAMP="$(date +%Y%m%d-%H%M%S)"

umask 077
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

sq() { sqlite3 -cmd '.timeout 10000' "$@"; }
# From /tmp so sudo does not warn about root's home; the password never goes
# on a command line (psql reads it from the environment with \getenv).
pg_admin() { (cd /tmp && sudo -u postgres --preserve-env=QUESTOR_PG_PASSWORD psql -X -v ON_ERROR_STOP=1 -qtA "$@"); }
pg_questor() { local db="$1"; shift; PGPASSWORD="$PG_PASSWORD" psql -X -h 127.0.0.1 -U questor -d "$db" -v ON_ERROR_STOP=1 -qtA "$@"; }

MODE="${1:-}"
case "$MODE" in
  --rehearse|--apply) ;;
  *) echo "usage: $0 --rehearse | --apply" >&2; exit 2 ;;
esac

# The export holds password hashes, portal tokens, résumés and transcripts. It
# is owner-only in RAM (a few MB for this deployment) and removed on every exit.
EXPORT="/dev/shm/questor-export-$STAMP.json"
WORK=""
STOPPED=0      # questor has been stopped by this script
FINISHED=0     # the cutover completed and was verified
ENV_BACKUP=""

rollback() {
  warn "rolling back to SQLite"
  [ -n "$ENV_BACKUP" ] && [ -f "$ENV_BACKUP" ] && cp -p "$ENV_BACKUP" "$REPO_DIR/server/.env"
  (cd "$REPO_DIR/server" && npx prisma generate >"$LOG_DIR/rollback-generate.log" 2>&1) \
    || warn "SQLite client regeneration failed — see $LOG_DIR/rollback-generate.log"
  pm2 restart "$PM2_NAME" --update-env >/dev/null 2>&1 || pm2 start "$PM2_NAME" >/dev/null 2>&1 || true
  warn "the app is on SQLite again; the questor database is left for inspection"
}

on_exit() {
  local status=$?
  trap - EXIT INT TERM HUP
  # Any failure or interruption after questor was stopped puts it back on SQLite.
  if [ "$STOPPED" -eq 1 ] && [ "$FINISHED" -eq 0 ]; then
    rollback
    status=1
  fi
  if [ -f "$EXPORT" ]; then shred -u "$EXPORT" 2>/dev/null || rm -f "$EXPORT"; fi
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf "$WORK"; fi
  if [ "$status" -eq 0 ]; then rm -rf "$LOG_DIR"; else warn "logs kept in $LOG_DIR"; fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

cd "$REPO_DIR"

# ---------------------------------------------------------------------------
say "Pre-flight"

command -v psql >/dev/null || die "psql not on PATH"
command -v sqlite3 >/dev/null || die "sqlite3 not on PATH"
systemctl is-active --quiet postgresql || die "postgresql service is not active"
[ -f server/.env ] || die "server/.env not found"
[ -f scripts/migrate-sqlite-to-postgres.mjs ] || die "this commit has no migration script — deploy first"

DB_URL="$(grep -E '^DATABASE_URL=' server/.env | head -1 | cut -d= -f2- | tr -d "\"'" || true)"
case "$DB_URL" in
  file:*) ;;
  postgresql://*|postgres://*) die "server/.env already points at PostgreSQL — nothing to cut over" ;;
  *) die "unrecognised DATABASE_URL in server/.env" ;;
esac
# Prisma resolves a relative file: URL against the schema's directory.
SQLITE_REL="${DB_URL#file:}"; SQLITE_REL="${SQLITE_REL%%\?*}"
case "$SQLITE_REL" in
  /*) SQLITE_PATH="$SQLITE_REL" ;;
  *)  SQLITE_PATH="$REPO_DIR/server/prisma/${SQLITE_REL#./}" ;;
esac
[ -f "$SQLITE_PATH" ] || die "SQLite database not found at the path server/.env names"
[ "$(sq "$SQLITE_PATH" 'PRAGMA integrity_check;')" = ok ] || die "SQLite integrity check failed"
ok "SQLite database healthy ($(sq "$SQLITE_PATH" 'SELECT COUNT(*) FROM Candidate;') candidates)"

# ---------------------------------------------------------------------------
say "Postgres role"

mkdir -p "$SECRETS_DIR" && chmod 700 "$SECRETS_DIR"
ROLE_EXISTS="$(pg_admin -c "SELECT 1 FROM pg_roles WHERE rolname = 'questor';")"
if [ -f "$PG_ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$PG_ENV_FILE"
elif [ "$ROLE_EXISTS" = 1 ]; then
  # A questor role this script did not create belongs to someone else.
  die "a questor role already exists but $PG_ENV_FILE does not — refusing to take it over"
else
  # Hex only, so the password never needs URL-escaping. Written straight to an
  # owner-only file; never echoed.
  printf 'PG_PASSWORD=%s\n' "$(openssl rand -hex 32)" > "$PG_ENV_FILE"
  chmod 600 "$PG_ENV_FILE"
  # shellcheck disable=SC1090
  . "$PG_ENV_FILE"
fi
[ -n "${PG_PASSWORD:-}" ] || die "no password in $PG_ENV_FILE"
export QUESTOR_PG_PASSWORD="$PG_PASSWORD"

if [ "$ROLE_EXISTS" != 1 ]; then
  pg_admin <<SQL
\getenv pw QUESTOR_PG_PASSWORD
CREATE ROLE questor LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT $ROLE_CONNECTION_LIMIT;
SQL
  ok "role questor created (connection limit $ROLE_CONNECTION_LIMIT)"
else
  pg_admin <<SQL
\getenv pw QUESTOR_PG_PASSWORD
ALTER ROLE questor PASSWORD :'pw' CONNECTION LIMIT $ROLE_CONNECTION_LIMIT;
SQL
  ok "role questor exists (created by an earlier run); password and limit synced"
fi
unset QUESTOR_PG_PASSWORD

create_database() {
  local name="$1"
  [ "$(pg_admin -c "SELECT 1 FROM pg_database WHERE datname = '$name';")" != 1 ] || return 1
  pg_admin -c "CREATE DATABASE \"$name\" OWNER questor;"
  # Nobody but questor (and the superuser) can connect to candidate data.
  pg_admin -c "REVOKE ALL ON DATABASE \"$name\" FROM PUBLIC;"
}

pg_url() { printf 'postgresql://questor:%s@127.0.0.1:5432/%s?schema=public&connection_limit=%s' "$PG_PASSWORD" "$1" "$POOL_SIZE"; }

# Export from a SQLite file with the currently generated (SQLite) client, then
# import into a Postgres database with a Postgres client generated in $1. The
# import verifies every table's row count inside its transaction.
migrate_into() {
  local server_dir="$1" sqlite_file="$2" database="$3"
  local url
  url="$(pg_url "$database")"
  (cd "$server_dir" && DATABASE_URL="file:$sqlite_file" run_logged export node ../scripts/migrate-sqlite-to-postgres.mjs export --out "$EXPORT") || return 1
  (cd "$server_dir" && run_logged pg-schema node ../scripts/generate-postgres-schema.mjs) || return 1
  (cd "$server_dir" && DATABASE_URL="$url" run_logged pg-generate npx prisma generate --schema prisma/postgres/schema.prisma) || return 1
  (cd "$server_dir" && DATABASE_URL="$url" run_logged pg-push npx prisma db push --skip-generate --schema prisma/postgres/schema.prisma) || return 1
  (cd "$server_dir" && DATABASE_URL="$url" run_logged import node ../scripts/migrate-sqlite-to-postgres.mjs import --in "$EXPORT") || return 1
  local table pg_count sq_count
  for table in Tenant User Candidate InterviewSession Turn AssessmentVersion AuditEvent; do
    pg_count="$(pg_questor "$database" -c "SELECT COUNT(*) FROM \"$table\";")"
    sq_count="$(sq "$sqlite_file" "SELECT COUNT(*) FROM \"$table\";")"
    [ "$pg_count" = "$sq_count" ] || { echo "$table: postgres $pg_count, sqlite $sq_count" >&2; return 1; }
  done
  ok "imported; row counts match the SQLite source (checked again outside the import)"
}

# ---------------------------------------------------------------------------
if [ "$MODE" = --rehearse ]; then
  say "Rehearsal (the app keeps running on SQLite)"

  # A private copy of the repo, so generating the Postgres client never touches
  # the node_modules the live process is using.
  WORK="$(mktemp -d /root/Questor/rehearsal-XXXXXX)"
  run_logged copy-repo cp -a "$REPO_DIR/." "$WORK/" || die "could not copy the repo for the rehearsal"
  # A consistent snapshot of the live database, taken online.
  run_logged snapshot sq "$SQLITE_PATH" ".backup '$WORK/rehearsal.db'" || die "SQLite snapshot failed"

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

# Prisma stores SQLite DateTimes as epoch milliseconds.
ACTIVE="$(sq "$SQLITE_PATH" "
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

STOPPED=1
pm2 stop "$PM2_NAME" >/dev/null
ok "questor stopped (other pm2 apps untouched); any failure from here rolls back"

mkdir -p "$BACKUP_DIR"
SNAPSHOT="$BACKUP_DIR/pre-postgres-$STAMP.db"
sq "$SQLITE_PATH" ".backup '$SNAPSHOT'"
[ "$(sq "$SNAPSHOT" 'PRAGMA integrity_check;')" = ok ] || die "pre-cutover SQLite snapshot failed its integrity check"
chmod 600 "$SNAPSHOT"
ok "SQLite snapshot $(basename "$SNAPSHOT") verified"

migrate_into "$REPO_DIR/server" "$SNAPSHOT" questor || die "migration failed"

# Point the app at Postgres. Only the DATABASE_URL line changes; the URL reaches
# awk through the environment, never a command line.
NEW_DATABASE_URL="$(pg_url questor)" awk '
  /^DATABASE_URL=/ { if (!done) { print "DATABASE_URL=\"" ENVIRON["NEW_DATABASE_URL"] "\""; done = 1 }; next }
  { print }' "$ENV_BACKUP" > "$LOG_DIR/env.new"
grep -q '^DATABASE_URL="postgresql://' "$LOG_DIR/env.new" || die "could not rewrite DATABASE_URL"
install -m 600 "$LOG_DIR/env.new" server/.env
rm -f "$LOG_DIR/env.new"

pm2 restart "$PM2_NAME" --update-env >/dev/null
HEALTHY=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 2
done
# A login attempt forces a database query; the app must then hold a connection
# to the questor database, proving it is really on Postgres and not on a
# DATABASE_URL set somewhere else.
curl -sS -o /dev/null -X POST -H 'Content-Type: application/json' \
  -d '{"email":"cutover-check@invalid.local","password":"not-a-real-password"}' \
  "http://127.0.0.1:$APP_PORT/api/auth/login" >/dev/null 2>&1 || true
CONNECTIONS="$(pg_admin -c "SELECT COUNT(*) FROM pg_stat_activity WHERE datname = 'questor' AND usename = 'questor';")"
[ "$HEALTHY" -eq 1 ] && [ "${CONNECTIONS:-0}" -ge 1 ] \
  || die "app did not come up on Postgres (healthy=$HEALTHY, connections=${CONNECTIONS:-0})"
FINISHED=1
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
# Listed to a file rather than piped: grep -q closing the pipe early would fail
# pipefail. pg_restore prints table names unquoted.
pg_restore --list "\$OUT" > "\$OUT.list"
grep -Eq 'TABLE DATA public "?Candidate"? ' "\$OUT.list"
rm -f "\$OUT.list"
find "$BACKUP_DIR" -name 'questor-*.dump' -mtime +14 -delete
EOF
chmod 700 /root/Questor/backup-questor-pg.sh
# Its own cron.d file: root's crontab and other jobs are never rewritten.
printf '30 2 * * * root /root/Questor/backup-questor-pg.sh >> %s/pg-backup.log 2>&1\n' "$BACKUP_DIR" > "$CRON_FILE"
chmod 644 "$CRON_FILE"
if run_logged first-pg-backup /root/Questor/backup-questor-pg.sh; then
  ok "nightly Postgres backup installed and verified once"
else
  warn "first Postgres backup failed — run /root/Questor/backup-questor-pg.sh by hand"
fi

say "Cutover complete"
ok "SQLite restore point: $SNAPSHOT (and the original file, now read-only)"
ok "previous server/.env: $ENV_BACKUP"
