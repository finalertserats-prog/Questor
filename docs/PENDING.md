# Pending work

Updated 2026-09-17, for the `release/2026-09-17` branch. Everything here is
either unfinished, unverified, or a decision someone still has to make. Work
that is done is in `git log`; the shape of the system is in
`docs/ARCHITECTURE.md`; operations in `docs/RUNBOOK.md`.

**Production tracks `origin/claude/open-source-app-build-lnrqia`.** `deploy.sh`
runs on the VPS and resets to that branch, so a release is pushed to both
that name and `feature/postgres`. Check `/api/health` `commit` before
promising parity to anyone.

---

## 1. What this release changed (for orientation, not a task list)

Every item open on 2026-09-16 was built, tested and reviewed in parallel lanes,
then merged into one branch:

- **Deploys no longer end interviews.** SIGTERM/SIGINT drains: new interview
  starts are refused with a retryable message, live sessions are served until
  they end (up to `SHUTDOWN_DRAIN_MS`, default 20 min), then the process exits.
  `deploy.sh --wait` (the default) waits for recent interviews first; pm2's kill
  timeout is set above the drain on every restart.
- **Rate limits are shared** through the `RateLimitBucket` table
  (`RATE_LIMIT_STORE=database` in production); auth and signup limiters fail
  closed if the store is down, the rest fail open with a warning.
- **ATS belongs to the tenant.** `AtsConnection` per organisation (key sealed,
  write-only, and never carried across a change of address or account),
  imports recorded per ATS account, exports only to a stored
  `CandidateAtsLink`. The env ATS works only when bound by `ATS_TENANT_ID`.
  Meeting connector tests are operator-only.
- **Human rounds get real meetings** from Teams, Zoom or Google Meet
  (`ROUND_MEETING_PROVIDER`, per-tenant override), with a manual-link fallback,
  reschedule and cancel. Cancel records `CANCEL_PENDING` before calling the
  vendor so a crash never loses a live meeting's id; AI rounds cannot be moved
  from the round screen.
- **Candidate feedback needs a real yes.** Never-asked and declined both block
  sending, with a recruiter-sent opt-in request link; a failed resend leaves the
  previous link working.
- **The v1 webhook signature is retired per webhook.** Existing webhooks keep it
  (the migration backfills the flag); new ones are v2-only;
  `WEBHOOK_V1_SIGNATURE=off` drops it everywhere.
- **AI observer on human rounds (task #10)**: both parties consent, transcribe
  and quote only (verbatim, validated in code), covered by holds, retention and
  erasure.
- **Corrupt stored JSON fails loudly** wherever it decides scoring, consent or an
  outcome; optional display data keeps a logged fallback.
- **Webhook delivery connects to the DNS answer it checked**, closing the
  rebinding window.
- **Transcript turns on Postgres** are appended behind a session row lock; two
  simultaneous answers no longer lose one (found by running the suite on
  Postgres, which SQLite could not show).
- **Web**: sidebar full width and full height at desktop, no overlap at any
  width, integer chart axes, every form label bound to its control, phone-width
  title and scroll fixes.
- **Playwright smoke suite** (6 specs, including a dashboard screenshot) runs
  green and is wired into CI.
- One migration, `20260917143555_release_2026_09_17`, rehearsed on a
  baseline-only Postgres with live rows; `scripts/test-migrations.mjs` and the
  full server suite pass against Postgres.

Verified earlier the same day: the owner onboarded a new user through signup,
so the signup email path and operator approval work in production.

---

## 2. Still open

- [ ] **Real-device checks that tests cannot make**: observer microphone capture
      on the VPS origin; one real meeting created with each vendor once
      credentials exist (all vendor calls are tested against mocked HTTP only).
- [ ] **Generic ATS connector paths** (including the `X-ATS-Account` header) are
      assumed and tested against a mock, not a live ATS.
- [ ] **ATS candidate import has no UI**; the endpoint
      (`POST /api/candidates/import-ats`) exists.
- [ ] **Meeting creation runs inside the schedule request.** With token retries
      it can exceed the web client's 30 s timeout: the booking is saved and
      appears on reload, but the recruiter first sees an error. Moving creation
      to a background step removes this.
- [ ] **Meeting vendor credentials are deployment-wide**, so two tenants that
      both pick Zoom share one Zoom account.
- [ ] **Feedback opt-in cooldown** is check-then-write; two exactly simultaneous
      requests could both send (the button is disabled while one is in flight).

## 3. Decisions for the owner

- [ ] **Switch v1 signatures off** per webhook (Admin → Webhooks) as each receiver
      confirms it verifies `x-questor-signature-v2`; then set
      `WEBHOOK_V1_SIGNATURE=off`.
- [ ] **Observer**: should the candidate consent link also be emailed, and may a
      stopped observer be restarted with fresh consent (today a stop is final
      for the round)?
- [ ] **Look at the dashboard by eye** (task #25). The e2e suite saves a
      full-page capture to `e2e/test-results/dashboard.png` on every run.

---

## 4. Operations

- The restore drill (`scripts/restore-drill.sh`) has been dry-run against the
  2026-09-17 nightly dump, which `pg_restore --list` reads as a valid custom
  archive. Run it for real on the VPS monthly and before schema changes.
- After the first deploy with the drain, run `pm2 save` once so the kill timeout
  survives a reboot (see RUNBOOK).

## 5. Housekeeping

- `~/.claude/scripts/hooks/secret-redactor-output.js` still fires on identifiers
  (`token`, `password`, `decisionToken`). A patch that skips code references for
  labelled patterns only is waiting for the owner to apply; the tooling may not
  edit its own security hooks.
- Codex on this machine: `codex exec -s read-only` with the diff on stdin works
  for reviews; it cannot read files in read-only mode.

---

## A note on process

Write patches to files and run them; never build source through escape
sequences in a shell heredoc (they expand on the way to disk here). Read exit
codes directly; `tsc | tail` reports `tail`'s. Never run two vitest processes
at once in one checkout: workers share `test-w*.db`. A backgrounded command can
lose its `cd`; use the workspace scripts from the root. To test against
Postgres without Docker, `embedded-postgres` started through `pg_ctl` works on
this machine (Postgres refuses to run directly from an elevated shell).
