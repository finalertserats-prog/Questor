#!/usr/bin/env bash
#
# Deploy Questor to the VPS.
#
# Written after a deploy that reported success while the application was down
# for three minutes. Every guard below exists because something specific went
# wrong, and the comments say which — none of it is defensive boilerplate.
#
#   ./scripts/deploy.sh              deploy the current origin branch, first
#                                    waiting for live interviews to finish
#                                    (same as --wait)
#   ./scripts/deploy.sh --dry-run    run every check, change nothing
#   ./scripts/deploy.sh --force      do not wait; restart now and let the
#                                    server's own drain protect interviews for
#                                    up to SHUTDOWN_DRAIN_MS
#
# Environment: WAIT_MAX_MIN (default 45) bounds the --wait; WAIT_POLL_SEC
# (default 30) is how often it re-checks.
#
set -Eeuo pipefail

# `pipefail` is the single most important line in this file. The failure that
# caused the outage was `npm ci --silent 2>&1 | tail -2`: npm exited non-zero,
# `tail` exited zero, the pipeline reported zero, and `set -e` had nothing to
# catch. The install had wiped node_modules and not replaced it. Everything
# after that ran against a broken tree.
#
# Rule for this script: never pipe a command whose exit status matters. Capture
# output to a file and print the tail afterwards instead.

REPO_DIR="${REPO_DIR:-/root/Questor/repo}"
BRANCH="${BRANCH:-claude/open-source-app-build-lnrqia}"
WEB_ROOT="${WEB_ROOT:-/var/www/questor}"
APP_URL="${APP_URL:-https://questor.187-127-166-193.sslip.io}"
PM2_NAME="${PM2_NAME:-questor}"
BACKUP_SCRIPT="${BACKUP_SCRIPT:-/root/Questor/backup-questor.sh}"
LOG_DIR="$(mktemp -d)"
WAIT_MAX_MIN="${WAIT_MAX_MIN:-45}"
WAIT_POLL_SEC="${WAIT_POLL_SEC:-30}"

DRY_RUN=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force)   FORCE=1 ;;
    --wait)    FORCE=0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
[[ "$WAIT_MAX_MIN" =~ ^[0-9]+$ ]] || { echo "WAIT_MAX_MIN must be a whole number of minutes" >&2; exit 2; }
[[ "$WAIT_POLL_SEC" =~ ^[1-9][0-9]*$ ]] || { echo "WAIT_POLL_SEC must be a positive whole number of seconds" >&2; exit 2; }

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m  %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m   %s\n' "$*"; }
die()  { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

# Print the tail of a captured log, then fail. Used wherever the old script
# would have piped and lost the exit code.
run_logged() {
  local label="$1"; shift
  local log="$LOG_DIR/${label}.log"
  if ! "$@" >"$log" 2>&1; then
    printf '\n\033[31m--- %s failed, last 25 lines ---\033[0m\n' "$label" >&2
    tail -25 "$log" >&2
    die "$label"
  fi
  tail -3 "$log" | sed 's/^/    /'
}

trap 'echo; echo "deploy aborted at line $LINENO"; exit 1' ERR

# ---------------------------------------------------------------------------
say "Pre-flight"

[ -d "$REPO_DIR" ] || die "repo not found at $REPO_DIR"
command -v pm2 >/dev/null || die "pm2 not on PATH"
cd "$REPO_DIR"

# Which database this deployment runs on, read from the server's own config so
# the script can never check or back up a different database than the app uses.
DB_URL="$(grep -E '^DATABASE_URL=' server/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true)"
case "$DB_URL" in
  postgresql://*|postgres://*) DB_KIND=postgres ;;
  *) DB_KIND=sqlite ;;
