# Role calibration

*The AI's assessment gets better at each role because it learns from what human
reviewers actually decided.*

Owner-approved 2026-09-23. Dark by default (`CALIBRATION_ENABLED`, plus a
per-organisation switch).

---

## Why this exists, and what was already there

`ReviewDifference` has been written since September: every completed human
review records where the reviewer's levels and verdict parted company with the
model's. The validation gate (`services/shadowMode*.ts`) measures how often the
two agree, and reports honestly when the sample is too small to say. The
question library has a quality loop and a `select` that serves ladders and
anchors.

None of it fed back into how the evaluator scores. The record existed and
taught the product nothing.

The owner's framing, which is the whole design:

> "I want it to learn, not just auto-change scores for an interview. If the
> difference is a lot and the person says a different view, we should capture
> such things and next time, for the next interview, we consider it."

---

## The four rules

Everything below is a consequence of these, and each is a test rather than a
claim.

1. **Forward only.** A recorded assessment is never rewritten. A calibration
   reaches a score at exactly one moment — when the next interview is assessed
   (`services/calibrationApply.ts`, called from `realtime/interviewEngine.ts`).
   There is no function anywhere that takes an assessment id and a calibration.
2. **Bounded.** At most ±1 level, in half-level steps, on one role's one
   competency at one experience band. An organisation may tighten the bound and
   cannot loosen it (`resolveThresholds` clamps it).
3. **Evidenced.** Below the thresholds nothing applies, and *nothing applies*
   is the answer — not a smaller adjustment. A thin sample buys silence.
4. **The human is never wrong.** Nothing here has a concept of a reviewer being
   mistaken, and it must never acquire one. A disagreement is a signal about
   the rubric and the model.

---

## The model

### Capture (`services/calibrationCapture.ts`)

At the moment a review completes, beside the existing `ReviewDifference`, one
`CalibrationObservation` per competency:

| Field | Why |
|---|---|
| `roleId`, `roleKey`, `band` | the unit a gap is learned for |
| `competencyId`, `competencyKey` | id inside an organisation; name key for the shared pool |
| `aiLevel`, `humanLevel`, `delta` | the pair the statistics fold over |
| `magnitude` (`none`/`minor`/`major`) | a loud disagreement must not read like a quiet one |
| `reasonText` | **the reviewer's own words** — the owner asked for the reasoning, not just the number |
| `reasonRedacted` | set when the protected-inference guardrail dropped the text |
| `scorecardId`, `scorecardVersion` | which rubric the disagreement was about |
| `evidenceCount`, `evidenceTurnIdsJson` | references to the evidence, never a second copy of the transcript |
| `blindReview` | a judgement formed before the model's was visible is independent evidence |
| `verdictAi`, `verdictHuman`, `verdictAgreed` | the whole-interview call, not just the levels |

Idempotent on `(reviewId, competencyId)`: a replayed submit cannot double the
evidence, which would be the easiest way to fake a systematic gap.

Capture runs **even when calibration is switched off**. The record of what
reviewers decided is worth keeping whatever the scoring does.

### Aggregate (`domain/calibration.ts`, pure)

Per role × competency × band, over a 365-day window:

- **Point estimate** — a recency-weighted median (180-day half-life), with each
  reviewer's weight capped at 40% of the total. The cap is the real protection
  against one loud reviewer: "three distinct reviewers" is a box a determined
  person walks straight through with twenty reviews to two others' one each.
- **Interval** — a distribution-free confidence interval for the median from
  the order statistics. Deliberately **unweighted**: recency weighting is an
  opinion about which observations matter more, and letting that opinion narrow
  the interval would manufacture the certainty the interval exists to test.
- **Reviewer direction** — each reviewer's own median counts once. Twenty
  reviews from one person is still one person.
- **Themes** — the reviewers' words clustered into at most five labels by the
  product's configured provider (`providers/llm`, strict schema, `null` → no
  summary). The prompt forbids any characterisation of a reviewer, the schema
  has nowhere to put one, and the validator rejects an output that tries.
  Requires ≥3 distinct reviewers: a theme drawn from one person's notes is that
  person's words, attributable by anyone who knows how they write.

### Activate (`services/calibrationActivation.ts`)

Automatic, daily, leased (`services/calibrationJob.ts`). Every gate, in the
order a person would ask them, first failure reported:

| Gate | Default |
|---|---|
| Paired observations | **15** (`calibrationMinObservations`, min 5) |
| Distinct reviewers | **3** (`calibrationMinReviewers`, floor 3, never lower) |
| Interval excludes zero | 95% |
| Estimate agrees in sign with the interval | — |
| Reviewers pointing the same way | **2/3** of those with a direction |
| Applied adjustment | **±1 level max, 0.5 steps, nothing below 0.5** |
| Fairness | see below |

Reviewers held out by an open pattern alert do not contribute until an admin
has closed it.

**A reverted adjustment stays reverted.** The automatic run recomputes its
numbers and never quietly undoes a person's decision.

---

## Fairness guardrails

