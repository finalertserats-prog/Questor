# Pending work

Written 2026-09-16, updated the same evening. Everything here is either
unfinished, unverified, or a decision someone still has to make. Work that is
done and deployed is not listed — `git log` is the record for that.

**Production is at `fd52201`.** Local `feature/postgres` is eleven commits ahead
of it and is NOT deployed. Do not assume parity; check before promising it to
anyone.

---

## 1. Signup with operator approval — committed, reviewed, NOT deployed

Branch: `feature/postgres`, signup work from `1334d15` through `796ba6e`.

Built by three lanes in parallel: Codex (server), a Claude agent (web), Gemini
(copy — rejected, see below). Merged clean, no file overlap.

**What exists:** a person requests an account; an email goes to the operator;
nothing is created until they approve. `SignupRequest` holds the pending row
(including a password hash) and mints nothing until approval. Decision links use
the same token scheme as candidate feedback — 32 random bytes, only the SHA-256
stored, shape-checked before any DB hit, `timingSafeEqual`.

**Fixed and committed (`a0db550`):** the five integration defects found by
reviewing the lanes against each other — success reported for a decision that
did not happen (now 409 at all three call sites), decline ignoring `expiresAt`,
the applicant's name reaching a mail header unsanitised, the expired-link page
pointing at a queue entry that no longer existed, and `SignupRequest` rows
sitting outside retention.

**Fixed and committed (`796ba6e`), from the Codex review of that commit:**

- The admin path fetched the row by id and skipped the expiry step the link
  path had, so an operator acting on an expired row from the queue was told it
  had "already been decided". Both paths now share one step and answer 410.
- A request whose link nobody ever opened stayed PENDING forever, password hash
  included. A PENDING row now ages out from the moment its link expired; one
  still inside its window is still never swept.

**Still to do:**

- [ ] Deploy.
- [ ] **Send a real signup through to `finalerts.erats@gmail.com`.** Nothing so
      far proves mail arrives. `EMAIL_PROVIDER=smtp` against a Gmail host with
      `EMAIL_FROM` set proves configuration, not delivery.
- [ ] `SIGNUP_APPROVER_EMAIL` is already set on the VPS. The endpoint fails
      closed with 503 without it, so if signup 503s in production, check that
      first.

**Known-good, verified independently:** identical `201 {status:'pending'}` for
known and unknown emails (no enumeration oracle, and no timing branch either —
Codex checked); double-approval creates one user, one welcome, and one 409;
approve-vs-decline races resolve to one winner; the tenant/user creation
transaction boundary is correct; the CSRF exemption regex cannot match
`/api/signupAnything`.

---

## 2. Organisation-first sign-in — built, verified in the browser, NOT deployed

The owner's model: choose your organisation first (typeahead after a few
letters), then sign in or request access for that organisation. Only the
developer creates organisations.

**Decided:** the lookup requires **3+ characters, prefix match only, capped at 8
results, rate-limited**, and never returns an organisation without a sign-in
slug. This is a deliberate, bounded disclosure — someone who knows a name can
confirm it uses Questor; nobody can harvest the client list by typing "a".

**Done:**

- `GET /api/orgs?q=` with five tests pinning each disclosure boundary
  (`a0db550`). Matching happens in application code, not via Prisma's
  `mode: 'insensitive'`, which SQLite rejects.
- The name search has its own rate-limit window of 120 per 15 minutes; the slug
  lookup keeps its 30 (`b4a009f`). Sharing one window would have locked a person
  out of signing in for typing their employer's name twice.
- `Login.tsx` and the "join" branch of `Signup.tsx` start with an organisation
  picker (`OrgPicker.tsx`, rules in `orgSearchModel.ts` with tests). Built by
  Codex in a worktree (`a360abc`), then tightened (`53bfcfd`): the fetch was
  being started from inside a state updater, which React runs twice in
  development; the list never closed on blur; a dropped connection read as "we
  can't find that organisation" and the query was then never retried. The old
  code input remains behind "Enter an organisation code instead".
- Seen working in Chrome against the local dev server: "acm" lists Acme Corp
  with its `/o/acme` link, Enter lands on that organisation's sign-in page, the
  signup join branch shows the chosen organisation with a Change action. No
  console errors on login, signup, the org page or About.

**Accepted, from the Codex review, and not changed:**

- The search reads every tenant that has a slug and filters in application
  code. Organisations are created only by the developer, so the table is tens
  of rows, not thousands; a DB-side case-insensitive prefix would need either
  Postgres-only `mode: 'insensitive'` or a normalised name column. Revisit if
  the tenant count ever makes this a real query.
- Prefix enumeration (`aaa`…`zzz`) can still recover names over time. At 120
  queries per 15 minutes per address that is roughly four days for the
  three-letter space alone, and the owner accepted the disclosure knowingly.
  If that changes, the options are authenticated discovery or invite-domain
  matching.

