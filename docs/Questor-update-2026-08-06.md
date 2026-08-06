# Questor — update, 6 August 2026

Supplement to `Questor.pdf` / `Questor.html` (last revised 19 July 2026, commit
`f52e67d`). Eighteen commits landed after that revision. This document records
what changed and which of its sections no longer hold. It does not replace the
guide: the operating instructions, the regulatory position, the roadmap and the
dissenting view in it are still the reference, and nothing here contradicts them
except where stated.

Read this alongside the guide, not instead of it.

---

## What changed, in one paragraph

The interviewer was pitching questions at the wrong experience level, and nobody
knew because nothing measured it. A simulation harness now does. It found the
miscalibration, quantified it across 72 interviews, and the fixes for it are
live. It also found five unrelated defects in production code, three of which
were degrading real interviews.

---

## Superseded: "Engineering and enterprise readiness"

### "Where it actually stands"

The readiness position in the guide was written **before any measurement of
interview calibration existed**. At the time it was written, the engine was
interviewing 20-year executives 2.89 bands below their own level, and none of
the nine tested were pitched correctly. That was not known and could not have
been — so treat any readiness claim in that section as predating its evidence.

The position today, stated plainly:

- **Ready for a supervised pilot.** Real candidates, every assessment reviewed by
  a human before it affects anyone.
- **Not ready for unsupervised enterprise use.** Unchanged from the guide, and
  for mostly the same reasons — see "Still open" below.

### "Validity: the number was wrong"

This section needs the strongest revision. Interview calibration is now measured
rather than assumed, with a before and after:

| Candidate band | Before | After |
|---|---|---|
| emerging (0–2 yrs) | 1.11 bands off | 0.22 |
| developing (2–5) | 0.11 | — |
| established (5–8) | 0.13 | — |
| senior (8–12) | 0.17 | — |
| principal (12–18) | 0.44 | — |
| executive (18+) | **2.89** | **0.00** |

Measured as the distance between the band the questions were pitched at and the
band the candidate actually occupies, judged blind by an AI peer that had no
part in conducting the interview. Baseline is 54 interviews across six bands,
three role families and three candidate strengths; the after is 18.

Two caveats to carry with those numbers:

- The executive result rests on **five judged cells, not nine**. All nine ran
  complete 21-turn interviews; four lost their *judgement* to a peer returning
  unparseable JSON. It is a gap in measurement, not in the result, but 0.00 is a
  five-cell figure.
- Everything above is measured against **synthetic candidates**. Nine AI agents
  interviewing each other is a real instrument — it found eight defects — but it
  cannot tell you how a nervous human on poor wifi experiences the product.

Evidence: `docs/evidence/baseline-precalibration-2026-08-05.md` and
`docs/evidence/validation-postcalibration-2026-08-06.md`.

---

## What was actually broken

### Interview calibration (the headline)

The only seniority signal in the pipeline was one binary check: senior/lead/
principal got `requiredLevel: 3`, everyone else `2`. Candidate tenure was parsed
off the resume and used for nothing but a fit-score bonus — it never reached the
planner, the director, or a prompt. A two-valued dial cannot express six levels,
so the interview collapsed toward the middle: entry-level candidates questioned
above themselves, executives far below.

Now: six experience bands, resolved from the **candidate** rather than the
requisition, with years as a prior that evidenced scope can adjust by at most one
step. Questions are screened against the band whether they came from the static
bank or the model. See `docs/SIMULATION.md` and `engines/experienceBands.ts`.

**Years are deliberately never the verdict.** Banding on years-since-graduation
is an age proxy, and `age` is already a prohibited topic.

### Tenure parsing — the root cause

`totalYears` was the span between the earliest and latest years *written* on a
CV. "Present" is not a year, so **"Director of Data (2004 – Present)" measured as
zero years of experience.** Every currently-employed candidate was understated,
worst for the longest-tenured.

This was the actual cause of the executive failure, and it hid for a long time
because the band model degraded gracefully: scope markers promoted the nonsense
from `emerging` to `developing`, which looks like a plausible answer rather than
an obviously broken one. A safeguard that turns garbage input into a
merely-wrong output is much harder to notice than one that fails loudly.

### Three defects that were degrading live interviews

- **False-positive corrections.** A candidate saying "…not reprocessing
  everything, so that part I'm not worried about" was answered with "Thanks for
  the correction — so that part I'm not worried about, noted."
- **Every work-sample LLM call was billed and discarded.** The JSON extractor
  took the first fenced block whatever its language and swallowed the language
  tag, so a reply containing ```sql never parsed. It hit precisely the generator
  whose job is emitting an artefact alongside its JSON.
- **`detectDistress` matched a bare "emergency".** A candidate describing
  on-call work — "we had an emergency at 3am and I ran the rollback" — was told
  "your wellbeing matters more than this interview", had the session ended, and
  received **no assessment**. Systematic, not unlucky: incident response is
  exactly what senior candidates are asked about.

### Two fairness fixes

- **The plan overcommitted its own clock.** A 12-minute interview was planned as
  34 minutes of blocks; the director ran out of time and the assessment reported
  the unasked competencies as "lacks evidence" — marking candidates down for
  questions nobody put to them. Coverage below 0.4 forces `CONSIDER`, so short
  interviews produced lukewarm verdicts regardless of who was in them.
  Production runs at 45 minutes and always fit, so this never reached live
  interviews.
- **"Not asked" and "could not answer" no longer share a code path.** Unasked
  competencies say so, are excluded from coverage, never route through the
  must-pass gate, and are named in the limitations. Confidence now scales by how
  much of the role was attempted, so a partial interview cannot present itself as
  a complete one.

---

## Operational changes

- **`/api/health` reports its commit.** Confirming what production runs is one
  request instead of an SSH session and a git log.
- **The invite flow was verified end to end on production** (6 Aug), through the
  real API: role → scorecard approval → candidate → resume → interview → invite.
  A CV reading "2016 – Present" now parses as 10 years and bands as `senior`,
  with 13 blocks fitting inside 45 minutes and nothing dropped.
- **`WEB_ORIGIN`** is `https://questor.187-127-166-193.sslip.io`, so portal links
  resolve correctly.
- **Candidate erasure requires a written reason** (1–500 chars) and cascades
  through sessions, plans, invitations, artifacts and evidence nodes.

---

## Still open — unchanged from the guide

Nothing below was addressed by this work, and none of it is a coding problem I
can close alone:

1. **No load or concurrency testing.** Behaviour at 20+ simultaneous interviews
   is unknown. Stagger the first batch.
2. **No bias audit.** The system recommends outcomes affecting employment. The
   band model avoids age-proxy scoring by design and the policy engine screens
   protected topics, but **nobody has tested for disparate impact across real
   demographic groups**. For automated hiring this is a legal requirement in
   several jurisdictions, not a nice-to-have. Needs real data and counsel.
3. **No monitoring or alerting.** A 3am failure mid-interview tells nobody.
4. **`npm audit` warnings outstanding.** `--force` installs breaking majors; not
   something to run unattended on production.
5. **Only synthetic candidates so far.**
6. **`emerging` still sits at 0.22** — 2 of 9 entry-level candidates pitched one
   band high. Much better than 1.11, worth watching if your first cohort is
   junior-heavy.

---

## Before the first real candidate

- Keep `humanReviewRequired` on.
- Send one invite to yourself and **take the interview**. Five minutes of that
  will teach you more about how Schranders sounds than 72 simulated interviews
  did.
- Read the first transcripts next to their assessments
  (`GET /api/interviews/:id/transcript`).
- Check `/api/health` returns the commit you expect before a batch goes out.
