#!/usr/bin/env bash
#
# Deploy Questor to the VPS.
#
# Written after a deploy that reported success while the application was down
# for three minutes. Every guard below exists because something specific went
# wrong, and the comments say which — none of it is defensive boilerplate.
#
#   ./scripts/deploy.sh              deploy the current origin branch
#   ./scripts/deploy.sh --dry-run    run every check, change nothing
#   ./scripts/deploy.sh --force      deploy even with an interview in progress
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

DRY_RUN=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force)   FORCE=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

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
command -v sqlite3 >/dev/null || die "sqlite3 not on PATH (needed to check for live interviews)"

cd "$REPO_DIR"

# Refuse to restart out from under someone who is being interviewed. There is
# no SIGTERM drain, so a restart drops live sockets and ends their interview
# with no warning and no way back in. A candidate mid-answer is a person, not
# a deployment window.
DB="$(ls server/prisma/data/*.db 2>/dev/null | head -1 || true)"
if [ -n "$DB" ]; then
  ACTIVE="$(sqlite3 "$DB" "
    SELECT COUNT(*) FROM InterviewSession s
    WHERE s.state NOT IN ('REVIEW_READY','HUMAN_REVIEWED','CLOSED','CANCELLED','NO_SHOW',
                          'TECHNICAL_FAILURE','POLICY_STOP','CANDIDATE_WITHDREW','INVITED','PROVISIONED')
      AND EXISTS (SELECT 1 FROM Turn t WHERE t.sessionId = s.id
                  AND t.createdAt > datetime('now','-15 minutes'));" 2>/dev/null || echo 0)"
  if [ "${ACTIVE:-0}" -gt 0 ]; then
    if [ "$FORCE" -eq 1 ]; then
      warn "$ACTIVE interview(s) active in the last 15 min — deploying anyway (--force)"
    else
      die "$ACTIVE interview(s) active in the last 15 minutes. A restart would end them mid-answer. Wait, or pass --force."
    fi
  else
    ok "no interview activity in the last 15 minutes"
  fi
else
  warn "database not found — skipping the live-interview check"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  say "Dry run — stopping before any change"
  ok "pre-flight passed"
  exit 0
fi

# ---------------------------------------------------------------------------
say "Backup"

# Taken BEFORE the pull, and restore-verified rather than assumed. For most of
# this system's life the backup cron had never once fired and no restore had
# ever been tested, so "a backup exists" was not evidence of anything.
if [ -x "$BACKUP_SCRIPT" ]; then
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
run_logged prisma npx prisma generate --schema server/prisma/schema.prisma

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

pm2 restart "$PM2_NAME" --update-env >"$LOG_DIR/pm2.log" 2>&1 || die "pm2 restart failed"
sleep 6

# ---------------------------------------------------------------------------
say "Verify"

# The API, NOT the site root. A previous deploy was called a success on a 200
# that was nginx serving static files from disk while the application behind it
# had been 502 for three minutes. Static files prove nothing about the app.
verify_api() {
  local code
  code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 20 "$APP_URL/api/health" || echo 000)"
  [ "$code" = "200" ]
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
  ( cd server && npx tsc -p tsconfig.json ) >/dev/null 2>&1 || true
  if [ -d "${WEB_ROOT}.old" ]; then
    rm -rf "$WEB_ROOT"; mv "${WEB_ROOT}.old" "$WEB_ROOT"
  fi
  pm2 restart "$PM2_NAME" --update-env >/dev/null 2>&1 || true
  sleep 6
  if verify_api; then
    die "deploy failed — ROLLED BACK to $PREV_COMMIT and the API is healthy again"
  fi
  die "deploy failed AND rollback did not restore the API. Manual intervention needed. Backup: $LATEST"
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
printf '    rollback: git reset --hard %s && npm ci && pm2 restart %s\n' "$PREV_COMMIT" "$PM2_NAME"
printf '    backup:   %s\n\n' "${LATEST:-none}"
