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
| The Questor address | Your IT admin gives you this. On a local install it is **http://localhost:5173** |
| Your own account | One login per person — never a shared one (see §2) |
| A browser | **Chrome or Edge.** Voice capture uses the browser's speech engine, which Safari and Firefox do not fully implement. Candidates on other browsers can still type their answers |
| A microphone | Only for the interview room; not needed for reviewing |

---

## 2. Logging in

Go to the Questor address and enter your email and password on the sign-in page.

### Your credentials

**Questor does not ship with a personal account for you.** There are exactly two
ways an account exists:

1. **The demo account** — created by the setup script on a development machine:

   ```
   Email:    demo@questor.local
   Password: questor123
   ```

   This password is published in the public source code. It is for trying the
   product out on a test machine only. It must be **deleted before the first real
   candidate** — this is a required item on the go-live checklist in
   `docs/DEPLOYMENT.md`.

2. **A real account** — created for you by your Questor administrator. Ask them
   to create one and to tell you your role (see §3). They should send you the
   password through a channel that is not email, and you should treat it like any
   other HR system credential.

There is **no "Register" shortcut for real use.** The register link on the login
page creates a brand-new, separate organisation with its own empty database — it
does not give you access to your colleagues' candidates. It is switched off
entirely on a production install.

### Rules the login enforces

| Rule | What it means for you |
| --- | --- |
| **Sessions last 1 hour** | You will be signed out after an hour and need to sign in again. This is deliberate: Questor holds candidate personal data and often runs on a shared desk |
| **10 failed attempts per 15 minutes** | Repeated wrong passwords temporarily block sign-in. Wait 15 minutes rather than retrying |
| **Passwords are at least 12 characters** | Applies to any account your admin creates |
| **Never share a login** | The audit log records who viewed and changed each assessment. Under a shared login, "who accessed this candidate's data?" has no answer — and candidates have a legal right to ask |

### Forgotten password

Questor currently has **no self-service password reset and no "change my
password" screen.** If you forget your password, your administrator has to issue
you a new account or reset the stored password directly. Flag this to IT before
rollout — see the appendix.

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
2. **Check what the screen tells you about delivery.** Out of the box Questor does
   **not** actually send email — it logs it. If the badge does not say *email
   sent*, or a note tells you the email could not be sent, **copy the portal link
   and send it to the candidate yourself.**
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
| Candidate says they got no email | Expected on a default install. Copy the portal link from the interview page and send it yourself |
| Candidate's link doesn't work | It expires after 14 days. Click **Resend email** for a new one |
| Candidate's voice isn't being picked up | Ask them to use **Chrome or Edge**, allow the microphone, and reload. They can type answers instead — the interview still counts |
| A candidate asks not to be interviewed by an AI | They can request a human alternative on the consent screen. Route them to a human interview |
| You can't see a candidate you expect to see | You are only shown what you are assigned to. Ask an admin |

---

## 6. Honest limits — please read before rollout

These are real gaps in the current build, not caveats for the sake of it.

- **No user-management screen.** Accounts are created through the API by an
  administrator (see the appendix). There is no "invite a colleague" button.
- **No password reset or password change.** Plan for how IT handles a forgotten
  password before you roll out.
- **Email is not delivered by default.** Until SendGrid or SMTP is configured,
  every invitation must be copied and sent manually.
- **The database is not encrypted.** Candidate names, resumes and full transcripts
  sit in plain text in the database file. Filesystem permissions and separate
  operating-system accounts are the controls actually protecting it —
  see `docs/DEPLOYMENT.md`.
- **The demo account must be deleted** before any real candidate data goes in.
- **The AI's judgement is advisory and has not been validated on your roles.** Run
  it in shadow mode alongside your existing process and measure agreement before
  you rely on it — see `docs/VALIDATION.md`.
- **Candidate notices need your counsel's review.** Drafts are in
  `docs/compliance/`. Nobody inside this repository can sign those off.

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
TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@yourcompany.com","password":"<admin password>"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

# 2. Create an HR user
#    role: recruiter | manager | reviewer | auditor | admin
#    password: minimum 12 characters
curl -s -X POST http://localhost:4000/api/admin/users \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"email":"jane@yourcompany.com","name":"Jane Doe","role":"recruiter","password":"<12+ char password>"}'

# 3. List users / change a role
curl -s -H "authorization: Bearer $TOKEN" http://localhost:4000/api/admin/users
curl -s -X PATCH http://localhost:4000/api/admin/users/<userId>/role \
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

### Before the first real candidate

The full go-live checklist is in [`docs/DEPLOYMENT.md`](DEPLOYMENT.md). The items
HR will notice most:

- [ ] Delete the `demo@questor.local` account
- [ ] Generate a real `AUTH_SECRET` — the default is published on GitHub
- [ ] Configure SendGrid or SMTP so invitations actually reach candidates
- [ ] Restrict filesystem permissions on the database (`scripts/harden-windows.ps1`)
- [ ] One operating-system account per HR user
- [ ] Set up backups, and restrict the backup location too
