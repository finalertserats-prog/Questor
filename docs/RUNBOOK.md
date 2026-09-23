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

## Local model fallback (Ollama)

Interviews keep running when the AI provider fails (no credit, a bad key, an outage, or answers too slow for a spoken turn). The interviewer's spoken turns move down a chain: the provider (OpenAI), then a small open model on this server through Ollama, then the built-in writer. The local model only writes the acknowledgement around a question that is already in the plan (the library ladder, or the built-in writer's own question). It never writes a question, and grading, reports and feedback letters never use it. Its words are checked before they are spoken: length, no question of its own, no name or figure the candidate did not give, no praise, no instructions read back. A reply that fails gets one retry, and then the built-in writer takes the turn. The switch is off by default (`LOCAL_LLM_ENABLED=false`), and off is exactly the old chain.

### Phase 0: benchmark first (about 30 minutes)

Install Ollama as a service. It listens on `127.0.0.1:11434` only. Do not open that port in the firewall or proxy it through nginx.

```bash
curl -fsSL https://ollama.com/install.sh -o /tmp/ollama-install.sh
less /tmp/ollama-install.sh            # read it before running it
sh /tmp/ollama-install.sh              # creates the ollama user and the systemd unit
systemctl edit ollama                  # add the overrides below, save
systemctl daemon-reload && systemctl restart ollama && systemctl enable ollama
ollama pull llama3.2:3b
ollama pull phi4-mini
cd /root/Questor/repo && npm run llm:bench -w server -- --runs 3
```

The overrides for `systemctl edit ollama`. With four cores, one request at a time is fastest, and keeping one model resident avoids a cold load in front of a candidate:

```ini
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_KEEP_ALIVE=24h"
```

The benchmark prints, for each model and for each of the three spoken jobs: time to first token, total time, writing and prompt-reading speed (tokens per second), whether every reply was valid JSON, one sample reply to judge by ear, and the memory the loaded model holds. Pick the model that stays under the latency targets with acceptable glue. The targets are first token under 8 s and total under 12 s, the defaults of `LOCAL_LLM_FIRST_TOKEN_MS` and `LOCAL_LLM_TIMEOUT_MS`. Both candidate licences are acceptable (Llama 3.2 Community License, MIT). Qwen2.5-3B is not: its licence is research-only. After choosing, remove the other model with `ollama rm <model>`.

### Turning it on

1. In the server `.env`: `LOCAL_LLM_ENABLED=true` and `LOCAL_LLM_MODEL=<the chosen model>`. Keep `LOCAL_LLM_URL` at its default unless Ollama runs elsewhere. Only raise the two latency settings if the benchmark says the model needs it.
2. Check that `SIGNUP_APPROVER_EMAIL` is set and email delivers. The first credit or key failure sends the operator one email, and no more until the provider answers again (at most one an hour).
3. Restart: `pm2 restart questor --update-env --kill-timeout 1260000`.
4. Check: `GET /api/health` now carries `llm: { layer, provider, localFallback: true, coolingDown, lastFailureClass }`. The fields the deploy verifies are unchanged. Admin → System health → "AI serving layer" shows which layer serves interviews, the cooldown and the last failure.

### How switching works

- A provider that fails for a reason another layer can avoid is rested and the next layer takes the turn. Those reasons are a bad key, no credit, rate limits, 5xx, a timeout, a dropped connection, and two slow answers in a row. The rest is 5 minutes for credit or key failures (`LLM_OUTAGE_COOLDOWN_MS`) and 30 s for the others (`LLM_TRANSIENT_COOLDOWN_MS`). It doubles on every repeated failure, up to `LLM_MAX_COOLDOWN_MS` (15 min). When the rest ends, a single request probes the provider, and interviews move back on their own when it answers.
- A bad request or an unusable reply does not fail over. The built-in writer takes that turn, as before.
- Every turn shares one budget (`INTERVIEWER_LLM_TIMEOUT_MS`, 12 s). If the provider used it up by timing out, that one turn goes to the built-in writer and the next turns go straight to the local model.
- The intent read ("stop", "later", "pause" phrased unusually) is not sent to the local model. It would queue ahead of the spoken turn on four cores. The pattern check still runs.
- Each interviewer turn records which layer wrote it. The assessment page tells the reviewer how many questions ran on the backup model or the built-in bank, so thinner probes are not held against the candidate (`GET /api/assessments/:id` → `servingMode`).

