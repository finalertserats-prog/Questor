# Questor operations runbook

This runbook is for an operator with shell access to the production VPS.

## What runs where

Production is one VPS today. It runs one pm2 process named `questor`, PostgreSQL, nginx/static web files, and nightly PostgreSQL dumps named `questor-nightly-*.dump` produced by `/root/Questor/backup-questor.sh`. Confirm the dump format on the VPS; this runbook assumes a `pg_dump` custom archive.

Defaults from `scripts/deploy.sh`: repo `/root/Questor/repo`, branch `claude/open-source-app-build-lnrqia`, web root `/var/www/questor`, process `questor`.

## Daily checks

- **Open Admin → System health** (profile menu → Admin console; it is the first tab). Signed in as the operator (the `SIGNUP_APPROVER_EMAIL` address) it answers most of the checks below without SSH: database reachability and latency, migration state, process memory and uptime, drain state, disk free, running commit, the newest backup and its age, every background job against its own interval, email/AI/speech/rate-limit/retention configuration, the webhook v1 switch, and account requests waiting. Signed in as any other admin it shows that organisation's own checks only. Green needs nothing; amber says what to watch; red says what to do. It re-checks itself every minute and caches each answer for 15 s (`GET /api/admin/health`).
- Only if something is red or amber, or the panel itself could not be checked:
  - `GET /api/health`; compare `commit` with `git rev-parse HEAD` and the intended release. It runs `SELECT 1` (2 s limit): `database: "ok"` with 200, or 503 with `status: "unavailable"`, `database: "unreachable"` when the process cannot reach PostgreSQL.
  - `GET /api/admin/ops`; review job runs, webhook pending/due/failed counts, and model failures.
  - `pm2 status questor`; if restarts increased, read `pm2 logs questor --nostream --lines 100`. Restart counts are the one daily check the app cannot see about itself.
  - `df -h`; confirm a fresh `/root/Questor/backups/questor-nightly-*.dump`.

The panel reads backups from `BACKUP_DIR` (default `/root/Questor/backups` when `NODE_ENV=production`), matching `questor-*.dump`: it warns past 26 h, fails past 50 h, and fails on a zero-byte or missing dump. If the app cannot read that folder it says so rather than reporting health it does not have.

## Weekly checks

- Admin → System health, with the healthy checks expanded: read the notes (legal holds, candidates without a resume, webhooks still on v1) rather than only the problems.
- Review the last week of ops job results and webhook failures.
- Confirm disk headroom for a new dump and a restore-drill scratch database.
- Open one recent candidate, transcript, and assessment in the UI.
- Review `docs/PENDING.md`; it lists accepted risks and unfinished work.

## Deploying

Run from the VPS, preferably in `tmux`. If `deploy.sh` changed, run the fetched copy:

```bash
cd /root/Questor/repo
git fetch origin claude/open-source-app-build-lnrqia
git show origin/claude/open-source-app-build-lnrqia:scripts/deploy.sh > /tmp/deploy.sh
bash /tmp/deploy.sh --dry-run
bash /tmp/deploy.sh
```

The dry run is required. The script checks tooling, then looks for interviews with a turn in the last 15 minutes. By default (`--wait`) it waits for them to finish, re-checking every `WAIT_POLL_SEC` seconds (default 30) for up to `WAIT_MAX_MIN` minutes (default 45). If they are still going at that point it stops without changing anything. `--force` skips the wait and restarts at once, and the server's own drain still protects the interviews (see below). The dry run reports active interviews but does not wait.

After the wait, the script backs up and restore-verifies before pulling. It then resets to `origin/claude/open-source-app-build-lnrqia`, runs root `npm ci` and generates the active Prisma client. On Postgres it runs `prisma migrate deploy`; the first time, it records `0001_baseline` as already applied if `_prisma_migrations` does not exist. SQLite dev hosts still use `prisma db push`. Then it builds server and web, swaps the web root and restarts pm2 with `--kill-timeout` (see below). Finally it checks that `/api/health` answers 200 with `database: "ok"` and `draining` not true (otherwise it rolls back), and that the co-hosted `insyght.org` sites are unaffected. Migrations are not rolled back automatically.

