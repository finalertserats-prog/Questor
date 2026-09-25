# Credentials, SME role and export — the contract

Agreed with the owner on 2026-09-24. Every lane builds against this. If a lane
needs to change something here, it says so rather than changing it quietly —
today a competency rename in one lane broke another lane's seeded demo, and it
only surfaced at merge.

Design approved: **`docs/design/questor-credentials.html`** — committed to the
repository rather than left in a scratchpad, because four lanes were pointed at
a file that existed only in a temporary directory and one of them had to read
it out of a published artifact to build against it. A reference the build
depends on has to live where the build lives. The badge is **the Milled
Planchet**; the certificate is **the Struck Seal**.

---

## 1. The rule that is easy to get backwards

**A tier is earned when the candidate is promoted OUT of it**, not into it.

| Tier | Awarded at | By | Certificate |
|---|---|---|---|
| `bronze` | CV read against an **approved** scorecard and a fit computed | automated — no human | yes, watermarked INTERNAL |
| `silver` | HR moves the candidate from Silver **to Gold** | the user who moved them | yes |
| `gold` | HR moves the candidate from Gold **to Diamond** | the user who moved them | yes |
| `diamond` | the same promotion into Diamond | the user who moved them | **no** |

A promotion from Gold to Diamond therefore awards **two** badges in one
transaction: Gold (earned out of Gold) and Diamond (the terminal mark).

**Nothing is shown before it is earned.** A candidate whose Silver interview is
complete but who has not been progressed has **no** Silver badge, no
certificate and no export — only the reason it is not there yet. The mockup
shows this second journey; build it.

---

## 2. Prisma — new models

Migration timestamp: use `20260925xxxxxx_credentials`. Check the folder before
choosing; three collisions happened today.

```prisma
model CandidateAward {
  id              String   @id @default(cuid())
  tenantId        String
  candidateId     String
  roleId          String
  tier            String   // bronze | silver | gold | diamond
  awardedAt       DateTime @default(now())
  /// Null only for bronze, which no human assesses. The certificate says so.
  awardedByUserId String?
  /// Printed on the certificate: QS-SLV-8F2K-4471
  reference       String   @unique
  /// The public verification path, questor.app/v/<token>. Random, not derivable.
  verifyToken     String   @unique
  /// The five evidence rows, FROZEN at award time. Never re-derived: a
  /// certificate states what was true when it was struck, and re-reading the
  /// database later would silently rewrite history. Same reasoning as
  /// CandidateFeedbackEmail.optInAsked.
  /// VERSIONED, and the version describes the CONTENT, not the era. Version 1
  /// is the rows alone; version 2 is the rows plus everything a certificate
  /// prints — the candidate's name and the role's title frozen at strike time,
  /// and the two signature blocks. A tier that prints no certificate is a
  /// version-1 record by nature rather than by age, which is why Diamond is
  /// written as version 1 today: freezing a name onto a record nothing renders
  /// would store personal data for nothing to read.
  ///
  /// The two shapes are deliberately mutually exclusive — a record carrying
  /// everything a current one has, wearing version 1, must not parse as the
  /// older shape and silently drop the name it was holding. That is the defect
  /// this versioning exists to prevent, and it is the defect that shipped:
  /// before 2026-09-25 the writer stored one shape and the reader demanded
  /// another, so every certificate export and send answered 500.
  evidenceJson    String
  sentToCandidateAt DateTime?
  sentByUserId    String?

  @@unique([candidateId, roleId, tier])
  @@index([tenantId, candidateId])
}

model SmeReview {
  id             String   @id @default(cuid())
  tenantId       String
  candidateId    String
  roleId         String
  sessionId      String?
  smeUserId      String
  /// proceed | do_not_proceed — a RECOMMENDATION. HR decides and moves.
  recommendation String
  feedback       String
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@index([tenantId, candidateId])
}

model UserInvite {
  id              String   @id @default(cuid())
  tenantId        String
  email           String
  name            String
  role            String
  /// Hashed, never stored in the clear, never logged, never printed.
  tokenHash       String   @unique
  invitedByUserId String
  expiresAt       DateTime
  acceptedAt      DateTime?
  createdAt       DateTime @default(now())

  @@index([tenantId, email])
}
```

---

## 3. The SME role

`User.role` gains `'sme'`. Two rules, both load-bearing:

**The SME sees who the candidate is.** Deliberate. The owner's words: it is
core to human assessment and to learning from where the human and the machine
read a candidate differently. Do not make the SME blind.

