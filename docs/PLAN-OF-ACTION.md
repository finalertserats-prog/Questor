# Questor — plan of action (as of 2026-09-16)

## Where things stand

**Deployed in this release** (branch `claude/open-source-app-build-lnrqia`, from `feature/postgres`):

- UI shell: collapsible sidebar, profile menu (Settings / About / Admin console / Contact), SVG icon set, landing page with Gemini artwork, per-organisation sign-in links (`/o/:slug`), workflow diagram on the home page.
- Medallion pipeline: Participation → Bronze → Silver (the only AI-conducted round; HR may silently observe) → Gold / Platinum / Diamond (human rounds, AI as silent observer). Scheduling with email link, round notes, early decisions, consolidated evidence summary.
- Observer consent: live observation and live transcripts only after the candidate was told and answered.
- Retention: round notes expire; candidates still moving through a pipeline are never purged.
- PostgreSQL support in code: provider-swap schema generator, full test suite passes on Postgres (519/519), migration script with row-count verification.
- Deploy script fixes: applies new unique constraints safely; live-interview check actually works now (it never matched before); reads the database the app really uses and fails closed; Postgres password kept out of process lists.

**Also deployed (2026-09-16, commit 4f9219c):** the HR dashboard overhaul (workflow, KPI cards, trend charts, recent interviews) with the audit log moved to its own page in the profile menu, and the meeting-connector setup guides with an admin-only "Test connection".

**Verified before shipping:** 576/576 server tests (and the same suite green on PostgreSQL), 58/58 web tests, clean types and web build. Claude reviewed each branch: the pre-deploy review was CLEAN, and the dashboard and connector reviews' findings were fixed with tests (AI interviews double-counted, audit-log query bounds and indexes, connector configuration detail reaching non-admins). Gemini reviewed the cutover plan and script. Codex hardened the cutover script once its usage limit reset; its `create_database` check compared psql's command tag, which quiet mode never prints, and that was fixed.

**PostgreSQL cutover: DONE (2026-09-16).** Production runs on PostgreSQL 16 in the cluster shared with insyght.org: database `questor`, role capped at 20 connections, verified row for row (23 candidates, 30 interviews, 224 turns), rehearsed against real data first. Restore points: `/root/Questor/backups/pre-postgres-<stamp>.db`, the original SQLite file (now read-only) and `/root/Questor/secrets/server.env.sqlite-<stamp>`. Nightly `pg_dump` runs from `/etc/cron.d/questor-pg-backup`, verified with `pg_restore --list`, kept 14 days. The app listens on port 4100.

## Next steps, in order

### 1. PostgreSQL cutover on the VPS — COMPLETED 2026-09-16
`scripts/cutover-to-postgres.sh` was hardened after Gemini's and Claude's reviews, rehearsed against production data with the app still running, and then applied. Everything below was done before the switch; the script stays in the repo for the next environment:

- [x] Rollback must verify itself (poll `/api/health`, print MANUAL INTERVENTION if down); keep logs in a root-only directory.
- [x] Before `pm2 stop`: read `PORT` from `server/.env` (fallback 4000) and confirm the app answers; confirm a TCP login as `questor` (`psql -h 127.0.0.1 -U questor -d postgres`); use `pg_isready` rather than `systemctl is-active postgresql` (umbrella unit).
- [x] On rollback, rename the `questor` database to `questor_failed_<stamp>` instead of leaving it to block a re-run (writes made in the ~60 s window stay there for inspection).
- [x] Headroom pre-flight: SQLite size vs free RAM, `/dev/shm` and `/root` (abort below ~4x); `NODE_OPTIONS=--max-old-space-size=2048`; rehearsal copies the repo without `server/prisma/data`.
- [x] Keep the role password out of Postgres logs: `SET log_statement='none'; SET log_min_error_statement='panic';` before CREATE/ALTER ROLE; only re-sync the password if a login fails; re-assert NOSUPERUSER/NOCREATEDB/NOCREATEROLE.
- [x] Validate the stored password matches `^[0-9a-f]{64}$`.
- [x] Nightly dumps named `questor-nightly-*.dump` so the 14-day prune never deletes deploy.sh's pre-deploy dumps; alert (not just log) on backup failure; retire the SQLite backup cron after cutover.
- [x] `create_database`: check CREATE and REVOKE explicitly (errexit is off inside `||`).
- [x] Get a Codex adversarial review once its rate limit clears.

Then, on the VPS (run inside `tmux`):
```bash
cd /root/Questor/repo
./scripts/cutover-to-postgres.sh --rehearse   # app keeps running; imports real data into a throwaway DB
./scripts/cutover-to-postgres.sh --apply      # short downtime; verified; auto-rollback to SQLite on failure
```
After cutover: watch `pm2 logs questor`, log in, open a candidate and a transcript, run a test interview, confirm the first nightly backup in `/root/Questor/backups/pg-backup.log`.

NUL characters in string values are stripped during import (with per-table counts), because PostgreSQL rejects them.

### 2. UI releases — all deployed as of 2120942 (2026-09-16)
Deployed: the dashboard overhaul and audit-log page, meeting-connector setup and testing, icons/status badges/empty states/skeletons with keyboard-reachable tables, the sidebar docked open with a collapsible rail, and the sign-in page showcase. Every branch was reviewed before merge and its findings fixed: the drawer reopening itself after a resize, a reduced-motion sequence restarting on hover, three sign-in claims the code did not support, audit actor names vanishing after page 1, connector configuration readable by any signed-in user, and missing tenant/date indexes.

### 2a. In flight
| Branch | Worktree | What |
|---|---|---|
| `feature/guided-tour` | `wt-tour` | First-sign-in product tour: anchored steps over the real UI, skippable, restartable from the profile menu, completion stored per user on the server |

Review it, merge into `feature/postgres`, deploy with `scripts/deploy.sh`.

### 2b. ScaleHealthTech pilot
Organisation and administrator exist in production (`/o/scalehealthtech`). The password is on the server at `/root/Questor/secrets/questor-…` — root-only, never copied into the repo. The user guide is built in `D:/Projects/ClaudeCode/Questor/deliverables/` (Word + PDF from one Markdown source via `build-guide.py`), drafted by Gemini and checked against the code by Codex.

### 3. Backlog
- AI observer transcription for human rounds (needs a decision: hosted Questor room vs Teams/Zoom).
- Band-calibrate the work-sample practical questions (weakest area in the stability sweep).
- Profile photo upload (initials only today); per-role stage configuration UI; AI-written consolidated report card.
- Open review LOWs: pipeline `decisionReason` / `interviewersJson` not covered by time-based retention; consent POST racing a round schedule can leave a wrong audit record (fails safe); observer flag tied to English disclosure text once translations are added.
- Open disagreement DIS-005 (Gemini objected to the guarded `--accept-data-loss` retry for the new unique slug column; kept, with evidence).

## How to deploy
```bash
# locally
git push origin feature/postgres:claude/open-source-app-build-lnrqia
# on the VPS
ssh root@187.127.166.193
cd /root/Questor/repo && git fetch origin claude/open-source-app-build-lnrqia
git show origin/claude/open-source-app-build-lnrqia:scripts/deploy.sh > /tmp/deploy.sh
bash /tmp/deploy.sh --dry-run && bash /tmp/deploy.sh
```
(Running the fetched copy matters when deploy.sh itself changed: the checked-out copy is the old one until the reset.)
