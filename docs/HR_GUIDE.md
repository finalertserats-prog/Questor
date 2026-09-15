# Questor — HR User Guide

**Who this is for:** recruiters, hiring managers and reviewers using Questor to run
first-round interviews.
**What Questor does:** it runs a structured, voice-first first-round interview,
transcribes it, and produces an evidence-backed assessment.
**What Questor does not do:** it does not reject anyone. Every outcome is a
recommendation. A named human records the final decision, with a reason.

---

## 1. Before you sign in

| You need | Detail |
| --- | --- |
| The Questor address | **https://questor.187-127-166-193.sslip.io** — the pilot deployment. (A local development install runs at `http://localhost:5173` instead) |
| Your own account | One login per person — never a shared one (see §2) |
| A browser | **Chrome or Edge.** Voice capture uses the browser's speech engine, which Safari and Firefox do not fully implement. Candidates on other browsers can still type their answers |
| A microphone | Only for the interview room; not needed for reviewing |

---

## 2. Logging in

Go to the Questor address and enter your email and password on the sign-in page.

### Your credentials

**Everyone gets their own personal account.** Ask Vishnu, who administers the
pilot deployment, for one — and say which of the roles in section 3 matches what
you actually do. Your password should reach you through something other than
email, and should be treated like any other HR system credential.

There is no shared team login, and there is no self-service sign-up:

- **The "Register" link on the sign-in page is not your way in.** It creates a
  brand-new, separate organisation with its own empty database — it would not
  show you your colleagues' candidates. It is switched off on the pilot
  deployment.
- **`demo@questor.local` is not an account on the pilot deployment.** It is a
  development-machine login whose password is published in the public source
  code, and the script that creates it refuses to run against a production
  install. If you have seen those credentials in the README or a demo, they do
  not apply here — ask for a real account instead.

> **The pilot deployment holds real candidate data.** As of the last handoff there
> were 19 real candidates in it. Everything you do in Questor is done to live
> records, and is attributed to you by name.

### Rules the login enforces

| Rule | What it means for you |
| --- | --- |
| **Sessions last 1 hour** | You will be signed out after an hour and need to sign in again. This is deliberate: Questor holds candidate personal data and often runs on a shared desk |
| **10 failed attempts per 15 minutes** | Repeated wrong passwords temporarily block sign-in. Wait 15 minutes rather than retrying |
| **Passwords are at least 12 characters** | Applies to any account your admin creates |
| **Never share a login** | The audit log records who viewed and changed each assessment. Under a shared login, "who accessed this candidate's data?" has no answer — and candidates have a legal right to ask |

### Forgotten password

Questor currently has **no self-service password reset and no "change my
password" screen.** If you forget your password, Vishnu has to reset it for you
directly on the server — there is no email you can trigger yourself. Passwords
are stored only as one-way hashes, so nobody, including the administrator, can
look up your existing one; it can only be replaced. See the appendix.

### Signing out

Use **Sign out** at the bottom of the left sidebar. Always do this if you are
stepping away from a shared machine.

---

## 3. What each role can do

Your administrator sets your role when creating your account. Roles are
deliberately separated so that the person who writes a scorecard is not the person
who signs it off.

| | Recruiter | Manager | Reviewer | Auditor | Admin |
| --- | :-: | :-: | :-: | :-: | :-: |
| Create a role / edit scorecard | ✅ | ✅ | — | — | ✅ |
| **Approve** a scorecard | — | ✅ | — | — | ✅ |
| Add candidates & resumes | ✅ | — | — | — | ✅ |
| View candidates | ✅ | ✅ | ✅ | — | ✅ |
| Create / invite / schedule interviews | ✅ | ✅ | — | — | ✅ |
| Run the interview room | ✅ | — | — | — | ✅ |
| Read assessments | ✅ | ✅ | ✅ | — | ✅ |
| **Record the final decision** | — | ✅ | ✅ | — | ✅ |
| Export to ATS | — | ✅ | — | — | ✅ |
| Read the audit log | — | — | — | ✅ | ✅ |
| Manage users, connectors, retention | — | — | — | — | ✅ |

Two things follow from this table, and they are intentional:

- **A recruiter cannot approve the scorecard they wrote.** Get a manager or admin
  to approve it.
- **A recruiter cannot sign off the outcome of an interview they ran.** A manager
  or reviewer records the decision.

You also only see the roles and candidates you are assigned to. An admin controls
those assignments.

---

## 4. The end-to-end workflow

The left sidebar is grouped by how often you use it: **Review** (your daily loop)
on top, **Set up** below.

### Step 1 — Create the role  ·  *Set up → New role*

1. Paste the **full job description** into the box. The title is optional —
   Questor infers it if you leave it blank.
2. Submit. Questor produces a **Role Success Profile**: outcomes,
   responsibilities, a competency model with weights, red flags, and prohibited
   topics.