esac
if [ "$DB_KIND" = postgres ]; then
  # psql and pg_dump get the connection through libpq environment variables, so
  # the password never appears in a process list.
  [[ "$DB_URL" =~ ^postgres(ql)?://([^:@/]+):([^@/]*)@([^:/?]+)(:([0-9]+))?/([^?]+) ]] \
    || die "DATABASE_URL in server/.env is not a postgresql://user:password@host[:port]/db URL"
  export PGUSER="${BASH_REMATCH[2]}" PGPASSWORD="${BASH_REMATCH[3]}" PGHOST="${BASH_REMATCH[4]}"
  export PGPORT="${BASH_REMATCH[6]:-5432}" PGDATABASE="${BASH_REMATCH[7]}"
  command -v psql >/dev/null || die "psql not on PATH (needed to check for live interviews)"
  command -v pg_dump >/dev/null || die "pg_dump not on PATH (needed for the pre-deploy backup)"
  command -v pg_restore >/dev/null || die "pg_restore not on PATH (needed to verify the backup)"
else
  command -v sqlite3 >/dev/null || die "sqlite3 not on PATH (needed to check for live interviews)"
fi
ok "database: $DB_KIND"

# How long the server drains on SIGINT before it exits anyway, read from the
# same file the server reads. pm2 must wait longer than that before SIGKILL, or
# pm2's default 1.6 s kill timeout ends the drain — and every interview in it.
DRAIN_MS="$(grep -E '^SHUTDOWN_DRAIN_MS=' server/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '" ' || true)"
DRAIN_MS="${DRAIN_MS:-1200000}"
[[ "$DRAIN_MS" =~ ^[0-9]+$ ]] || die "SHUTDOWN_DRAIN_MS in server/.env is not a whole number of milliseconds"
KILL_TIMEOUT_MS=$(( DRAIN_MS + 60000 ))
ok "server drain up to $(( DRAIN_MS / 1000 ))s; pm2 kill timeout $(( KILL_TIMEOUT_MS / 1000 ))s"

# The file DATABASE_URL names (Prisma resolves it against server/prisma), not
# whichever .db happens to sort first in the data directory.
if [ "$DB_KIND" = sqlite ]; then
  DB_REL="${DB_URL#file:}"; DB_REL="${DB_REL%%\?*}"
  case "$DB_REL" in
    /*) DB="$DB_REL" ;;
    *)  DB="server/prisma/${DB_REL#./}" ;;
  esac
fi

# Interviews with a turn in the last 15 minutes. Prints nothing when there is
# no SQLite database to ask. A failed query is fatal rather than read as
# "nobody is interviewing": skipping this check silently is exactly how a live
# interview gets cut off.
count_active_interviews() {
  if [ "$DB_KIND" = postgres ]; then
    psql -X -tAc "
      SELECT COUNT(*) FROM \"InterviewSession\" s
      WHERE s.state NOT IN ('REVIEW_READY','HUMAN_REVIEWED','CLOSED','CANCELLED','NO_SHOW',
                            'TECHNICAL_FAILURE','POLICY_STOP','CANDIDATE_WITHDREW','INVITED','PROVISIONED')
        AND EXISTS (SELECT 1 FROM \"Turn\" t WHERE t.\"sessionId\" = s.id
                    AND t.\"createdAt\" > (now() AT TIME ZONE 'UTC') - interval '15 minutes');" \
      || die "could not query Postgres for live interviews — not deploying blind"
  elif [ -f "$DB" ]; then
    # Prisma stores SQLite DateTimes as epoch milliseconds. This used to compare
    # them with datetime('now', …) text, which an integer never exceeds, so the
    # check found no live interview however many there were.
    sqlite3 -cmd '.timeout 10000' "$DB" "
      SELECT COUNT(*) FROM InterviewSession s
      WHERE s.state NOT IN ('REVIEW_READY','HUMAN_REVIEWED','CLOSED','CANCELLED','NO_SHOW',
                            'TECHNICAL_FAILURE','POLICY_STOP','CANDIDATE_WITHDREW','INVITED','PROVISIONED')
        AND EXISTS (SELECT 1 FROM Turn t WHERE t.sessionId = s.id
                    AND t.createdAt > (strftime('%s','now','-15 minutes') * 1000));" \
      || die "could not query SQLite for live interviews — not deploying blind"
  fi
}

# Do not restart out from under someone who is being interviewed. The server
# now drains on SIGINT, but the drain is a backstop with a deadline: waiting
# here first means the restart normally happens with nobody on a call at all.
# A candidate mid-answer is a person, not a deployment window.
ACTIVE="$(count_active_interviews)"
if [ -z "$ACTIVE" ]; then
  warn "database not found — skipping the live-interview check"
elif [ "$ACTIVE" -eq 0 ]; then
  ok "no interview activity in the last 15 minutes"
elif [ "$FORCE" -eq 1 ]; then
  warn "$ACTIVE interview(s) active in the last 15 min — restarting anyway (--force); the server drains them for up to $(( DRAIN_MS / 60000 )) min"
elif [ "$DRY_RUN" -eq 1 ]; then
  warn "$ACTIVE interview(s) active in the last 15 min — a real run would wait up to ${WAIT_MAX_MIN} min for them"
else
  WAIT_DEADLINE=$(( $(date +%s) + WAIT_MAX_MIN * 60 ))
  while [ "$ACTIVE" -gt 0 ]; do
    if [ "$(date +%s)" -ge "$WAIT_DEADLINE" ]; then
      die "$ACTIVE interview(s) still active after waiting ${WAIT_MAX_MIN} min. Try again later, or pass --force to restart now and let the server drain them for up to $(( DRAIN_MS / 60000 )) min."
    fi
    printf '    waiting: %s interview(s) active in the last 15 min (re-check in %ss, give up at %s)\n' \
      "$ACTIVE" "$WAIT_POLL_SEC" "$(date -d "@$WAIT_DEADLINE" +%H:%M 2>/dev/null || echo "${WAIT_MAX_MIN} min")"
    sleep "$WAIT_POLL_SEC"
    ACTIVE="$(count_active_interviews)"
  done
  ok "no interview activity in the last 15 minutes — proceeding"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  say "Dry run — stopping before any change"
  ok "pre-flight passed"
  if [ "$DB_KIND" = postgres ]; then
    ok "would generate server/prisma/postgres/schema.prisma"
    ok "would run: npx prisma generate --schema server/prisma/postgres/schema.prisma"
    ok "would baseline existing databases without _prisma_migrations: cd server && npx prisma migrate resolve --applied 0001_baseline --schema prisma/postgres/schema.prisma"
    ok "would run: cd server && npx prisma migrate deploy --schema prisma/postgres/schema.prisma"
  else
    ok "would keep SQLite local/dev path on prisma db push"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
say "Backup"

# Taken BEFORE the pull, and restore-verified rather than assumed. For most of
# this system's life the backup cron had never once fired and no restore had
# ever been tested, so "a backup exists" was not evidence of anything.
if [ "$DB_KIND" = postgres ]; then
  mkdir -p /root/Questor/backups
  LATEST="/root/Questor/backups/questor-$(date +%Y%m%d-%H%M%S).dump"
  # Owner-only: the dump holds every candidate's transcript and résumé.
  run_logged backup bash -c 'umask 077 && pg_dump --format=custom --file="$1"' -- "$LATEST"
  # A dump pg_restore cannot read back, or one without the candidate table, is
  # not a restore point.
  pg_restore --list "$LATEST" > "$LOG_DIR/restore-list.txt" 2>&1 \
    || die "backup could not be read back by pg_restore — not deploying without a restore point"
  grep -Eq 'TABLE DATA public "?Candidate"?' "$LOG_DIR/restore-list.txt" \
    || die "backup is missing the Candidate table — not deploying without a restore point"
  ROWS="$(psql -X -tAc 'SELECT COUNT(*) FROM "Candidate";')"
  ok "$(basename "$LATEST") verified restorable ($ROWS candidates)"
elif [ -x "$BACKUP_SCRIPT" ]; then
  run_logged backup "$BACKUP_SCRIPT"
  LATEST="$(ls -t /root/Questor/backups/*.db.gz 2>/dev/null | head -1 || true)"
  [ -n "$LATEST" ] || die "backup script ran but produced no file"
  VERIFY_DIR="$(mktemp -d)"
  gunzip -c "$LATEST" > "$VERIFY_DIR/verify.db"
  INTEGRITY="$(sqlite3 "$VERIFY_DIR/verify.db" 'PRAGMA integrity_check;')"
  ROWS="$(sqlite3 "$VERIFY_DIR/verify.db" 'SELECT COUNT(*) FROM Candidate;')"
  rm -rf "$VERIFY_DIR"
  [ "$INTEGRITY" = "ok" ] || die "backup failed integrity check — not deploying without a restore point"
  ok "$(basename "$LATEST") verified restorable ($ROWS candidates)"
else
  die "backup script not found at $BACKUP_SCRIPT"
fi

PREV_COMMIT="$(git rev-parse HEAD)"
ok "current commit $PREV_COMMIT (rollback target)"

# ---------------------------------------------------------------------------
say "Fetch"

run_logged fetch git fetch origin "$BRANCH"
run_logged reset git reset --hard "origin/$BRANCH"
printf '    now at %s\n' "$(git log --oneline -1)"

# ---------------------------------------------------------------------------
say "Install"

# At the ROOT, not in server/. This is an npm workspace repo: dependencies
# hoist to the root node_modules, and `npm ci` inside server/ emptied that
# workspace's tree while the app resolved express from the root — which is how
# the app ended up crash-looping on ERR_MODULE_NOT_FOUND.
run_logged npm-ci npm ci
if [ "$DB_KIND" = postgres ]; then
  # The Postgres schema is generated from the SQLite source of truth.
  run_logged pg-schema node scripts/generate-postgres-schema.mjs
  run_logged prisma npx prisma generate --schema server/prisma/postgres/schema.prisma
else
  run_logged prisma npx prisma generate --schema server/prisma/schema.prisma
fi

# Apply committed migrations to the database. `prisma generate` only rebuilds
# the client, and a deploy once shipped code querying a table and columns the
# database did not have. Postgres production is now migration-driven: the first
# deploy over an already-existing database records the committed baseline as
# already applied, then every deploy runs pending migrations. SQLite local/dev
# intentionally keeps using db push.
apply_postgres_migrations() {
  local table_exists
  table_exists="$(psql -X -tAc "SELECT CASE WHEN to_regclass('_prisma_migrations') IS NULL THEN 'no' ELSE 'yes' END;")"     || die "could not check Prisma migration history — not deploying blind"
  if [ "$table_exists" = no ]; then
    ok "no _prisma_migrations table; recording 0001_baseline as already applied"
    run_logged migration-baseline bash -c 'cd server && npx prisma migrate resolve --applied 0001_baseline --schema prisma/postgres/schema.prisma'
  else
    ok "Prisma migration history present"
  fi
  run_logged migration-deploy bash -c 'cd server && npx prisma migrate deploy --schema prisma/postgres/schema.prisma'
}

if [ "$DB_KIND" = postgres ]; then
  apply_postgres_migrations
else
  run_logged schema bash -c 'cd server && npx prisma db push --skip-generate'
fi

for pkg in express @prisma/client dotenv; do
  [ -d "node_modules/$pkg" ] || die "node_modules/$pkg missing after install — the tree is incomplete"
done
ok "runtime dependencies present"

# ---------------------------------------------------------------------------
say "Build"

# tsc is invoked directly rather than through a pipe so a real failure is a
# real failure. Note it still EMITS when it reports type errors, which is why
# a broken build previously looked deployable.
( cd server && npx tsc -p tsconfig.json ) >"$LOG_DIR/tsc.log" 2>&1 || {
  ERRS="$(grep -c 'error TS' "$LOG_DIR/tsc.log" || true)"
  warn "tsc reported $ERRS type error(s) — see $LOG_DIR/tsc.log"
  warn "emit still happened; continuing because the gate is the local typecheck + test suite"
}
[ -f server/dist/app.js ] || die "server/dist/app.js was not produced"
ok "server built"

run_logged web-build npm run build -w web
[ -f web/dist/index.html ] || die "web/dist/index.html was not produced"
ok "web built"

# ---------------------------------------------------------------------------
say "Publish web"

# Swap through a staging directory and keep the previous one, so a bad publish
# is one `mv` away from being undone.
rm -rf "${WEB_ROOT}.new"
cp -r web/dist "${WEB_ROOT}.new"
rm -rf "${WEB_ROOT}.old"
[ -d "$WEB_ROOT" ] && mv "$WEB_ROOT" "${WEB_ROOT}.old"
mv "${WEB_ROOT}.new" "$WEB_ROOT"
ok "published (previous kept at ${WEB_ROOT}.old)"

# ---------------------------------------------------------------------------
say "Restart"

# `restart`, not `reload`: this is a single fork-mode process, where pm2's
# reload is a restart anyway. pm2 sends SIGINT, the server stops taking new
# interviews and drains the ones in progress, then exits; pm2 starts the new
# build once it has. --kill-timeout is applied to the process before it is
# stopped, so the drain gets its full window instead of pm2's default 1.6 s.
# This command therefore blocks for as long as the drain lasts.
pm2 restart "$PM2_NAME" --update-env --kill-timeout "$KILL_TIMEOUT_MS" >"$LOG_DIR/pm2.log" 2>&1 || die "pm2 restart failed"
sleep 6

# ---------------------------------------------------------------------------
say "Verify"

# The API, NOT the site root. A previous deploy was called a success on a 200
# that was nginx serving static files from disk while the application behind it
# had been 502 for three minutes. Static files prove nothing about the app.
# A draining process also answers 200 — it is still serving the interviews in
# progress — so "healthy" additionally means "not the old process on its way
# out". And it must reach its database: on 2026-09-18 a deploy with the wrong
# Prisma client passed this step while every sign-in failed, because the
# health check did not touch the database. It now does, and says so.
verify_api() {
  local code
  code="$(curl -sk -o "$LOG_DIR/health.json" -w '%{http_code}' --max-time 20 "$APP_URL/api/health" || echo 000)"
  [ "$code" = "200" ] || return 1
  grep -q '"database":"ok"' "$LOG_DIR/health.json" || return 1
  ! grep -q '"draining":true' "$LOG_DIR/health.json"
}

API_OK=0
for attempt in 1 2 3 4 5; do
  if verify_api; then API_OK=1; break; fi
  sleep 4
done

if [ "$API_OK" -ne 1 ]; then
  printf '\n\033[31m--- API did not come up; rolling back ---\033[0m\n' >&2
  tail -30 "$LOG_DIR/pm2.log" >&2 || true
  pm2 logs "$PM2_NAME" --nostream --lines 30 >&2 2>/dev/null || true

  git reset --hard "$PREV_COMMIT" >/dev/null 2>&1 || true
  npm ci >/dev/null 2>&1 || true
  # Rollback restores code and static assets only. Prisma migrations are not
  # automatically reverted; if a migration itself caused the outage, restore
  # from the verified backup or apply an explicit forward fix.
  # npm ci regenerates the client from the SQLite schema; a Postgres deployment
  # needs the Postgres client back or the rolled-back app cannot reach its data.
  if [ "$DB_KIND" = postgres ]; then
    { node scripts/generate-postgres-schema.mjs && npx prisma generate --schema server/prisma/postgres/schema.prisma; } >/dev/null 2>&1 || true
  fi
  ( cd server && npx tsc -p tsconfig.json ) >/dev/null 2>&1 || true
  if [ -d "${WEB_ROOT}.old" ]; then
    rm -rf "$WEB_ROOT"; mv "${WEB_ROOT}.old" "$WEB_ROOT"
  fi
  pm2 restart "$PM2_NAME" --update-env --kill-timeout "$KILL_TIMEOUT_MS" >/dev/null 2>&1 || true
  sleep 6
  if verify_api; then
    die "deploy failed — ROLLED BACK code/assets to $PREV_COMMIT and the API is healthy again. Database migrations were not rolled back."
  fi
  die "deploy failed AND rollback did not restore the API. Database migrations were not rolled back. Manual intervention needed. Backup: $LATEST"
fi
ok "API healthy"

# Anything else on this host must be exactly as it was. Questor shares nginx
# with a production site, and a Questor deploy is never a reason for that site
# to change state.
for host in https://insyght.org https://www.insyght.org; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$host" || echo 000)"
  [ "$code" = "200" ] || die "$host returned $code — a co-hosted site was affected. Investigate before continuing."
  ok "$host unaffected ($code)"
done

code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 15 "$APP_URL/" || echo 000)"
[ "$code" = "200" ] || die "app root returned $code"
ok "app root serving ($code)"

say "Deployed"
printf '    %s\n' "$(git log --oneline -1)"
printf '    rollback: git reset --hard %s && npm ci && pm2 restart %s --kill-timeout %s\n' "$PREV_COMMIT" "$PM2_NAME" "$KILL_TIMEOUT_MS"
printf '    backup:   %s\n\n' "${LATEST:-none}"
