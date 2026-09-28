#!/usr/bin/env bash
# Restore a Questor backup into a scratch Postgres database and verify it.
set -Eeuo pipefail

KEEP=0
DRY_RUN=0
DUMP_PATH=""
LOG_DIR=""
SCRATCH_DB="questor_restore_drill_$(date +%Y%m%d_%H%M%S)"
SEARCH_PATH=""
SCRATCH_CREATED=0

usage() {
  cat <<'USAGE'
Usage: scripts/restore-drill.sh [--keep] [--dry-run] <dump-path>

Restores a Questor backup into a scratch database on the same Postgres server,
runs verification queries, prints a short summary, and drops the scratch database.

Options:
  --keep      Leave the scratch database in place for inspection.
  --dry-run   Print the commands that would run and exit 0 without touching a database.
  --help      Show this help.

Connection:
  Uses PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE and related libpq
  variables when set. If DATABASE_URL is set, it is parsed into PG* variables.
  A ?schema=<name> query parameter is removed from the database name and used
  as the search_path during restore and verification.
USAGE
}

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }

cleanup() {
  local code=$?
  if [ "$DRY_RUN" -eq 0 ] && [ "$KEEP" -eq 0 ] && [ "$SCRATCH_CREATED" -eq 1 ]; then
    case "$SCRATCH_DB" in
      *restore_drill*)
        PGDATABASE="${MAINTENANCE_DB:-postgres}" dropdb --if-exists "$SCRATCH_DB" >/dev/null 2>&1 || true
        ;;
    esac
  fi
  if [ -n "${LOG_DIR:-}" ] && [ -d "$LOG_DIR" ]; then
    rm -rf "$LOG_DIR"
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'echo "restore drill aborted at line $LINENO" >&2' ERR

for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --help|-h) usage; exit 0 ;;
    --*) die "unknown option: $arg" ;;
    *)
      if [ -n "$DUMP_PATH" ]; then die "only one dump path may be supplied"; fi
      DUMP_PATH="$arg"
      ;;
  esac
done

[ -n "$DUMP_PATH" ] || { usage; exit 2; }

quote() { printf '%q' "$1"; }
print_cmd() {
  local first=1 part
  for part in "$@"; do
    if [ "$first" -eq 0 ]; then printf ' '; fi
    quote "$part"
    first=0
  done
  printf '\n'
}

run_logged() {
  local label="$1"; shift
  local log="$LOG_DIR/${label}.log"
  if [ "$DRY_RUN" -eq 1 ]; then
    print_cmd "$@"
    return 0
  fi
  if ! "$@" >"$log" 2>&1; then
    printf '\n--- %s failed, last 25 lines ---\n' "$label" >&2
    tail -25 "$log" >&2
    die "$label failed"
  fi
}

assert_restore_drill_db() {
  local db="$1"
  case "$db" in
    *restore_drill*) return 0 ;;
    *) die "refusing to touch database without restore_drill in its name: $db" ;;
  esac
}

parse_database_url() {
  [ -n "${DATABASE_URL:-}" ] || return 0
  local parsed
  if ! parsed="$(python3 - "$DATABASE_URL" <<'PY'
import sys
from urllib.parse import urlparse, parse_qs, unquote
u = urlparse(sys.argv[1])
if u.scheme not in ('postgresql', 'postgres'):
    raise SystemExit('DATABASE_URL must start with postgres:// or postgresql://')
q = parse_qs(u.query)
schema = q.get('schema', [''])[0]
print('PGHOST=' + (u.hostname or ''))
print('PGPORT=' + (str(u.port) if u.port else ''))
print('PGUSER=' + unquote(u.username or ''))
print('PGPASSWORD=' + unquote(u.password or ''))
print('PGDATABASE=' + unquote((u.path or '/').lstrip('/')))
print('SEARCH_PATH=' + schema)
PY
  )"; then
    die "could not parse DATABASE_URL"
  fi
  while IFS='=' read -r key value; do
    case "$key" in
      PGHOST) [ -n "${PGHOST:-}" ] || export PGHOST="$value" ;;
      PGPORT) [ -n "${PGPORT:-}" ] || export PGPORT="$value" ;;
      PGUSER) [ -n "${PGUSER:-}" ] || export PGUSER="$value" ;;
      PGPASSWORD) [ -n "${PGPASSWORD:-}" ] || export PGPASSWORD="$value" ;;
      PGDATABASE) [ -n "${PGDATABASE:-}" ] || export PGDATABASE="$value" ;;
      SEARCH_PATH) SEARCH_PATH="$value" ;;
    esac
  done <<< "$parsed"
}