### The shutdown drain

On SIGINT or SIGTERM (pm2 sends SIGINT), the server does not exit at once:

1. It marks itself draining. `/api/health` still returns `status: "ok"`, plus `draining: true`.
2. It refuses new interview starts with HTTP 503 and `Retry-After`. The message tells the candidate this is a short update and asks them to try again in a couple of minutes. Socket joins and starts get the same message with `retryable: true`. Candidates already in an interview keep being served: their answers, a repeated start and a reconnect all still work. Staff can still observe.
3. It stops scheduling background jobs. A job that is already running is allowed to finish.
4. It waits until three things are true. No candidate it served in the last 15 minutes, or who holds a socket, is in a live or finalising state. No request or socket event is still running. No job is still running. It stops waiting after `SHUTDOWN_DRAIN_MS` (default 1200000, which is 20 minutes). It checks every 5 seconds and logs a warning if it had to cut interviews off.
5. It closes Socket.IO and HTTP, releases its job leases, disconnects Prisma and exits 0.

A second signal makes the server exit immediately with code 1. Use it with `pm2 stop questor` if you really have to stop it now. `deploy.sh` restarts pm2 with `--kill-timeout` set to `SHUTDOWN_DRAIN_MS` plus 60 s, which is why `pm2 restart` can take as long as the drain. pm2 remembers the kill timeout on the process. For a manual restart, pass it yourself anyway: `pm2 restart questor --update-env --kill-timeout 1260000`. Run `pm2 save` once after the first deploy so a reboot keeps the setting.

If a candidate is cut off at the deadline, their session stays in its live state (`ASSESSING`). They can reopen their link after the restart and carry on answering; the reopened room shows the opening question again. If a finalisation was cut off, the session is left in `PROCESSING`. The incomplete-interview sweep moves it to `TECHNICAL_FAILURE` once `INCOMPLETE_AFTER_MINUTES` has passed (default 60). It is never scored automatically.

Rollback resets to the previous commit, reinstalls, regenerates the Postgres Prisma client when needed, rebuilds, restores the old web root, restarts pm2, and checks the API. If rollback fails, use the printed backup path and inspect pm2 logs before more changes.

## Backups and restore drill

Run monthly and before schema changes. The drill must create a database, which
the app's own role may not do, and `root` has no Postgres role; so run it as
`postgres` from a private copy (that user cannot read `/root`), and remove the
copy afterwards because the dump holds candidate data:

```bash
D=$(mktemp -d /tmp/drill.XXXXXX)
cp /root/Questor/repo/scripts/restore-drill.sh /root/Questor/backups/questor-nightly-YYYYMMDD-HHMMSS.dump "$D"/
chown -R postgres:postgres "$D" && chmod 700 "$D"
(cd "$D" && sudo -u postgres env LOG_DIR="$D/logs" bash "$D/restore-drill.sh" "$D"/questor-nightly-*.dump)
rm -rf "$D"
```

Last real run: 2026-09-17 against `questor-nightly-20260917-023001.dump`,
restore status ok.

The drill restores into `questor_restore_drill_<timestamp>`, checks core row counts, prints newest audit time and age, then drops the scratch database. Use `--keep` only for inspection and drop it afterwards. Use `--dry-run` to print commands without a database.

## Incidents

### API down

Check `/api/health`, `pm2 status questor`, pm2 logs, PostgreSQL reachability, and the last deploy output. Check environment variable names only in shared notes: `PORT`, `BIND_HOST`, `WEB_ORIGIN`, `DATABASE_URL`, `AUTH_SECRET`, `WEBHOOK_SIGNING_SECRET`, `WEBHOOK_V1_SIGNATURE`, provider keys.

### Interview stuck

Check session state, `/api/admin/ops` incomplete-job runs, and Socket.IO logs. Restart with `pm2 restart questor --update-env --kill-timeout 1260000` so other interviews in progress are drained, not dropped.

