# Questor — plan of action (as of 2026-09-16)

## Where things stand

**Deployed in this release** (branch `claude/open-source-app-build-lnrqia`, from `feature/postgres`):

- UI shell: collapsible sidebar, profile menu (Settings / About / Admin console / Contact), SVG icon set, landing page with Gemini artwork, per-organisation sign-in links (`/o/:slug`), workflow diagram on the home page.
- Medallion pipeline: Participation → Bronze → Silver (the only AI-conducted round; HR may silently observe) → Gold / Platinum / Diamond (human rounds, AI as silent observer). Scheduling with email link, round notes, early decisions, consolidated evidence summary.
- Observer consent: live observation and live transcripts only after the candidate was told and answered.
- Retention: round notes expire; candidates still moving through a pipeline are never purged.
- PostgreSQL support in code: provider-swap schema generator, full test suite passes on Postgres (519/519), migration script with row-count verification.
- Deploy script fixes: applies new unique constraints safely; live-interview check actually works now (it never matched before); reads the database the app really uses and fails closed; Postgres password kept out of process lists.

**Verified before shipping:** 519/519 server tests on SQLite and on Postgres, 24/24 web tests, web build; Claude pre-deploy review CLEAN (its two MEDIUM findings fixed with tests); Gemini reviewed the cutover plan and script (findings fixed). Codex was rate-limited for the whole session and has not reviewed this release.

## Next steps, in order

### 1. PostgreSQL cutover on the VPS — NOT yet safe to run `--apply`
`scripts/cutover-to-postgres.sh` (hardened after Gemini's review). A Claude security review of the earlier version found items still to fix before the real cutover:

- [ ] Rollback must verify itself (poll `/api/health`, print MANUAL INTERVENTION if down); keep logs in a root-only directory.
- [ ] Before `pm2 stop`: read `PORT` from `server/.env` (not a default) and confirm the app answers; confirm a TCP login as `questor` (`psql -h 127.0.0.1 -U questor -d postgres`); use `pg_isready` rather than `systemctl is-active postgresql` (umbrella unit).
- [ ] On rollback, rename the `questor` database to `questor_failed_<stamp>` instead of leaving it to block a re-run (writes made in the ~60 s window stay there for inspection).
- [ ] Headroom pre-flight: SQLite size vs free RAM, `/dev/shm` and `/root` (abort below ~4x); `NODE_OPTIONS=--max-old-space-size=2048`; rehearsal copies the repo without `server/prisma/data`.
- [ ] Keep the role password out of Postgres logs: `SET log_statement='none'; SET log_min_error_statement='panic';` before CREATE/ALTER ROLE; only re-sync the password if a login fails; re-assert NOSUPERUSER/NOCREATEDB.
- [ ] Validate the stored password matches `^[0-9a-f]{64}$`.
- [ ] Nightly dumps named `questor-nightly-*.dump` so the 14-day prune never deletes deploy.sh's pre-deploy dumps; alert (not just log) on backup failure; retire the SQLite backup cron after cutover.
- [ ] `create_database`: check CREATE and REVOKE explicitly (errexit is off inside `||`).
- [ ] Get a Codex adversarial review once its rate limit clears.

Then, on the VPS (run inside `tmux`):
```bash
cd /root/Questor/repo
./scripts/cutover-to-postgres.sh --rehearse   # app keeps running; imports real data into a throwaway DB
./scripts/cutover-to-postgres.sh --apply      # short downtime; verified; auto-rollback to SQLite on failure
```
After cutover: watch `pm2 logs questor`, log in, open a candidate and a transcript, run a test interview, confirm the first nightly backup in `/root/Questor/backups/pg-backup.log`.

Watch for: résumé text containing NUL characters (Postgres rejects them) — the rehearsal will show it; strip `\u0000` in the migration if so.

### 2. Second UI release (built on separate branches, not yet reviewed or merged)
Worktrees under `D:/Projects/ClaudeCode/Questor/`:

| Branch | Worktree | What |
|---|---|---|
| `feature/dashboard-overhaul` | `wt-dashboard` | Dashboard: workflow on top, KPI cards, charts (interviews per week, pipeline funnel, outcomes), recent interviews at the bottom; `GET /api/dashboard/metrics` respecting assignment scope; Audit log moved to its own page in the profile menu |
| `feature/meeting-connectors` | `wt-connectors` | Per-adapter setup guides (vendor app, env var names, scopes, redirect URLs), configured status, "Test connection" endpoint (admin-only, audited, rate-limited, keys stay in `server/.env`) |
| `feature/ui-icons-polish` | `wt-icons` | Icons, status badges, empty states, skeleton loaders across the older pages; Gemini empty-state art in `web/brand-source/empty-*.png` |

For each: check the builder's commits, run server + web tests and the web build, get a review (Codex when available, else Claude), merge into `feature/postgres` (expect small conflicts in `web/src/pages/Admin.tsx`), then deploy with `scripts/deploy.sh`.

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