maintenance_env() {
  export PGDATABASE="${MAINTENANCE_DB:-postgres}"
}

db_env() {
  export PGDATABASE="$SCRATCH_DB"
  if [ -n "$SEARCH_PATH" ]; then
    export PGOPTIONS="-c search_path=$SEARCH_PATH"
  fi
}

psql_scratch() {
  local label="$1" sql="$2" out="$3"
  db_env
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'PGDATABASE=%s ' "$SCRATCH_DB"
    if [ -n "$SEARCH_PATH" ]; then printf 'PGOPTIONS=%q ' "-c search_path=$SEARCH_PATH"; fi
    print_cmd psql -X -v ON_ERROR_STOP=1 -Atc "$sql"
    return 0
  fi
  if ! psql -X -v ON_ERROR_STOP=1 -Atc "$sql" >"$out" 2>"$LOG_DIR/${label}.err"; then
    printf '\n--- %s failed, stderr ---\n' "$label" >&2
    tail -25 "$LOG_DIR/${label}.err" >&2
    die "$label failed"
  fi
}

parse_database_url
LOG_DIR="$(mktemp -d)"

if [ "$DRY_RUN" -eq 0 ]; then
  [ -f "$DUMP_PATH" ] || die "dump file not found: $DUMP_PATH"
  command -v psql >/dev/null || die "psql not on PATH"
  command -v createdb >/dev/null || die "createdb not on PATH"
  command -v dropdb >/dev/null || die "dropdb not on PATH"
  command -v pg_restore >/dev/null || die "pg_restore not on PATH"
else
  say "Dry run"
fi

assert_restore_drill_db "$SCRATCH_DB"

if [ "$DRY_RUN" -eq 1 ]; then
  print_cmd pg_restore --list "$DUMP_PATH"
  print_cmd createdb "$SCRATCH_DB"
  print_cmd pg_restore --no-owner --no-privileges --dbname "$SCRATCH_DB" "$DUMP_PATH"
  print_cmd psql -X -v ON_ERROR_STOP=1 --dbname "$SCRATCH_DB" --file "$DUMP_PATH"
  print_cmd psql -X -v ON_ERROR_STOP=1 -Atc "verification queries"
  print_cmd dropdb --if-exists "$SCRATCH_DB"
  exit 0
fi

say "Detect dump format"
if pg_restore --list "$DUMP_PATH" >"$LOG_DIR/pg_restore_list.log" 2>&1; then
  DUMP_KIND="custom"
else
  DUMP_KIND="plain"
fi
printf 'dump: %s (%s)\n' "$DUMP_PATH" "$DUMP_KIND"
printf 'scratch database: %s\n' "$SCRATCH_DB"
[ -n "$SEARCH_PATH" ] && printf 'search_path: %s\n' "$SEARCH_PATH"

say "Create scratch database"
maintenance_env
run_logged createdb createdb "$SCRATCH_DB"
SCRATCH_CREATED=1

restore_ok=0
say "Restore"
if [ "$DUMP_KIND" = "custom" ]; then
  db_env
  run_logged restore pg_restore --no-owner --no-privileges --dbname "$SCRATCH_DB" "$DUMP_PATH"
else
  db_env
  run_logged restore-sql psql -X -v ON_ERROR_STOP=1 --dbname "$SCRATCH_DB" --file "$DUMP_PATH"
fi
restore_ok=1

