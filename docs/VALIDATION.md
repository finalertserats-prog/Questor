# Scoring Validation — Shadow Mode

**Status: the Questor score has NOT been validated against human judgement.**

No agreement study has been run. `GET /api/assessments/shadow-metrics` currently reports
`n = 0`. Nothing in this document, and no number this harness produces, should be read as
evidence that the scoring engine is accurate.

Until the gate in [Passing the gate](#passing-the-gate) is met, **the AI score must not drive
hiring decisions.** It may be shown to a reviewer as one input among several, after that
reviewer has recorded their own judgement. It must not filter, rank, or auto-reject anyone.

---

## Why this exists

Questor's scoring engine was previously a keyword heuristic. It scored a content-free answer
**85** and a specific, metric-rich answer **75** — it was rewarding fluency and length, not
competence. That heuristic has been replaced with LLM rubric grading in
`server/src/engines/evaluator.ts`.

The replacement is better-designed. It has not been shown to be better. Nobody has measured
whether the new scores agree with what a skilled human reviewer would conclude from the same
transcript. `docs/BUILD_STATUS.md` lists a scoring-validity study (**≥0.75 human agreement**)
as an unmet launch gate. This harness is the instrument for that study.

### The legal dimension

Questor's design keeps the employer outside GDPR Art. 22 ("a decision based solely on
automated processing") and NYC Local Law 144's automated-employment-decision rules by making
the score **advisory**, with a human making the actual call.

That protection holds only while the human review is *genuinely meaningful*. A reviewer who
opens the AI's `PROCEED` recommendation and then agrees with it is anchoring, not reviewing.
Regulators treat a rubber stamp as fully automated decision-making, and the advisory framing
collapses.

So independent-first review is doing two jobs at once:

| | |
|---|---|
| **Validity** | A verdict recorded *after* seeing the AI measures anchoring, not accuracy. Only a blind verdict is an independent measurement, and only independent measurements make agreement statistics mean anything. |
| **Compliance** | An audited record showing human judgement *preceded* the machine's is evidence that the oversight was real. |

The same control produces both. That is why the reveal is gated rather than merely advised.

---

## How shadow mode works

The reviewer records their own verdict **before** the AI's conclusions are shown.

```
GET  /api/assessments/:id/blind           → evidence + transcript, AI conclusions withheld
POST /api/assessments/:id/blind-verdict   → reviewer's independent disposition + levels
GET  /api/assessments/:id/reveal          → AI output; 409s until the verdict exists
GET  /api/assessments/shadow-metrics      → agreement statistics across the tenant
```

**Shown on the blind view** — the reviewer cannot judge without these: the full transcript, the
evidence quotes the evaluator worked from, and competency names, definitions, indicators and
required levels. Competency metadata is read from the approved **scorecard**, not from the
assessment, because the scorecard describes the job while anything the evaluator wrote is a
conclusion about this candidate.

**Withheld**: `recommendation`, `overallScore`, `confidence`, `evidenceCoverage`, every
competency level and rationale, `notEnoughEvidence` flags, strengths, concerns, contradictions,
open questions, limitations, and the summary. `Turn.metaJson` is dropped wholesale because it
carries live-director signals (answer-quality scores, coverage state) that would leak the
machine's opinion through the side door.

The reviewer is given the **same 1–5 rubric anchors** that the LLM grader receives. Handing the
two raters different scales would measure the scales, not the raters.

### Running a study

1. Recruit reviewers who would otherwise make this call unaided. Their judgement is the
   reference standard, so a reviewer who is guessing contributes noise, not signal.
2. For each completed interview: `GET /:id/blind`, decide, `POST /:id/blind-verdict`.
3. Reveal and continue the normal workflow. The existing `POST /:id/review` endpoint is
   unchanged and still records the final, informed decision.
4. Read `GET /shadow-metrics` as the sample grows.

**Sample deliberately across the disposition range.** If you only shadow-review borderline
candidates, or only strong ones, the marginals collapse toward a single class and kappa becomes
unstable or undefined — see [Statistics](#statistics).

One verdict per reviewer per assessment; it cannot be replaced. A reviewer who could resubmit
could quietly rewrite their blind call after the reveal, which would destroy the independence
the entire harness depends on.

---

## Statistics

All computed in `server/src/services/shadowMode.ts`. Cohen's kappa is implemented in-repo
rather than pulled from a package: it is ~20 lines, and a statistic that gates a hiring launch
should be auditable by whoever is being asked to trust it.

### Raw agreement (p_o)

The proportion of assessments where the blind human disposition exactly equals the AI
recommendation.

**Reported, but never sufficient on its own.** In screening one class dominates. If 90% of
candidates are `CONSIDER`, a rater that says `CONSIDER` every single time scores 90% raw
agreement while carrying zero information. Any report quoting raw agreement alone is
misleading, and this one refuses to.

### Cohen's kappa (κ)

```
κ = (p_o − p_e) / (1 − p_e)
```

where `p_e = Σ_labels P(human picks L) × P(AI picks L)` — the agreement the two raters' own
marginal rates would produce by chance alone. κ = 1 is perfect agreement; κ = 0 is exactly
chance; κ < 0 is worse than chance.

**κ is reported as `null`, not as a number, when it is undefined.** If both raters used one and
the same single category throughout, `p_e = 1` and κ is 0/0. Raw agreement reads 1.0 in that
situation and means nothing. Returning `1.0` there would be the single most flattering lie this
harness could tell, so it declines and explains why instead.

### Confidence interval

Large-sample standard error (Fleiss et al.):

```
SE(κ) = √( p_o(1 − p_o) / (n · (1 − p_e)²) )       CI₉₅ = κ ± 1.96 · SE(κ)
```

### Per-competency agreement

Where **both** raters scored the **same** competency, the report gives exact agreement,
within-one-level agreement, and a **mean signed error** (positive ⇒ the AI scores that
competency *higher* than blind reviewers do). A competency left unscored by either side is
missing data and is excluded — imputing a value there would manufacture agreement nobody
recorded.

Per-competency n is much smaller than the study n. Treat these as a direction-finder for
*which* competencies to investigate, not as findings.

---

## Passing the gate

| | |
|---|---|
| **Gate** | ≥ 0.75 human agreement (`docs/BUILD_STATUS.md`, BRD §3.3 launch gates) |
| **Statistic used** | Cohen's kappa on disposition |
| **Tested against** | the **lower bound of the 95% CI**, not the point estimate |
| **Minimum n** | 30 paired observations before any number is reported as conclusive |

Two honest caveats about the numbers above:

**BUILD_STATUS.md does not say which statistic "0.75 human agreement" means.** Testing κ
against its CI lower bound is *our stated, conservative reading* — it is not quoted from the
BRD. Confirm it with whoever owns the gate before treating a pass as authoritative. A point
estimate of κ = 0.78 with a CI of [0.41, 1.00] has not demonstrated 0.75 agreement; it is
equally consistent with 0.41.

**n = 30 is a rule of thumb, not a power calculation.** It is the conventional floor below
which the normal approximation used for the CI is untrustworthy. It is *not* a validated sample
size for this tool, and clearing 30 does not mean the study is adequately powered. How many
interviews you actually need depends on the observed κ and how evenly the dispositions are
distributed; the practical answer is "keep going until the CI lower bound is stably above the
threshold," which will usually require considerably more than 30. The endpoint reports the CI
width so the data can tell you, rather than this document guessing.

---

## What this does and does not prove

**Measures:** whether blind human reviewers and the AI reach the same disposition, and the same
competency levels, more often than chance explains.

**Does not establish:**

- **That either party is right.** Agreement is not accuracy. If reviewers and the model share
  the same blind spot — both over-rewarding confident, fluent, senior-sounding answers, which
  is precisely the failure the old heuristic exhibited — agreement will be *high* and both will
  be *wrong*. High κ would not detect this.
- **That the tool is fair.** Neither statistic looks at outcomes by protected group.
  Adverse-impact and fairness monitoring is a separate, currently unbuilt check
  (`docs/BUILD_STATUS.md`: FR-042, "currently stubbed").
- **That the score is safe to automate.** Clearing the gate satisfies one launch condition. The
  advisory design, and the Art. 22 / LL144 position that rests on it, does not change because
  agreement improved.
- **That the reviewers were skilled.** The harness measures agreement with whoever was
  recruited. Reviewer quality is an input assumption it cannot verify.

### Known limitations of the harness

- `GET /api/assessments/:id` still returns the full AI output without a blind gate, so a
  reviewer can bypass shadow mode by calling it. The blind flow is enforced on the reveal
  endpoint; it is a workflow control, not an airtight one. A study should confirm via the audit
  log (`review.blind_verdict` preceding `review.ai_revealed`) that reviewers actually used it.
- When several reviewers blind-review the same assessment, only the first is counted. Two
  opinions about one interview are not two independent data points about the model. Inter-rater
  reliability *between humans* — the natural ceiling on any human-AI agreement figure — is not
  yet computed.
- Assessments where the AI declined to score a competency (`notEnoughEvidence`,
  `gradingUnavailable`) contribute to the disposition statistic but drop out of the
  per-competency one, so the two sample sizes differ.