**Still to do:**

- [ ] The signed-in side was not checked: Chrome autofilled the org sign-in page
      from saved credentials, and Claude does not submit credentials. Sign in
      once by hand after deploying and look at the dashboard (see task #25
      below).

---

## 3. AI observer on human rounds (task #10) — decided, not built

Decided by the owner 2026-09-16:

- The observer **transcribes and extracts quotes against the role's
  competencies. It never scores, never recommends, never issues a verdict.**
  Evidence for a person, matching how the AI round already works.
- **Both the candidate and the interviewer consent**, and either may decline
  without blocking the round. This is what makes it usable in two-party-consent
  jurisdictions, and it protects interviewers too.
- Must reuse the existing consent-evidence and transcript-gate machinery rather
  than growing a parallel path.

---

## 4. Open decisions

- [ ] **"Silence is consent" on candidate feedback.** Today, a candidate who was
      never asked can still be sent feedback; only an explicit "no" blocks it.
      Strict ask-first would change that. As-built is deliberate but unconfirmed.
- [ ] **Operator-only connector tests** — whether test buttons should be limited
      to operators.
- [ ] **Teams/Zoom/Meet meeting creation** — currently connectors are configured
      and testable, but Questor does not create the meetings.

---

## 5. Carrying known risk

- **Webhook durability (Codex, High).** `candidate.human_request` fires only on
  the first click, so a failed webhook is never retried. It is now logged rather
  than swallowed, and the request stays visible to the hiring team in-app, so a
  lost webhook is a missed integration and not a lost request. A durable outbox
  is the real fix and does not exist.
- **Task #25 is deployed but never verified by eye.** The Stopped KPI, the
  `?state=stopped` filter, sparse-week trimming and the auto-fitting KPI grid all
  shipped; it needs a signed-in look, which Claude cannot do (see §2).
- **About / Candidate Journey / Login still carry `accent-wash` block fills.**
  About was looked at again tonight and reads clean at desktop width; the
  Candidate Journey and the Login hero were not examined for this. See the
  no-highlighter rule before touching.

---

## 6. Housekeeping

- Six stale git worktrees from finished branches: `wt-design`, `wt-feedback`,
  `questor-codex-feedback`, `questor-codex-hrux`, `questor-codex-proctoring`,
  and the two `peer-build-codex-*` temp worktrees (both merged). Safe to prune
  once their branches are confirmed merged.
- The secret-redactor hook fires on source identifiers (`password`,
  `passwordHash`, `TOKEN_SHAPE`, `decisionTokenHash`, a seed script that prints
  the word "Password:"). Every hit today was a false positive. Worth an
  exclusion so a real hit is not lost in noise.
- `~/.claude/council/codex_review.sh` pins `gpt-5.4`, which Codex on a ChatGPT
  account rejects, and it discards stderr, so it reports "review failed" with no
  reason. Running `codex exec` with the account's default model works.
  `peer_write.sh` kills each Codex attempt at 240 s, which a lane that runs
  `npm ci` plus tests always outlives; the files it wrote survive in the
  `--keep` worktree, so verify them yourself rather than waiting for a clean
  exit.
- The local dev database had fallen behind the schema (`CandidateFeedbackOptIn`
  missing). `npm run db:push -w server` then `npm run db:seed` brought it back;
  the demo tenant was given the slug `acme` by hand so the picker has something
  to find. Two different recognizer tests timed out at 5 s under parallel load
  and pass in milliseconds alone; the web suite now has a 20 s budget
  (`83bfcfd`) as headroom, not permission.
- **Gemini's copy lane was rejected**, not merged: it wrote the emails and UI in
  a fake-terminal voice (`[STATUS: TOKEN INVALID]`, invented ticket IDs, "RECORD
  SEALED"). Two findings from it were kept and are now in the code — mail
  scanners auto-fetching links (so approval must never happen on a GET), and
  flagging a domain mismatch when someone joins an org from a personal address.

---

## A note on process, for whoever picks this up

Three separate patches today were corrupted by writing escape sequences
(`\r`, `\n`, `\x00-\x1f`) inside a Python string inside a shell heredoc:
the escapes were expanded before reaching disk, producing literal control
characters in source. One broke a test file, one broke a regex in
`signupEmail.ts` and took the entire server suite down with it — thirty red test
files from one bad line. This file itself carried two of those bytes until
tonight, and the first attempt to repair it no-op'd for the same reason.

Write patches to a file and run the file. Build control characters from numeric
byte values or `String.fromCharCode` rather than escaping them through three
layers of quoting. Read a command's exit status directly: piping `tsc` through
`tail` reports the exit status of `tail`. And a backgrounded command may not
keep its `cd`: one full test run tonight executed from the repo root instead of
`web/`, hit the server tests with no schema applied, and printed 120 failures
that meant nothing. Use `npm run test -w server` / `-w web` from the root.