say "Verify"
COUNTS_FILE="$LOG_DIR/counts.tsv"
NEWEST_FILE="$LOG_DIR/newest.txt"
NEWEST_DATA_FILE="$LOG_DIR/newest-data.txt"
AGE_FILE="$LOG_DIR/age.txt"
COUNTS_SQL=$(cat <<'SQL'
SELECT label || E'\t' || count::text
FROM (
  SELECT 'Tenant' AS label, COUNT(*) AS count FROM "Tenant"
  UNION ALL SELECT 'User', COUNT(*) FROM "User"
  UNION ALL SELECT 'Candidate', COUNT(*) FROM "Candidate"
  UNION ALL SELECT 'InterviewSession', COUNT(*) FROM "InterviewSession"
  UNION ALL SELECT 'AssessmentVersion', COUNT(*) FROM "AssessmentVersion"
  UNION ALL SELECT 'AuditEvent', COUNT(*) FROM "AuditEvent"
  UNION ALL SELECT 'JobRun', COUNT(*) FROM "JobRun"
) s
ORDER BY label;
SQL
)
NEWEST_AUDIT_SQL=$(cat <<'SQL'
SELECT COALESCE(MAX("createdAt")::text, '<none>') FROM "AuditEvent";
SQL
)
NEWEST_DATA_SQL=$(cat <<'SQL'
SELECT COALESCE(MAX(ts)::text, '<none>')
FROM (
  SELECT MAX("createdAt") AS ts FROM "Tenant"
  UNION ALL SELECT MAX("createdAt") FROM "User"
  UNION ALL SELECT MAX("createdAt") FROM "Candidate"
  UNION ALL SELECT MAX("createdAt") FROM "InterviewSession"
  UNION ALL SELECT MAX("createdAt") FROM "AssessmentVersion"
  UNION ALL SELECT MAX("createdAt") FROM "AuditEvent"
  UNION ALL SELECT MAX("startedAt") FROM "JobRun"
) s;
SQL
)
AGE_SQL=$(cat <<'SQL'
SELECT COALESCE((now() - MAX(ts))::text, '<none>')
FROM (
  SELECT MAX("createdAt") AS ts FROM "Tenant"
  UNION ALL SELECT MAX("createdAt") FROM "User"
  UNION ALL SELECT MAX("createdAt") FROM "Candidate"
  UNION ALL SELECT MAX("createdAt") FROM "InterviewSession"
  UNION ALL SELECT MAX("createdAt") FROM "AssessmentVersion"
  UNION ALL SELECT MAX("createdAt") FROM "AuditEvent"
  UNION ALL SELECT MAX("startedAt") FROM "JobRun"
) s;
SQL
)
psql_scratch counts "$COUNTS_SQL" "$COUNTS_FILE"
psql_scratch newest "$NEWEST_AUDIT_SQL" "$NEWEST_FILE"
psql_scratch newest_data "$NEWEST_DATA_SQL" "$NEWEST_DATA_FILE"
psql_scratch age "$AGE_SQL" "$AGE_FILE"

say "Summary"
printf 'restore status: ok\n'
printf 'scratch database: %s\n' "$SCRATCH_DB"
printf 'dump kind: %s\n' "$DUMP_KIND"
printf 'row counts:\n'
while IFS=$'\t' read -r label count; do
  printf '  %-18s %s\n' "$label" "$count"
done < "$COUNTS_FILE"
printf 'newest AuditEvent: %s\n' "$(cat "$NEWEST_FILE")"
printf 'age of newest data: %s\n' "$(cat "$AGE_FILE")"

if [ "$KEEP" -eq 1 ]; then
  printf 'kept scratch database: %s\n' "$SCRATCH_DB"
else
  say "Drop scratch database"
  assert_restore_drill_db "$SCRATCH_DB"
  maintenance_env
  run_logged dropdb dropdb --if-exists "$SCRATCH_DB"
  printf 'dropped scratch database: %s\n' "$SCRATCH_DB"
fi

[ "$restore_ok" -eq 1 ] || die "restore did not complete"