### Incidents

- **Admin → System health says "local model is serving interviews":** read the reason. Out of credit: top up the provider account. Key refused: fix the key and restart. Otherwise it is the provider's outage, and nothing needs doing.
- **"Interviews are down to the built-in writer":** check Ollama with `systemctl status ollama`, `journalctl -u ollama -n 100` and `curl -s 127.0.0.1:11434/api/ps`. Interviews still run correctly, with plainer wording.
- **To turn the fallback off:** set `LOCAL_LLM_ENABLED=false` and restart. Ollama can keep running; nothing calls it.

## HR-Box reminders and daily summary

HR-Box is the console's Home tab: what needs each HR user, what is coming up, and what was done. The Home page itself needs no setting. Its two email add-ons are off until the owner has seen them, each behind its own switch.

**Reminders (`REMINDERS_ENABLED=false`).** When on, a candidate who has not started gets a reminder on day 3 and day 10 of the 14-day invitation, and each recruiter who owns the candidate (else the role's owners) gets one warning about 2 days before the link closes. No reminder goes if the link has expired, the candidate has started or finished, the application was decided, the role is archived, the candidate asked to talk to a person, or the invitation was sent again in the last 24 hours. Demo sandboxes get none. A job was down past day 10: only the day-10 note goes, not both. A re-invite sets a new expiry and starts its own reminders. And nothing is ever sent for an invitation posted before the switch was thrown — see "The cutoff" below.

**Daily summary (`DIGEST_ENABLED=false`).** When on, each HR user who can read candidates gets their "Needs you" rows by email once a day, between `DIGEST_HOUR` (default 8) and six hours later on the organisation's own clock. Nothing waiting, no email; a morning missed because the server was down is skipped, not sent at night. Each user can switch it off in Settings.

**Turning them on:**

1. Check email delivers (`EMAIL_PROVIDER` is `smtp` or `sendgrid`). With a provider that does not deliver, both jobs claim nothing and say so in their job record, so nothing is lost.
2. In the server `.env`: `REMINDERS_ENABLED=true` and/or `DIGEST_ENABLED=true` (and `DIGEST_HOUR` if 8 is wrong). Leave `REMINDERS_START_AT` empty — the job draws the line itself.
3. Restart: `pm2 restart questor --update-env --kill-timeout 1260000`.
4. Check: `GET /api/admin/ops` lists `invitation-reminders` and `daily-digest` within 15 minutes, each with a note of what it sent. The first reminders note reads `candidates: 0 sent` — that is the cutoff working, not a fault.
5. Confirm the line was drawn: `SELECT "activeFrom" FROM "ReminderWindow";` should be the moment of that first pass.

**The cutoff: new invitations only.** Throwing the switch does not chase the people already in flight. The first pass the job makes with `REMINDERS_ENABLED=true` writes the moment it ran into the single `ReminderWindow` row (`id = 'reminders'`, column `activeFrom`) and never moves it again. An invitation whose latest send is older than that line gets no day-3 note, no day-10 note and no recruiter warning — not on that pass and not on any later one. So **the owner sets `REMINDERS_ENABLED=true` and restarts, and nothing else**: there is no date to remember and no window to time the restart into.

What counts as "sent" is the invitation's `sentAt` (its creation, for one created but never delivered). A **resend** (`POST /interviews/:id/resend`) moves `sentAt`, so an older invitation the recruiter chases again after the switch becomes eligible from that point: the recruiter has just asked this candidate to come in, and the follow-up belongs with it. The stage is still counted from the original 14-day window, so what goes is whichever note is current — and never sooner than 24 hours after the resend, by the quiet rule above. An invitation nobody resends is left alone for good.

**Moving the line afterwards (`REMINDERS_START_AT`).** Optional, and normally unset. An ISO date (`2026-09-24`, read as midnight UTC) or date-time (`2026-09-24T09:00:00Z`) that overrides the stamp: set it earlier to pick up invitations already in flight, later to hold reminders off until then. A value the server cannot read stops it starting, rather than being taken as "no cutoff" and mailing every open invitation at once. It does not overwrite the stamp, so clearing the variable returns to the moment the switch was thrown.

**Checking the line.** `SELECT * FROM "ReminderWindow";` — one row, or none if reminders have never run. To re-draw it deliberately, stop the server, update `activeFrom` (or delete the row so the next run re-stamps), start again.

**The backlog, if it is ever wanted.** Reminders are counted from the invitation, so setting `REMINDERS_START_AT` to a date before the current invitations went out makes candidates already past day 3 eligible — the day-10 note if they are past day 10, never both. That backlog goes out at up to 25 emails per kind every 15 minutes. It is off by default, and is the only way to get it.

**The daily summary has no cutoff**, deliberately: it is a report to your own staff of what needs them, not a chase of candidates, so it keeps listing every invitation about to close, including ones from before reminders were switched on.

**How it stays at most once.** Each reminder is an `InvitationReminder` row, and each summary a `DigestDelivery` row, written before the email goes under a unique key (invitation + expiry + kind + recipient; user + day). A restart or a second instance cannot send one twice. A crash between the row and the send loses that one email rather than repeating it. A failed send is recorded (`status = failed`) and not retried. Every reminder is audited (`invitation.reminder_sent`, `_failed`, `_skipped`) against the interview.

**To turn them off:** set the switch to `false` and restart. Nothing else changes.

**Who else has opened it.** Opening an assessment now writes one `assessment.opened` audit row (user id and assessment id only) per person per hour. HR-Box uses it, with the existing interview-opened events, to show colleagues who have already looked.

## Role calibration

*What the evaluator learns from what reviewers decided. Full design in `docs/plans/role-calibration.md`.*

**Off unless two switches are on.** `CALIBRATION_ENABLED=true` in the deployment env, AND `calibrationEnabled` in the organisation's policy (Admin -> Organisation). With either off, observations are still captured -- the record of what reviewers decided is worth keeping whatever the scoring does -- but nothing is aggregated, activated or applied.

**What it does when it is on.** A daily leased job (`role-calibration`) recomputes each organisation's calibration, refreshes the reviewer-pattern alerts, and contributes to the shared pool where an organisation has opted in. An adjustment is at most one level, on one role's one competency at one band, and applies ONLY to interviews assessed after it activated. Nothing already assessed is ever changed.

**Where to look.** Admin -> Calibration shows what is applied, what is held and why, the evidence behind each, and the reviewer patterns. Every activation and withdrawal is audited (`calibration.activated`, `calibration.withdrawn`, `calibration.held`, `calibration.reverted`) and emails the organisation's admins.

**To switch one off:** Admin -> Calibration -> "Switch this off", with a reason. It stops applying from the next interview assessed, it is audited, and the daily job will not turn it back on. "Let it be reconsidered" puts it back in the queue, where it must clear every threshold again.

**To switch everything off for one organisation:** set `calibrationEnabled` to false in its policy. Everything active is withdrawn on the next run. **For every organisation at once:** `CALIBRATION_ENABLED=false` and restart.

**The fairness gate fails closed.** Before any activation the adjustment is replayed over that role's past assessments and checked against the outcome statistics. A role with too few outcomes for those statistics to read is HELD, not activated -- so a new organisation will see everything held until it has enough hiring history, and that is correct rather than a fault. `CALIBRATION_REQUIRE_FAIRNESS_CHECK=false` relaxes this to the replayed projection alone; it is a deliberate reduction in safety and should be a decision, not a default.

**If a score moved and somebody asks why.** The answer is on the assessment itself: each calibrated competency carries the model's own level, the calibrated level and a provenance line naming the number of reviews, the number of reviewers and the date they start from. The audit event for the activation carries the full fairness check and the confidence interval. Neither depends on the adjustment still existing.

**The shared calibration** (`CALIBRATION_GLOBAL_ENABLED`, plus the organisation's own `calibrationGlobalContribution` opt-in) shares role, competency name, band, both levels, the month and a one-way reviewer code. It never shares the organisation, the candidate, the reviewer's identity or anything a reviewer wrote. Turning the opt-in off stops further sharing; what has already been contributed cannot be traced back, which is also why it cannot be picked out and withdrawn.

**Reviewer statistics are employee data.** Every admin view of them is audited (`reviewer.pattern.viewed`). Every reviewer can read their own at `/api/admin/calibration/reviewers/me`. Nothing is done to a reviewer automatically -- no status change, no access removed, nobody told but your own admin. The one automatic effect is that a flagged reviewer's observations stop feeding calibration until an admin closes the alert: a brake on what the model learns, not a sanction on the person. The legal questions this raises are listed in the plan for the solicitor's pack.

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