**The SME sees nothing else.** Least privilege, and narrower than `recruiter`:

| May | May not |
|---|---|
| candidates explicitly assigned to them | any other candidate |
| those candidates' transcripts and assessments | the pipeline, the candidate list, comparisons |
| the role's approved scorecard, read-only | editing a role, a scorecard or a competency |
| write their own `SmeReview` | read another SME's review |
| conduct a Gold interview they are assigned to | settings, users, billing, the audit log |

**The SME advises; HR decides.** An SME recommendation NEVER moves a candidate
between stages. The move is always a user action by someone who may move
candidates, and that user's id is what lands on the award.

---

## 4. Invitations — emailed, never admin-chosen

Add-a-colleague is an **emailed invite**. The colleague sets their own password
from a mailed link.

**Do not expose the existing `POST /api/admin/users`.** It requires the admin to
choose the colleague's password, and `TeamUsers.tsx` already documents why that
is wrong: someone who can set another person's password makes that person's
actions unattributable. Attribution is the entire foundation of the SME review
and of calibration. Reuse the token machinery in `SignupRequest` and
`PasswordResetToken`.

Invite tokens are hashed at rest, never logged, never echoed to a client, and
never printed in a terminal.

---

## 5. Certificates and export

Rendered server-side with **pdfkit**, already a dependency from the role-export
lane (`GET /api/roles/:id/export.pdf` is the working reference). Real vector
text — searchable, selectable, screen-reader legible. Never a screenshot.

- `GET /api/candidates/:id/awards/:tier/certificate.pdf` — the certificate
- `GET /api/candidates/:id/awards/:tier/badge.png` and `.svg` — the badge
- Bronze carries the **INTERNAL** watermark and the kicker
  "Record of assessment · not for release".
- Every certificate carries the Q watermark at 1.8% and the footnote:
  **"\* Evidence of process, not a recommendation."**
  Bronze appends: "Held by the hiring team; not issued to the candidate."
- **No organisation name anywhere on a certificate.** Questor's name only.
- **No verbatim transcript quote on the certificate.** The owner cut it.
- Structure is identical across Bronze, Silver and Gold: header, kicker, name,
  rule, claim line with `*`, **exactly five evidence rows**, **two signature
  blocks** flanking the seal, footnote. Bronze's left signature reads
  "Assessed by · scorecard v\<N\>, no human review", which is how the absence
  of a person stays visible. `\<N\>` is the version of the scorecard the CV was
  actually read against, taken from the fit — never a fixed number. This doc
  said "v4" for months while the writer had always built it from the stored
  version; the first certificate ever issued in production read v5. When
  Questor holds no version at all it reads "Assessed by · approved scorecard,
  no human review" rather than inventing one.
- The right-hand block reads **"Recorded by · the hiring team"**. Recorded,
  never assessed: Bronze's `awardedByUserId` is null because nobody assessed
  it, and somebody did put the application into Questor, so naming what they
  actually did claims nothing about a reading that never happened. The design
  mockup at `docs/design/questor-credentials.html` still says "talent lead";
  the product does not, and the product is right.

**Sending is an admin action.** `POST .../certificate/send` requires a user who
may administer the tenant. It is never automatic, never on the journey row, and
it records `sentToCandidateAt` and `sentByUserId`. Only written feedback is
emailed on its own; badges and certificates are the hiring team's.

---

## 6. Where it appears

**Candidate journey — one row per tier.** Badge, what happened, date, and two
buttons: `Badge` and `Certificate`. Diamond shows only `Badge`. A tier not yet
earned shows a dashed placeholder, no buttons, and the reason
("Awarded when she moves to Gold").

**Badge sizes in the app: 20, 24, 30, 36.** The hallmark (`Q·585`, `Q·925`,
`Q·999`) is engraved only at 56px and above; below that it muddies the metal.

The badge SVG is one component taking `tier` and `size`. The mockup's
generator is the reference implementation — copy its geometry exactly: the
octagon, the guilloché field, four bars with the earned ones struck bright and
the unearned ones engraved but **clearly visible**, and the crystalline
Diamond.

**One deliberate departure: the milled edge is cut.** The mockup rings every
tier with fine radial ticks — 88 on the metals, 72 on Diamond — the way a
struck coin is milled. On an exported badge they read as a second border
competing with the octagon's own, and the owner removed them on 2026-09-25.
The mockup still draws them, and it remains the reference for everything else,
so the next faithful transcription would put them back. This paragraph is the
only thing standing between that and a badge nobody asked for.