### Webhooks failing

Check `/api/admin/ops`, then recent `WebhookDelivery` rows for `lastError`, `attempts`, and `nextAttemptAt`. Confirm the receiver URL is public.

If the failures are `status 401`/`403` from the receiver, it is usually the signature:

- The receiver must verify `x-questor-signature-v2`: lowercase hex HMAC-SHA256 with `WEBHOOK_SIGNING_SECRET` over `<x-questor-timestamp>.<raw body>`, where `x-questor-timestamp` is Unix time in **milliseconds**. It should refuse a timestamp more than **5 minutes** from its own clock, so a receiver with a drifting clock rejects everything; check its NTP. Full recipe and sample code: `docs/CONNECTORS.md` → "Verifying a delivery (v2)".
- `x-questor-signature` (v1, body only) is legacy. Only webhooks with `sendLegacySignature` on get it, and none do while `WEBHOOK_V1_SIGNATURE=off`. `GET /api/admin/ops` → `webhooks.legacySignature` shows `killSwitch`, `flagged` and `sending`.
- A receiver that broke right after v1 was switched off for it still checks v1. Quick fix: **Admin → Webhooks → Send v1 again** for that webhook (audited as `webhook.legacy_signature.changed`), then have the receiver move to v2. If the kill switch is what removed it, unset `WEBHOOK_V1_SIGNATURE` (or set it to `on`) and `pm2 restart questor --update-env`, which restores v1 for every flagged webhook.
- Failed rows are not retried automatically after the last attempt; re-emit or ask the receiver to reconcile once it is fixed.

### Email not delivering

Check `/api/admin/providers`. In production, `EMAIL_PROVIDER=console` means no delivery unless `ALLOW_UNDELIVERED_EMAIL=true` is intentional. Check `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SENDGRID_API_KEY`, and `EMAIL_FROM`; never put values in shared notes. Resend invitations after the provider is fixed.

### Erasure request

Use the product erasure flow. It removes candidate-derived data and keeps a non-personal audit event. Legal hold blocks erasure; release it only with accountable approval.

### Legal hold

Set hold before purge or erasure work. A hold on a session or artifact blocks retention purge. Keep sensitive reasons outside candidate free-text fields.

### Failed background job alert

Alerts go to `SIGNUP_APPROVER_EMAIL` at most once per job per hour when email is configured. Open `/api/admin/ops`, find the failed job note/holder/time, inspect pm2 logs, fix the cause, and confirm a later `ok: true` run.

## Rotating secrets

- `AUTH_SECRET`: invalidates all sessions and makes sealed invitation links unopenable. Resend or regenerate invitations.
- `WEBHOOK_SIGNING_SECRET`: coordinate with receivers; confirm v2 timestamped verification.
- Provider keys: rotate one at a time, restart with `pm2 restart questor --update-env --kill-timeout 1260000`, then verify `/api/admin/providers` and one low-risk real operation.

## Known limits

- Single instance today.
- Rate limits are shared across instances through the `RateLimitBucket` table (`RATE_LIMIT_STORE=database`, the production default). Expired windows are purged every 10 minutes by the lease-guarded `rate-limit-purge` job. If the database cannot be reached, login, auth and signup limits refuse requests with 503. Every other limit lets requests through uncounted and logs a warning at most once a minute per limiter. `RATE_LIMIT_STORE=memory` goes back to per-process counters.
- Jobs and webhooks use leases, but the full deployment is not documented as multi-instance. The shutdown drain counts only the interviews its own process is serving.
- A deploy with only one instance still has a gap. While the old process drains, candidates who have not started are asked to come back in a few minutes.
- Postgres schema changes go through `prisma migrate deploy` (`server/prisma/postgres/migrations`). SQLite dev hosts use `prisma db push`.
- The restore drill proves the dump loads and core tables query; it does not prove full app behavior.

## Could not confirm from the repo

- Exact nginx configuration path and backup log path on the VPS.
- Actual current dump format; confirm `questor-nightly-*.dump` with `pg_restore --list` on the VPS.