3. Read it properly. This scorecard is what every candidate is measured against,
   and it is what auditors will look at.
4. Edit anything that is wrong, then **Save**.
5. A manager or admin clicks **Approve**.

> **You cannot interview against an unapproved scorecard.** Questor blocks it.
> This is the human approval gate, not a formality.

### Step 2 — Add the candidate  ·  *Set up → Add candidate*

1. Pick the role.
2. Enter the candidate's full name and email.
3. Upload the resume (**PDF, DOCX or TXT**) — or paste the text.
4. Questor parses it and produces a **fit score** with the evidence behind it,
   plus **missing signals** and **suggested probes** the interview should cover.

The fit score deliberately ignores age, caste, religion, nationality, marital
status, appearance and accent. It is a starting point for the interview, not a
screening decision.

### Step 3 — Set up the interview  ·  *on the candidate's page*

Scroll to **Set up interview** and choose:

- **Duration** in minutes — the plan is built to fit the time you give it
- **Persona name** and **tone** — how the interviewer introduces itself
- **Provider** — leave as the hosted browser room unless IT says otherwise
- **Record of the interview** — what is retained

Click **Create interview**. Questor generates a versioned interview plan.

### Step 4 — Invite the candidate  ·  *on the interview page*

1. Click **Send invitation**. This generates the candidate's private portal link.
2. **Check what the screen tells you about delivery.** If no mail provider is
   configured, Questor **logs** the invitation instead of sending it. If the badge
   does not say *email sent*, or a note tells you the email could not be sent,
   **copy the portal link and send it to the candidate yourself.**
3. The status badge then tracks three real states: *not sent* → *email sent* →
   *opened by candidate*. "Sent" only means the mail provider accepted it; if it
   has been a day and it is still unopened, ask them to check spam.
4. Optionally set a **Schedule** date and time.

> **The portal link is a key.** Anyone holding it can start that interview. Send it
> to the candidate only, and never forward it internally.
> **It expires after 14 days.** Use **Resend email** to issue a fresh one.

### Step 5 — What the candidate experiences

They open the link and walk through three screens before anything is recorded:

1. **Review** — what the interview is, that it is conducted by an AI, and that it
   will be transcribed.
2. **Consent** — they explicitly agree. They can instead request **an
   accommodation or a human alternative**, which routes them to your team rather
   than into the interview. Honour that request.
3. **Audio check** — enable mic, play a test sound.

Then they join the room. The interviewer speaks, they answer aloud, and press
**Done answering**. They can interrupt it, ask it to repeat, or **type their
answers** instead if voice is not working for them.

You can preview the room yourself with **Open interview room (recruiter
preview)** — useful for training, and for showing a nervous candidate what to
expect.

### Step 6 — Read the transcript

The interview page shows the full **diarized, timestamped transcript** — who said
what, when. This is the source of truth for everything that follows.

### Step 7 — Review the assessment  ·  *Review → Interviews → the assessment*

Questor produces a competency scorecard, a summary, a full report, and a
recommendation of **Proceed / Consider / Do-Not-Progress** with a confidence
level. Dimensions without enough evidence are marked **Not Enough Evidence**
rather than guessed.

**Do the blind review first.** Click **Review the evidence blind**. You score each
competency from the transcript and evidence *before* Questor's conclusions are
shown to you, then record your own recommendation. Only then does it reveal how
your call compares with the AI's.

This is not busywork. A reviewer who reads the AI's verdict and then agrees with
it is anchoring, not reviewing — and a regulator reads that as an automated
decision with a rubber stamp on it. Blind-first review is what keeps the human
oversight genuine and evidenced.

If you must skip it, Questor requires a written reason, which is recorded.

### Step 8 — Record the decision

In **Human review** on the assessment page, set the **Disposition**, give a
**Reason** (mandatory), add comments, and submit. Your name is attached to it.
Every previous review stays visible — nothing is overwritten.

Then, if your ATS is connected, **Export to ATS**.

---

## 5. Troubleshooting

| Symptom | What to do |
| --- | --- |
| "Invalid credentials" | Check the email is exactly right. After 10 failures you are rate-limited — wait 15 minutes |
| Signed out unexpectedly | Sessions last 1 hour. Sign in again |
| Can't find the Approve button | You are a recruiter. Ask a manager or admin to approve |
| "Role scorecard must be approved before interviewing" | Step 1.5 — someone needs to approve the scorecard |
| Candidate says they got no email | Check the delivery badge on the interview page. If it is not *email sent*, copy the portal link and send it yourself |
| Candidate's link doesn't work | It expires after 14 days. Click **Resend email** for a new one |
| Candidate's voice isn't being picked up | Ask them to use **Chrome or Edge**, allow the microphone, and reload. They can type answers instead — the interview still counts |
| A candidate asks not to be interviewed by an AI | They can request a human alternative on the consent screen. Route them to a human interview |
| You can't see a candidate you expect to see | You are only shown what you are assigned to. Ask an admin |

