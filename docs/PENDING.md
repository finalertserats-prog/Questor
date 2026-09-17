# Pending work

Updated 2026-09-16, late evening, at the end of the enterprise hardening pass.
Everything here is either unfinished, unverified, or a decision someone still
has to make. Work that is done is in `git log`; the shape of the system is in
`docs/ARCHITECTURE.md`; operations in `docs/RUNBOOK.md`.

**Production tracks `origin/claude/open-source-app-build-lnrqia`.** `deploy.sh`
runs on the VPS and resets to that branch, so `feature/postgres` is pushed to
both names on every release. After this evening's second deploy all three (local,
GitHub, VPS) are on the same commit; check `/api/health` `commit` before
promising parity to anyone.

---

## 1. What this pass changed (for orientation, not a task list)

Three independent audits (Claude security, Claude silent-failure, Claude web
review) plus three Codex audits (auth, integrity, web) ran against the whole
application. Everything rated High or Critical is fixed and tested, except the
items in §3. Highlights, so nobody re-audits them:

- Authorisation is read from the database on every request; the live
  interview socket enforces capability, object scope and observer consent; the
  signup queue is operator-only; a finished interview's link is read-only.
- Invitation tokens are hashed for lookup and sealed under AUTH_SECRET for
  display (`services/invitations.ts`); a startup backfill converted the rows
  that existed. Rotating AUTH_SECRET now also makes stored links unopenable
  until resent.
- Background sweeps run under database leases with recorded runs and operator
  alerts (`services/jobs.ts`); webhook retries are durable rows; deliveries
  carry a timestamped v2 signature alongside the original.
- Scorecards are validated on save and on approval (weights total 100%,
  threshold 0..100); resumes score against the approved scorecard.
- Finalisation is single-writer, turn indexes are unique, a grading outage is
  `SCORING_UNAVAILABLE` rather than 0/100, stranded PROCESSING sessions are
  released by the sweep.
- Erasure reaches integrity events, honours legal holds on resume artifacts,
  and keeps the free-text reason out of the surviving audit row.
- The web client: the consent step honours the candidate's choice with a typed
  fallback, no NaN anywhere a score is missing, confirmations before
  irreversible actions, per-action progress, request cancellation, one date
  format, the interviewer's real name.
- `GET /api/admin/ops` is the operator's one-page health view.

---

## 2. Lanes: three landed, one to finish

Landed after the first deploy of the evening and deployed again (`f62f5d5`):

- **Prisma migrations** replace `db push` on the VPS (`scripts/migrations.mjs`,
  `scripts/deploy.sh`, `server/prisma/postgres/migrations/0001_baseline`).
  Production recorded the baseline on this deploy; every schema change from
  now on is `node scripts/migrations.mjs new <name>` against a scratch
  Postgres, committed, and applied by `migrate deploy`. `scripts/test-
  migrations.mjs` proves migrations == schema; it needs a scratch Postgres
  (`docker compose up -d db`), which was not available on the dev machine.
- **Runbook, restore drill, architecture note** (`docs/RUNBOOK.md`,
  `scripts/restore-drill.sh`, `docs/ARCHITECTURE.md`). The drill has been
  dry-run only; run it for real against a nightly dump on the VPS.
- **Web checklist verification**: three remaining gaps fixed (transcription
  failure recovery, deliberate signup declines, shared date helper).

Still to finish:

- [ ] **Playwright e2e smoke suite** (`codex/e2e` branch, worktree
      `.claude/worktrees/codex-e2e`, WIP commit). Five specs exist; login
      passes, four fail on selectors that do not match the live pages. Codex
      hit its usage limit mid-verification (resets 17 Sep 00:47 IST). Resume
      with the brief in the session scratchpad `codex/brief-e2e.txt`, fix the
      selectors, run twice green, then merge and enable the CI job.

## 3. Decisions for the owner

- [ ] **ATS requisition import is deployment-wide.** `POST /roles` with
      `sourceType: ats` fetches any requisition id from the one configured ATS
      before any tenant check. With one customer this is harmless; with two it
      is a cross-tenant read. Needs a tenant-owned ATS mapping. (Codex auth #5)
- [ ] **ATS export target is caller-supplied.** `externalCandidateId` is now
      shape-validated, but the right design is a stored mapping from candidate
      to ATS id. (Codex auth #6)
- [ ] **Retire the v1 webhook signature** once every known receiver verifies
      `x-questor-signature-v2` with the timestamp.
- [ ] **"Silence is consent" on candidate feedback**: a candidate never asked
      can still be sent feedback; only an explicit "no" blocks it.
- [ ] **Operator-only connector tests**; **Teams/Zoom/Meet meeting creation**.
- [x] **AI observer on human rounds (task #10)**: built (transcribe and quote
      only, both parties consent). Observer room at `/rounds/:roundId/observer`,
      candidate consent at `/observer-consent/:token`. Still to decide: whether
      the candidate link should also be emailed, and whether a stopped observer
      may be restarted with fresh consent (today a stop is final for the round).
      Needs a real-browser check of microphone capture on the VPS origin.

---

## 4. Carrying known risk

- **Rate limits are per process.** Fine on one instance; a second instance
  doubles every limit. Jobs and webhook retries are already safe across
  instances via leases; the limiter is the one remaining in-memory piece.
- **`parseJson` fallbacks** still hide corruption in a few places (pipeline
  `stagesJson`, some profile blobs). Assessments now refuse unreadable results;
  the rest is listed in the Codex integrity report (#8, #9).
- **SSRF checks resolve DNS at creation and delivery**, but a name that flips
  between the two checks is still a window. Webhook creation is admin-only and
  audited.
- **Task #25 (dashboard) has never been checked by eye** by the owner; Claude
  cannot sign in without submitting credentials.
- **No real signup has been sent end to end** to the approver address; nothing
  yet proves mail delivery in production.

---

## 5. Housekeeping

- Stale worktrees: `wt-design`, `wt-feedback`, `questor-codex-*`, the two
  `peer-build-codex-*` temp worktrees, and `.claude/worktrees/agent-*`
  (four Claude lanes, all merged or abandoned). Prune once confirmed.
- The secret-redactor hook fires on identifiers (`token`, `password`,
  `hashPassword(PASSWORD)`, `decisionToken`); dozens of false positives today,
  zero true ones. Worth an exclusion list.
- `~/.claude/council/codex_review.sh` pins `gpt-5.4`, which this account
  rejects; `codex exec` with the default model works, needs `< /dev/null`, and
  needs `--dangerously-bypass-approvals-and-sandbox` in a throwaway worktree to
  read files on this machine.
- Gemini (agy) was unavailable all evening: daemon/token issue.
- Four files are at or over the 800-line house limit
  (`candidateJourney.ts`, `shadowMode.ts`, `interviews.ts`, `dataRights.ts`).
  Split when next touched. `server/src/sim` belongs outside the production tree.

---

## A note on process

Write patches to files and run them; never build source through escape
sequences in a shell heredoc (they expand on the way to disk here). Read exit
codes directly; `tsc | tail` reports `tail`'s. Never run two vitest processes
at once: workers share `test-w*.db`. A backgrounded command can lose its `cd`;
use the workspace scripts from the root.