**State the limit first: this cannot detect bias.** Nothing in Questor can.
There are no protected characteristics to test against — collecting them in
order to check for bias would be collecting them, which is its own harm and its
own legal exposure — and an adjustment learned from biased reviews looks exactly
like one learned from good ones.

What the guardrails *do*:

1. **Never calibrate on anything correlated with a protected characteristic.**
   The key is role × competency × band and nothing else. Band is experience,
   which is job-related. Region is deliberately **not** a key: it is a proxy.
   No observation carries anything about the candidate beyond the assessment id.
2. **Reason text passes the protected-inference guardrail** before storage
   (`validateNoProtectedInference`, the same check the evaluator's own output
   passes). A flagged reason is dropped, not stored, and the row is marked
   `reasonRedacted` so the drop is visible rather than silent.
3. **The pass-rate gate** (`services/calibrationFairness.ts`). Before any
   activation, the adjustment is replayed over the same window's assessments
   for that role and the projected movement in the share reaching the pass
   threshold is measured. More than **10 percentage points** and it is held and
   an admin is told. It is also checked against the outcome statistics
   (`services/outcomeStats.ts`), and **fails closed**: a role with too few
   outcomes for those statistics to read is held, because "we could not check"
   is not "the check passed". `CALIBRATION_REQUIRE_FAIRNESS_CHECK=false` is a
   deliberate, documented reduction in safety.
4. **Every activation is reconstructible.** The audit event carries the delta,
   the counts, the interval, the whole fairness check and the themes. The
   provenance is also copied onto each calibrated competency of each
   assessment, so an assessment explains itself years later even if the
   adjustment behind it has since been reverted or recomputed.

### Honest limits

- The pass-rate projection changes one competency's level and nothing else. It
  cannot see how a different level would have changed the interview, the
  reviewer's reading of it, or the must-pass gates. It catches a visible
  movement, which is the failure worth catching; it is not a counterfactual.
- Calibration inherits its reviewers. A whole organisation that reads one
  competency harshly than the rubric intends will teach the model to do the
  same, and every gate here will pass, because the gates measure consistency,
  not correctness.
- The interval assumes observations are independent. Two reviews by the same
  person of similar candidates are not. The reviewer weight cap and the
  direction test blunt this; they do not remove it.
- 15 observations is a judgement, not a power calculation. It is the point at
  which the order-statistic interval starts to be informative, and it is
  configurable upwards for a reason.

---

## Scope: per organisation, and an opt-in shared pool

Default: **organisation only**.

`calibrationGlobalContribution` is a separate, explicit opt-in with its own
plain-words consent text (`GLOBAL_CONTRIBUTION_CONSENT`). Switching calibration
on does not switch it on.

**Shared, exhaustively:** the shared catalog's role id, the competency name
(lower-cased), the band, the model's level, the reviewer's level, whether the
verdicts agreed, whether the reviewer was blinded, the **month**, and a one-way
reviewer code.

**Never shared, exhaustively:** the organisation, the role row, the scorecard,
the candidate, the assessment, the interview, the transcript, the evidence, the
reviewer's identity, **any free text a reviewer wrote**, and the exact date.

`CalibrationGlobalObservation`'s columns *are* that list. A field that is not a
column cannot be shared by a mistake in one file.

The reviewer code is `HMAC(server secret, tenantId + reviewerId)`. It exists
for one reason: the three-reviewer rule must hold in the shared pool too. It is
salted with the tenant, so the same person in two organisations is two
unrelated codes; it is keyed with a server secret, so a copy of the database
cannot be brute-forced back to a user id.

The shared calibration has no organisation's pass rates to check against, so it
is held to a **higher** bar instead (3× the observations, 2× the reviewers), and
an organisation's own calibration always overrides it. An organisation only
reads the shared pool if it contributes to it.

---

## Anchors and questions

- **Anchors.** Where reasons cluster on *what a strong answer contains*, that is
  the rubric being out of date rather than a scoring gap. A
  `CalibrationAnchorProposal` is raised and goes through the **existing**
  approval path for rubric changes: a person edits the role's scorecard, which
  creates a draft version their approver approves
  (`services/scorecardVersions.ts`, `POST /api/roles/:id/approve`). Calibration
  never edits a live standard.
- **Questions.** `LibraryUsage.reviewerDelta` has existed since L1 and nothing
  has ever written it. Calibration is the producer it was waiting for: the
  signed human-minus-model difference for the competency each library question
  was asked under. The library's quality loop decides what to do about it —
  retire, replace, or nothing. This lane emits the signal and makes no lifecycle
  decision.

---

## Reviewer patterns

Calibration learns from humans, so it inherits whatever they brought. The other
half of that, at the owner's request: if there is a pattern in how a person
reviews, a person should look at it.

**What this is not, and must never become.** Not a finding. Not a performance
record — there is no code path from these statistics to anyone's standing in
Questor, and adding one would be a change to what this product does, not a
feature. Not secret from the reviewer.

**What is automatic, stated precisely.** Nothing is done *to* a reviewer: no
status changes, no access is removed, no decision of theirs is reversed, and
nobody is told anything about them except their own organisation's admin. There
is one automatic effect: while an alert is open, that reviewer's observations
stop feeding calibration. That is a brake on the model, not a sanction on the
person — it stops one unusual pattern teaching the scoring something before
anybody has looked — and it applies only to the alert kinds that rest on a
proportion with a confidence interval. It ends when an admin closes the alert,
whichever way they close it.