---

## 6. Honest limits — please read before rollout

These are real gaps in the current build, not caveats for the sake of it.

- **No user-management screen.** Accounts are created through the API by the
  administrator (see the appendix). There is no "invite a colleague" button.
- **No password reset or password change.** A forgotten password means the
  administrator resets it on the server.
- **Check that invitation emails are actually being delivered.** Unless a mail
  provider is configured, Questor logs invitations rather than sending them, and
  the interview page tells you which happened. Read that badge every time.
- **No bias audit has been done.** Questor recommends outcomes that affect
  people's employment. Its design avoids protected characteristics, but nobody
  has yet tested it for disparate impact across real demographic groups. In
  several jurisdictions that testing is a legal requirement, not a
  nice-to-have — it needs real data and counsel.
- **No load testing.** Behaviour at 20 or more simultaneous interviews is
  unknown, and the database is single-writer. **Stagger the first batch of
  invitations** rather than sending them all at once.
- **No monitoring or alerting.** A failure at 3am mid-interview notifies nobody.
  If a candidate reports a problem, say so — you are the alerting.
- **Results so far are measured against simulated candidates**, not real ones.
  Read the first real transcripts next to their assessments before you trust the
  scoring.
- **The database is not encrypted.** Candidate names, resumes and full
  transcripts sit in plain text. Server access controls are what is actually
  protecting them — see `docs/DEPLOYMENT.md`.
- **Candidate notices need your counsel's review.** Drafts are in
  `docs/compliance/`. Nobody on the engineering side can sign those off.

---

## 7. Your obligations as an HR user

- Tell candidates it is an AI interview, and that it is recorded and transcribed.
  The consent screen does this — do not work around it.
- Honour every accommodation or human-alternative request.
- Never ask, and never follow up on, protected characteristics. Questor blocks
  and rewrites prohibited questions, but the responsibility is yours.
- Decide from evidence. If a competency says **Not Enough Evidence**, that is
  information, not a negative.
- Write a real reason on every decision. It is what a candidate is entitled to see
  and what an auditor will read.
- One login per person, always.

---

## Appendix — for your IT administrator

### Creating HR accounts

There is no UI for this yet. An existing admin creates accounts via the API.

```bash
# 1. Sign in as an admin and capture the token
TOKEN=$(curl -s -X POST https://questor.187-127-166-193.sslip.io/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@yourcompany.com","password":"<admin password>"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

# 2. Create an HR user
#    role: recruiter | manager | reviewer | auditor | admin
#    password: minimum 12 characters
curl -s -X POST https://questor.187-127-166-193.sslip.io/api/admin/users \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"email":"jane@yourcompany.com","name":"Jane Doe","role":"recruiter","password":"<12+ char password>"}'

# 3. List users / change a role
curl -s -H "authorization: Bearer $TOKEN" https://questor.187-127-166-193.sslip.io/api/admin/users
curl -s -X PATCH https://questor.187-127-166-193.sslip.io/api/admin/users/<userId>/role \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"role":"manager"}'
```

Notes:

- The **first** account on a fresh install is created through `POST
  /api/auth/register`, which mints the organisation and its first admin. Close
  self-registration again afterwards (it is closed by default in production).
- A role change does not take effect on an already-signed-in user until their
  session expires — within the hour.
- The last remaining admin cannot be demoted; it would lock the organisation out
  of user management permanently.
- Assign users to the roles (requisitions) and candidates they should see, via
  `POST /api/admin/users/:id/roles/:roleId` and the matching candidate endpoint.
  Without an assignment they will see an empty console.

### Operating the pilot deployment

The pilot runs at `https://questor.187-127-166-193.sslip.io` — a temporary
address for the pilot. It already holds real candidate data, so treat it as a
live system.

- `GET /api/health` returns the running commit. Check it before sending a batch
  of invitations.
- Never run the interview simulator against it. `session.ts` refuses without
  `ALLOW_SIM_SEED` — leave it that way.
- The full hardening and go-live checklist is in
  [`docs/DEPLOYMENT.md`](DEPLOYMENT.md); the standing gaps are tracked in
  [`docs/Questor-update-2026-08-06.md`](Questor-update-2026-08-06.md).

Worth confirming for this deployment, since HR feels each one directly:

- [ ] A mail provider (SendGrid or SMTP) is configured, so invitations reach candidates
- [ ] `AUTH_SECRET` is a generated value, not the published default
- [ ] No `demo@questor.local` account exists
- [ ] Backups are running, and the backup location is restricted too
- [ ] Each HR user has their own account, with the narrowest role that fits their job
