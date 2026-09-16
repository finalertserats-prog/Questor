# Questor operations runbook

This runbook is for an operator with shell access to the production VPS.

## What runs where

Production is one VPS today. It runs one pm2 process named `questor`, PostgreSQL, nginx/static web files, and nightly PostgreSQL dumps named `questor-nightly-*.dump` produced by `/root/Questor/backup-questor.sh`. Confirm the dump format on the VPS; this runbook assumes a `pg_dump` custom archive.

Defaults from `scripts/deploy.sh`: repo `/root/Questor/repo`, branch `claude/open-source-app-build-lnrqia`, web root `/var/www/questor`, process `questor`.

## Daily checks

- `GET /api/health`; compare `commit` with `git rev-parse HEAD` and the intended release.
- `GET /api/admin/ops`; review job runs, webhook pending/due/failed counts, and model failures.
- `pm2 status questor`; if restarts increased, read `pm2 logs questor --nostream --lines 100`.
- `df -h`; confirm a fresh `/root/Questor/backups/questor-nightly-*.dump`.

## Weekly checks

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

The dry run is required. The script checks tooling and refuses to deploy over interviews active in the last 15 minutes unless `--force` is used. It backs up and restore-verifies before pulling, resets to `origin/claude/open-source-app-build-lnrqia`, runs root `npm ci`, generates the active Prisma client, runs `prisma db push`, builds server and web, swaps the web root, restarts pm2, verifies `/api/health`, and checks the co-hosted `insyght.org` sites.

Rollback resets to the previous commit, reinstalls, regenerates the Postgres Prisma client when needed, rebuilds, restores the old web root, restarts pm2, and checks the API. If rollback fails, use the printed backup path and inspect pm2 logs before more changes.

## Backups and restore drill

Run monthly and before schema changes:

```bash
cd /root/Questor/repo
./scripts/restore-drill.sh /root/Questor/backups/questor-nightly-YYYYMMDD.dump
```

The drill restores into `questor_restore_drill_<timestamp>`, checks core row counts, prints newest audit time and age, then drops the scratch database. Use `--keep` only for inspection and drop it afterwards. Use `--dry-run` to print commands without a database.

## Incidents

### API down

Check `/api/health`, `pm2 status questor`, pm2 logs, PostgreSQL reachability, and the last deploy output. Check environment variable names only in shared notes: `PORT`, `BIND_HOST`, `WEB_ORIGIN`, `DATABASE_URL`, `AUTH_SECRET`, `WEBHOOK_SIGNING_SECRET`, provider keys.

### Interview stuck

Check session state, `/api/admin/ops` incomplete-job runs, and Socket.IO logs. Do not restart during another active interview unless the operator accepts the interruption risk.

### Webhooks failing

Check `/api/admin/ops`, then recent `WebhookDelivery` rows for `lastError`, `attempts`, and `nextAttemptAt`. Confirm the receiver URL is public and that the receiver verifies `x-questor-signature-v2` and timestamp. v1 remains only for compatibility.

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
- Provider keys: rotate one at a time, restart with `pm2 restart questor --update-env`, then verify `/api/admin/providers` and one low-risk real operation.

## Known limits

- Single instance today.
- Rate limits are per process.
- Jobs and webhooks use leases, but the full deployment is not documented as multi-instance.
- Schema is applied by `prisma db push`; migrations are pending. See `docs/PENDING.md`.
- The restore drill proves the dump loads and core tables query; it does not prove full app behavior.

## Could not confirm from the repo

- Exact nginx configuration path and backup log path on the VPS.
- Actual current dump format; confirm `questor-nightly-*.dump` with `pg_restore --list` on the VPS.