Measured per reviewer over the window: divergence from the model, divergence
from colleagues on the same role competencies (their own level excluded from
the peer median), verdict mix against the organisation's, share of level
changes that move down, share that record a reason, and time from first opening
the assessment to recording a verdict — taken from the blind-review audit trail
that already exists, and reported as **unknown** rather than estimated when it
was not recorded.

An alert needs three things at once: a sample at or above the minimum
(**10 reviews**, configurable), an interval excluding the organisation's own
baseline, and a gap of at least 20 points. Two out of three produces nothing.
**Small samples never produce alerts**, and below the minimum the reviewer's row
shows one sentence instead of any statistic.

Wording is neutral and non-conclusive by construction: every alert begins
"Worth a look:", states what was observed over what sample against what
baseline, and ends "This is a pattern over N reviews, not a finding — a person
needs to look at it and decide whether there is anything to it." A vocabulary
list (`NEVER_SAY`) is enforced by test.

Only the kinds that would skew what the model learns hold a reviewer out of
calibration, and only those whose evidence carries a confidence interval.
Recording verdicts quickly, writing less down, or sitting further from
colleagues on a mean distance with no interval behind it, are all worth a look
and are none of them a reason to discard someone's judgement.

**Transparency.** Every reviewer can read their own figures at
`GET /api/admin/calibration/reviewers/me` with no capability required — the
same numbers an admin sees, not a softened version. Every admin read of another
person's figures is audited (`reviewer.pattern.viewed`).

### For the About page (owned by the outcome-stats lane, `trustModel.ts`)

That lane should add, in the trust/compliance content:

> **What we keep about reviewers.** When someone reviews an interview, Questor
> records how their verdict and levels compared with the model's, and how long
> they had the assessment open before deciding. These statistics are used for
> two things: to check what the model learns from human reviews, and to show an
> organisation's admin patterns worth looking at. They are never a performance
> record and nothing acts on them automatically. Every reviewer can see their
> own statistics on their own profile — the same numbers the admin sees — and
> every time an admin opens someone else's, that is recorded in the audit log.

---

## Questions for the solicitor's pack

Listed, not answered.

1. **Employee monitoring under GDPR Art. 88** and the national employment law
   that gives it effect: do the reviewer statistics constitute monitoring of
   employees in the workplace, and what does each jurisdiction we operate in
   require before they may be collected?
2. **Works-council consultation.** Several EU states require consultation
   before a system that monitors employee performance is introduced. Does this
   engage that duty, and in which states?
3. **Transparency obligations.** Is per-reviewer visibility of their own figures
   sufficient, or is separate prior notice — and a documented lawful basis —
   required before collection begins?
4. **Lawful basis and purpose limitation.** Legitimate interests or something
   else; and does using the statistics to hold a reviewer out of calibration
   constitute a use beyond the purpose they were collected for?
5. **Employment disputes.** Could these statistics be disclosable in, or become
   evidence in, a dispute — a dismissal, a grievance, a discrimination claim —
   and does that change what we should retain and for how long?
6. **Retention.** How long may reviewer statistics and pattern alerts be kept,
   and what happens to them when the employee leaves?
7. **Automated decision-making.** Calibration changes a score that informs a
   hiring decision. Does a bounded, evidenced adjustment learned from human
   reviews alter the Art. 22 analysis that currently rests on the review being
   meaningful — and does it alter the NYC LL144 position on bias auditing?
8. **The shared calibration.** Is the pseudonymised cross-organisation pool
   personal data in any jurisdiction we operate in, and is the consent text
   sufficient for a controller-to-controller contribution?

---

## Configuration

| Setting | Where | Default |
|---|---|---|
| `CALIBRATION_ENABLED` | deployment env | `false` |
| `CALIBRATION_REQUIRE_FAIRNESS_CHECK` | deployment env | `true` |
| `CALIBRATION_GLOBAL_ENABLED` | deployment env | `false` |
| `calibrationEnabled` | tenant policy | `false` |
| `calibrationGlobalContribution` | tenant policy | `false` |
| `calibrationMinObservations` | tenant policy | 15 |
| `calibrationMinReviewers` | tenant policy | 3 (floor) |
| `calibrationReviewerPatternMinReviews` | tenant policy | 10 |

Two kill switches: the deployment one closes it for everybody, the
organisation one for one organisation. Either being off withdraws everything
already active on the next run.

## What the assessment page renders

`GET /api/assessments/:id` carries `calibration` (see
`domain/calibrationView.ts`, which is the contract):

```ts
calibration?: {
  competencies?: { competencyId: string; level: number | null; provenance: string }[];
  note?: string;
}
```

`competencyId` matches the result's own competency id; `level` is the
calibrated level; `provenance` renders under the number and carries the
model's own level, the evidence, and the reviewer's level where one exists.
`note` renders above the table. Absent for every assessment written without a
calibration, which is the default — and absent means render nothing.
