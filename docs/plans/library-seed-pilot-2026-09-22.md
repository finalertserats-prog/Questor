# Questor — Q&A Library: Brahmastra seed pilot

2026-09-22 · branch `feature/library-brahmastra-seed` · builds on L0 (`docs/plans/question-answer-library-plan-v2.md`, "Operating the worker (L0, as built)")

## Summary

The owner asked to fill the question library from the Brahmastra (the Claude, Codex and Gemini command-line tools on the owner's laptop) instead of waiting for an Anthropic key and OpenAI credits on the server. This document covers the offline path that was built for that and a pilot run on two roles.

**Result.** Two rounds over 2 roles × 4 competencies × 2 bands (16 pools) wrote 128 questions. **51 were accepted (40%)** after an independent critic and, where the critic failed a question, a third-lane tie-break. That took **110 CLI calls in 60 minutes: 2.2 calls and 70 seconds per accepted entry, about 51 accepted an hour.** No lane hit a usage limit. All 51 were imported into a local Postgres through the new import, which ran every question through the worker's own gates; importing the same file again wrote nothing.

**After the owner's decisions of the same day, a third round over the pools still below target accepted 32 of 52 (62%) at 1.22 calls and 77 entries an hour**, with every pool filled and seven question forms covered. The numbers below are from the first two rounds unless they say otherwise.

**The owner decided all three on 2026-09-22, plus how entries are approved.** What changed, and what a third round measured, is in "After the owner's decisions" below. The findings that prompted them:

1. **Gemini should not write questions.** As generator it had 3 of 40 accepted (7.5%). Claude and Codex each had 24 of 44 (55%). As critic and tie-break Gemini was fine. It is also the slowest lane: 76–103 s a call against about 20 s for the other two.
2. **The L0 critic rule "anchors leaked" rejected most of what failed.** It appeared in 61 of the 77 rejections, including questions that only named the competency's topic.
3. **The owner queue, not generation, set the pace.** A stratum (scope × role × band × form × prompt version) needed 20 approvals the owner made without edits before its entries could skip the queue: 160 approvals per role and band, tens of thousands across the core fill.

## After the owner's decisions

The owner settled all four points on 2026-09-22 and this branch carries them:

1. **Claude and Codex write; Gemini judges and breaks ties.** That is now the run's default (`--generators` still overrides).
2. **"Leaked" means the question gives the answer away.** The critic rubric (`library-critic-v2`, used by the server worker and the seed run alike) says so, and carries calibration pairs: the same topic and anchors, once as a leak, once as a fair question. Asking about the competency's topic is not a leak.
3. **Approval by policy plus a daily sample.** An entry that passes the generator, a critic of a different model family, the linter and the injection screen goes to `probational` on its own — never live; live still needs clean uses in interviews. Critic-unsure and tie-broken entries still go to the owner queue. The per-stratum 20-approvals gate is gone; the owner watches through the stratified daily sample, sized by `LIBRARY_DAILY_SAMPLE_SIZE` (default 20), and a rejection in the sample still sends that stratum's next 200 entries to the queue.
4. **Only global-catalog text leaves the server.** The export now keeps a pool only when its competency is one of the platform's own and words it as the platform does; it skips catalog roles an organisation typed in, and it carries questions and standards only where the seed run itself wrote them. Pools for an organisation's own competencies stay on the server for the worker, and the export reports how many it left behind.

### Round 3: the decisions, measured

The same two roles, the 13 pools still below target, batch of 4, critic v2, Claude and Codex writing, Gemini judging:

| | Rounds 1–2 (before) | Round 3 (after) |
| --- | --- | --- |
| Accepted / generated | 51 / 128 (40%) | **32 / 52 (62%)** |
| Calls per accepted entry | 2.2 | **1.22** |
| Accepted per hour | 51 | **77** |
| Pools with nothing accepted | 3 of 16 | **0 of 13** |
| Question forms covered | 4 | **7** |
| Accepted by writer | claude 24, codex 24, gemini 3 | claude 16, codex 16 |

39 calls in 24.8 minutes, no usage limit, no failed call. 13 of the 32 went through a tie-break, so they land in the owner queue; the other 19 pass to probational by policy. The two Software Engineer debugging pools that had nothing after two rounds now have entries. Form coverage widened because the export now counts the forms of entries still waiting for the owner, so the next batch asks for the forms a pool lacks.

**Round 3 through the import.** 32 records, 0 invalid, 0 refused, 0 rejected: **10 went to probational by policy and 22 to the owner queue** — 13 because the critics split and a tie-break decided them, the rest for a reading level above grade 14, a critic confidence in the grey band, or a question written without a question mark. That is the approval the owner asked for: clean entries land on their own, the doubtful ones wait.

**The leak rule, checked on held-out questions.** Eight questions the v1 critics had failed only for "anchors leaked", plus two written to leak on purpose, were put to all three lanes under v2: every lane caught both planted leaks (2/2), and they still failed 6, 7 and 4 of the 8 held-out ones. Reading those questions back, most do spell out the anchors ("pushed back by requiring reciprocal business commitments"), so the critics are not wrong: v2 draws the line where the owner wanted it rather than opening the floodgates. The acceptance rise in round 3 comes from both decisions together, with the writer change doing most of the work.

## What was built

```
production (read-only)          owner's laptop                                   production
library:seed-export  ──►  pools.json ──► library:seed-generate ──► seed.jsonl ──► library:seed-import
(the worker's demand queue)            (Claude / Codex / Gemini, L0 prompts)        (the worker's gates)
```

**Export** (`server/src/library/seedExport.ts`, `seedExportMain.ts`). It writes the worker's own demand queue: global pools below target. Each pool carries only what the worker would put in a prompt:
- the catalog role's shared JD draft or summary, never an organisation's own JD;
- the scorecard competency;
- the live family standard, if there is one;
- the pool's global questions so far, so the next batch avoids them, and their forms, so the next batch asks for the forms the pool lacks.

**Generate** (`server/scripts/library-seed/`, laptop only, not compiled into the server). It drives the CLIs as child processes through the server's own prompt builders: `buildStandardPrompt`, `buildQuestionsPrompt`, `buildCriticPrompt` and the L0 critic rubric. The text each model sees is the text the worker would send. What it adds on top:
- **Roles per lane.** Each pool gets a generator lane and a critic lane from a different model family, rotated across pools. When the critic fails a question, the third lane gets a tie-break.
- **Checks before critique.** Replies are parsed item by item, and a malformed item is dropped with its reason. The linter and duplicate check run locally before the critic, to save calls.
- **Limits and pacing.** One call at a time per lane, with a gap between calls. A usage-limit message parks the lane until the time the message gives (Codex's "try again at …", Claude's reset time) or for an hour. Failures back off exponentially. A parked lane is swapped out rather than waited on.
- **Resume.** A checkpoint is written after every pool and a re-run picks up where the last one stopped. There is a run log with one line per call and no text, a `summary.json`, and a `--probe` mode to check that each CLI answers.

**Import** (`server/src/library/seedImport.ts`, `seedImportMain.ts`). Every question goes through the same gates as `worker.ts runBatch`, in the same order:
1. Linter and injection screen (`lintQuestionText`; the rationale is screened too).
2. Near-duplicate check against the pool and its family, using `existingQuestions` shared with the worker. Later lines are compared with earlier ones.
3. Policy gate (`decideGate` with the current policy row and strata). The critic verdict from the file stands in for the worker's critic call.

Pass goes to probational, unsure to the owner queue, fail to rejected with its reasons. There is one `gated` review row per entry, plus one audit event per import. Beyond that:
- **Own strata.** Seeded entries are stamped `library-gen-v1+brahmastra`, so they form their own strata and start in the owner queue, as a new generator prompt version would.
- **The owner looks at more.** A tie-broken question, and one judged against anchors other than the live standard's, always go to the owner.
- **Refused, nothing written.** A record is refused if:
  - its role is not in the catalog, or not in the family it names;
  - its pool is not one the demand could produce (a competency of an approved scorecard, at a band the role is hired at);
  - it has no standard;
  - its critic lane is the lane that wrote it.
- **Standards.** A standard is written only where the family has none. A live standard is never replaced.
- **Idempotent.** A new additive migration (`20260922150000_library_seed_import`) adds `LibraryEntry.contentHash` (unique) and `provenanceJson`. The hash is taken over the pool and the normalised question text, so a second import of a file writes nothing.
- **Serialised with the worker.** The import runs under the worker's lease, so it never gates the same pools as a running worker.
- **Provenance.** Each entry records `generatorModel`/`criticModel` as `brahmastra:<lane>` and a `provenanceJson` holding the source, run, lanes, prompt versions and both verdicts. `createdBy` is `brahmastra`.

**Trust boundary.** The import takes the critic verdicts in the file as written. It is an operator tool that needs a shell on the server, and the file comes from the owner's own run. No verdict can make an entry live: seeded strata start in the owner queue, and moving from probational to live needs real uses in L1.

## The pilot

| | |
| --- | --- |
| Roles | Software Engineer (Engineering / Technical Delivery); Enterprise Account Executive (Professional / Operations) |
| Bands | developing, senior |
| Competencies | 4 per role, from an approved scorecard (`scripts/library-seed/pilotWorld.ts`). Rounds 1–2 used hand-written competencies; since decision 4 the export carries only the platform's own competencies, and the pilot fixture uses those. |
| Shared text | A catalog JD draft per role and band, written for the pilot (generic, no employer) |
| Batch | 4 questions per pool per round (the worker asks for 10) |
| Lanes | Round 1 in the order claude → codex → gemini; round 2 reversed (claude → gemini → codex), so all six generator → critic pairings were measured |
| Machine | The owner's laptop, 3 pools in flight, 5 s gap between calls on a lane. The server test suite ran alongside for the first 8 minutes of round 1. |
| Import | A local embedded Postgres (`questor_library_seed`), all migrations applied, through `library:seed-import` |

### Counts

| | Round 1 | Round 2 | Total |
| --- | --- | --- | --- |
| Pools | 16 | 16 | 16 |
| Family standards written | 16 | 0 (reused) | 16 |
| Questions generated | 64 | 64 | 128 |
| Accepted on the laptop | 19 (30%) | 32 (50%) | **51 (40%)** |
| of which after a tie-break | 7 | 13 | 20 |
| Rejected on the laptop | 45 | 32 | 77 |
| CLI calls (standard / questions / critic / tie-break) | 63 (16 / 16 / 16 / 15) | 47 (0 / 17 / 17 / 13) | 110 |
| Failed calls | 0 | 1 (Gemini exited 1; pool retried) | 1 |
| Usage limits hit | 0 | 0 | 0 |
| Wall clock | 27.7 min | 31.9 min | 59.5 min |
| Calls per accepted entry | 3.3 | 1.5 | **2.2** |
| Accepted per hour | 41 | 60 | **51** |

Round 2 is the steady state: the standards already exist, so each pool costs a questions call, a critic call and usually a tie-break.

### Rejections

On the laptop, 75 of the 77 rejected questions were failed by both the critic and the tie-break lane. The other 2 were failed by the critic while the third lane was parked for a minute. Reasons (a question can have several):

| Reason (first critic) | Questions |
| --- | --- |
| `critic:anchors_leaked` | 61 |
| `critic:generic` (could be asked for any job in the family) | 40 |
| `critic:low_confidence` (< 0.55) | 25 |

No question was dropped as malformed or by the linter or duplicate check on the laptop. All replies from all three lanes parsed.

At import (51 questions): 0 refused, 0 invalid, 0 rejected, **51 queued for the owner, 0 probational** — every one carried `stratum:new`, the per-stratum gate that decision 3 has since removed. Other reasons attached:

| Reason | Entries |
| --- | --- |
| `seed:critics_split` (tie-broken) | 20 |
| `lint:reading_level` (reading grade above 14) | 16 |
| `critic:grey_confidence` (0.55–0.8) | 12 |
| `lint:not_a_question` (no question mark) | 3 |
| `critic:wrong_band` | 1 |
| `critic:wrong_form` | 1 |

Importing round 1 a second time wrote nothing: 19 already imported, 16 standards already existing.

### By lane

| Generator → critic | Accepted / generated |
| --- | --- |
| claude → codex | 11 / 24 |
| claude → gemini | 13 / 20 |
| codex → claude | 17 / 24 |
| codex → gemini | 7 / 20 |
| gemini → claude | 1 / 20 |
| gemini → codex | 2 / 20 |

| Lane | Calls | Average successful call |
| --- | --- | --- |
| Claude | 39 | 20–23 s |
| Codex | 36 | 19–21 s |
| Gemini (through agy) | 35 | 76–103 s |

### Coverage

Accepted entries per pool after both rounds (pool target 6):

| Pool | developing | senior |
| --- | --- | --- |
| Software Engineer · software design & architecture | 2 | 3 |
| Software Engineer · code quality & testing | 4 | 3 |
| Software Engineer · debugging & incident response | **0** | **0** |
| Software Engineer · cross-functional collaboration | 4 | 2 |
| Enterprise Account Executive · pipeline generation & prospecting | 2 | 6 |
| Enterprise Account Executive · complex deal management | 3 | **0** |
| Enterprise Account Executive · negotiation & commercial acumen | 2 | 4 |
| Enterprise Account Executive · forecasting & territory planning | 8 | 8 |

The two empty Software Engineer pools failed as `critic:generic`: an incident question for a generic "Software Engineer" can be asked of any engineer in the family. This is the role-fit check working as designed. A broad catalog title with a generic shared JD gives the generator nothing role-specific to write from. Real organisation roles with richer shared text should do better; the empty Enterprise Account Executive pool was a Gemini-written pool in both rounds.

Only four forms were asked for (star, opinion, disagreement, hypothetical). With a batch of 4 and an empty pool, the form rotation starts at the top of the list, and the first export counted only non-draft entries. The export now counts the drafts waiting for the owner too, so the next batch asks for walkthrough, trade-off, retrospective and work-sample questions.

## Throughput and projection

Measured before the owner's decisions: about **60 accepted entries an hour in steady state** (standards exist), 51 an hour including writing the standards. Measured after them (round 3, the same pools, Claude and Codex writing, critic v2): **77 an hour at 1.22 calls per accepted entry**. That is with three lanes, a batch of 4, and no usage limit reached in 149 calls, about 35–40 calls per lane an hour.

The subscriptions' own limits are the unknown. Claude and Codex both meter in rolling windows and weekly caps, and this pilot did not reach them. Projections, stated with their assumptions:

| Scenario | Assumption | Accepted a day |
| --- | --- | --- |
| Round 3 settings, working day | 8 h of calls, no limit reached | ~600 |
| Round 3 settings, unattended | 16 h (laptop kept awake), no limit reached | ~1,200 |
| Batch of 10 instead of 4 | the same calls cover 2.5× the questions; call time grows with the batch (unmeasured) | up to ×1.5–2 |

**If a usage limit is hit,** the run parks that lane and carries on with the other two. With only one lane left it sleeps until the reset time the CLI printed, capped by `--max-wait-hours`. After that it stops, and a re-run resumes.

For scale: the plan's core fill is about 21,600 entries. At about 600 a day that is 5–6 weeks of laptop time; at about 1,200, under three weeks. **The next step to firm up the numbers** is one long unattended run (6–8 h over the top 10 roles) to find where the first limit lands.

## Sample entries

Ten of the 51, one per family standard. Each is a draft waiting for the owner. The anchors are the family standard the entry is scored against. They are written for experience ("Describes…"), so a hypothetical question is scored against evidence of past work: see samples 3, 4, 6 and 7. That is how L0 standards work (one standard per family × competency × band, not per form); the owner may want to look at it.

### 1. Software Engineer · software design & architecture · senior

*Form:* star · *difficulty:* 2 · *lanes:* claude wrote, codex judged (failed), gemini broke the tie · *critic confidence:* 0.9

> Tell me about a service or API you designed for an enterprise system that several teams had to build on or call. How did you decide where one component ended and another began, what did you do when a team disagreed with those lines, and how did the design hold up in production?

Anchors (family standard):

- Describes a system-level design that spanned several teams and names the boundaries they drew between components and why
- Explains the trade-offs behind an API or data model choice, including the options they rejected and the cost of the one they chose
- Shows how the design handles failure, such as timeouts, retries, partial outages or bad data, and how they tested that
- Explains how the design was meant to scale and change over time, and which parts were built to be easy to replace
- Describes the resistance or disagreement from other teams and how they reached agreement without relying on authority
- States the concrete outcome of the design, such as reliability, delivery speed or cost, and how they know
- Names a design call that turned out wrong at scale, what it cost and what they changed in how they design
- Shows how they spread the design thinking to others, through reviews, written decisions or coaching

### 2. Software Engineer · code quality & testing · developing

*Form:* star · *difficulty:* 2 · *lanes:* claude wrote, gemini judged · *critic confidence:* 0.9

> Tell me about a feature or service you built and shipped to production, where you decided how it would be tested. Walk me through the code you wrote, the automated tests you added and why, and how it held up once it was live.

Anchors (family standard):

- Describes specific code they wrote and owned in production, not just what the team did
- Explains why they chose a given mix of unit, integration and end-to-end tests for that code
- Names what they chose not to test and the risk they accepted by doing so
- Gives an example of refactoring before adding a feature and says what risk it removed
- Describes review feedback they gave that was specific and explains how it was received
- Describes feedback they received, including from someone more senior, and what they changed or why they pushed back
- Links their testing or quality work to a measured result, such as fewer defects, faster reviews or safer releases
- Reflects on what they would do differently next time

### 3. Software Engineer · code quality & testing · senior

*Form:* hypothetical · *difficulty:* 2 · *lanes:* codex wrote, claude judged (failed), gemini broke the tie · *critic confidence:* 0.95

> Suppose you join a team building a new enterprise workflow feature, and the code touches an older service with weak tests, unclear ownership, and a history of production incidents. How would you approach the code changes, reviews, and testing before release?

Anchors (family standard):

- Explains how they set code quality and testing direction across teams, not only within their own code.
- Describes choosing test levels based on risk, change frequency, system boundaries, and failure cost.
- Shows how they used refactoring or design changes to reduce delivery or operational risk before adding features.
- Gives examples of specific review feedback that improved correctness, maintainability, security, or operability.
- Explains how they gained agreement from other teams when standards, ownership, or timelines were contested.
- Connects quality practices to measurable outcomes such as fewer incidents, safer releases, faster reviews, or lower rework.
- Reflects on a quality or testing decision that went wrong at scale, what it cost, and what changed afterward.
- Shows how they raised the judgment of others through review habits, pairing, documentation, or shared testing guidance.

### 4. Software Engineer · cross functional collaboration · developing

*Form:* hypothetical · *difficulty:* 3 · *lanes:* claude wrote, gemini judged (failed), codex broke the tie · *critic confidence:* 0.87

> Suppose you are halfway through building a feature and a production incident shows that one of its core flows will not work with the current data model. The release date is fixed, the designer is attached to the flow, and another engineer is waiting on your service. What would you do in the next two days, and who would you talk to first?

Anchors (family standard):

- Identifies and clarifies ambiguous requirements with product and design partners before building.
- Proposes technical alternatives and trade-offs to balance scope, effort, and delivery deadlines.
- Communicates technical constraints, progress, and blockers clearly without unnecessary jargon.
- Engages cross-functional partners early to address edge cases and user experience gaps.
- Defines clear interface contracts or documentation to keep dependent teammates unblocked.
- Navigates differing opinions constructively by focusing on user outcomes and technical feasibility.

### 5. Software Engineer · cross functional collaboration · senior

*Form:* opinion · *difficulty:* 2 · *lanes:* claude wrote, codex judged · *critic confidence:* 0.86

> Some engineers believe that when a product manager brings a feature request, the engineer's job is to estimate it and build it, while others believe the engineer should push to reshape the scope based on reliability and operating cost. Where do you stand on this for enterprise systems that you also have to run in production, and how would you defend that view to a product lead who disagrees?

Anchors (family standard):

- Describes a specific cross-team effort, their own role in it, and the outcome it produced
- Resolved unclear or conflicting requirements across product, design and engineering before committing teams to build
- Negotiated scope or trade-offs with product and explains the reasoning, the options weighed and what was given up
- Names the resistance they met, who held it and why, and how they reached agreement without formal authority
- Shared context or set shared interfaces and decisions so other teams could move without waiting on them
- Shows measurable impact beyond their own team, such as delivery time, fewer rework cycles or fewer incidents
- Reflects honestly on a collaboration call that went wrong, what it cost, and what they changed afterwards
- Helps others work well across functions, for example by coaching peers or improving how teams hand off work

### 6. Enterprise Account Executive · complex deal management · developing

*Form:* hypothetical · *difficulty:* 2 · *lanes:* codex wrote, gemini judged · *critic confidence:* 0.95

> Suppose you are running a late-stage opportunity with a large organisation: your champion supports the business case, but the economic buyer has not engaged, security review is delayed, and procurement is asking for a discount before legal review is complete. What would you do next?

Anchors (family standard):

- Describes an enterprise deal they owned from unclear need to signed agreement.
- Shows how they mapped stakeholders, found a champion, and reached the economic buyer.
- Explains a mutual close plan with dates, owners, risks, and next steps.
- Covers how they managed legal, procurement, security, or other approval steps.
- Names a key tradeoff in pricing, scope, timing, or terms and defends the choice.
- Shows coordination with internal partners such as technical, success, marketing, or finance teams.
- Gives a measured outcome such as deal value, cycle time, forecast accuracy, conversion, or next-stage result.

### 7. Enterprise Account Executive · negotiation & commercial acumen · senior

*Form:* hypothetical · *difficulty:* 3 · *lanes:* claude wrote, codex judged (failed), gemini broke the tie · *critic confidence:* 0.95

> Suppose you are three weeks from signature on the largest deal in your territory, and the customer's procurement team comes back asking for a forty percent discount, uncapped liability and a one-year term instead of three. Your champion says the deal dies if you do not agree. How would you decide whether to keep negotiating or walk away, and who would you involve in that decision?

Anchors (family standard):

- Describes a high-stakes negotiation they led that involved several stakeholders on both sides and more than one internal team
- Grounds price or terms in the other party's business case and measurable value, not in cost or a list price
- Trades each concession for a specific commitment in return, such as term, volume, scope, timing or payment
- Sets a clear walk-away point before talks begin, and explains the reasoning and who agreed it internally
- Names the resistance they met, internal or external, and how they moved it without formal authority
- States the result in concrete terms: margin, deal size, risk removed, or relationship kept for the long term
- Owns a commercial call that went wrong at scale, what it cost, and what they changed afterwards
- Shows how they built the negotiating skill of others through coaching, playbooks or approval guidelines

### 8. Enterprise Account Executive · negotiation & commercial acumen · developing

*Form:* star · *difficulty:* 2 · *lanes:* claude wrote, gemini judged · *critic confidence:* 0.9

> Tell me about an enterprise deal you ran from discovery to signature where the customer pushed back hard on price. What did you tie your price to, how did the final contract compare with your first proposal, and what did the deal end up being worth?

Anchors (family standard):

- Grounds pricing discussions in the customer's demonstrated business case and value metrics
- Secures equivalent customer commitments in exchange for any pricing or contract concession
- Identifies and holds firm to clear walk-away thresholds on deal margin or contractual terms
- Defends trade-offs made during contract finalisation with specific commercial rationale
- Explains the measured financial or operational outcome of the concluded negotiation

### 9. Enterprise Account Executive · pipeline generation & prospecting · senior

*Form:* star · *difficulty:* 2 · *lanes:* codex wrote, claude judged (failed), gemini broke the tie · *critic confidence:* 0.9

> Tell me about a specific enterprise territory you owned where you had to create pipeline from a thin starting point. How did you choose which large organisations to target, map the buying committee, and turn that research into qualified opportunities?

Anchors (family standard):

- Explains how they built a territory plan from account research, market signals, and revenue potential.
- Shows how they mapped complex buying groups and identified champions, blockers, decision makers, and economic buyers.
- Describes a consistent qualification approach and how it improved pipeline quality, focus, or forecast reliability.
- Balances new logo creation with expansion opportunities and explains the tradeoffs behind that mix.
- Shows cross-functional influence with sales, marketing, technical, customer, or delivery partners to create or progress pipeline.
- Gives evidence of resistance encountered, such as low engagement, unclear ownership, weak data, or competing priorities, and how they resolved it.
- Connects prospecting activity to measurable outcomes such as qualified pipeline, conversion, cycle progression, win rate, or revenue impact.

### 10. Enterprise Account Executive · forecasting & territory planning · developing

*Form:* disagreement · *difficulty:* 2 · *lanes:* claude wrote, codex judged · *critic confidence:* 0.9

> Tell me about a time you and your sales manager disagreed about whether a large enterprise deal would close in the quarter. What was each of you basing your view on, how did you settle it, and how did the deal actually turn out?

Anchors (family standard):

- Describes a territory or set of accounts they owned themselves and how they chose where to spend their time
- Ranks accounts by clear criteria such as potential size, fit and timing, and explains why
- Names what they chose not to pursue and what that cost them
- Backs each forecast call with evidence from the deal, such as confirmed next steps, a named decision maker or an agreed timeline
- Separates likely deals from hopeful ones and explains how they decided which was which
- Keeps records current and explains how accurate data changed a forecast or a plan
- Compares their forecast with the actual result and says what they changed afterwards
- Flags a slipping deal early and tells the people who depend on the number

## Importing into production

Nothing here has touched production. The owner or coordinator does these steps:

1. **Deploy this branch.** The deploy applies the additive migration `20260922150000_library_seed_import`, which adds two columns and a unique index to `LibraryEntry`. It also builds `dist/library/seedExportMain.js` and `dist/library/seedImportMain.js`. The seed does not need `LIBRARY_ENABLED` or `LIBRARY_WORKER_ENABLED`, and nothing an organisation sees changes.
2. **Export the demand on the VPS.** This step is read-only: `cd server && node dist/library/seedExportMain.js --out /tmp/pools.json [--roles slug,slug] [--bands band,band] [--limit N]`. Copy the file to the laptop over the usual SSH path.
   - The file holds catalog text, the competencies of approved scorecards and the pool's global questions, which is exactly what the worker would send to its own generator.
   - The competency definitions come from organisations' approved scorecards. Sending them to personal-subscription CLIs is the owner's call.
   - Delete the file after the run.
3. **Generate on the laptop.**
   - Check the lanes: `cd server && npm run library:seed-generate -- --probe`.
   - Run: `npm run library:seed-generate -- --pools pools.json --out runs/<name> --per-pool 10`. Claude and Codex write and Gemini judges by default; `--generators` overrides.
   - Re-run the same command to resume.
4. **Import on the VPS.** Stop the worker if it is running (`pm2 stop questor-library`). Copy `runs/<name>/seed.jsonl` up and run `node dist/library/seedImportMain.js seed.jsonl --report /tmp/seed-report.json`. It prints counts only. A second run is harmless.
5. **Watch the daily sample** on `/library-admin`, and work the owner queue, which now holds only the entries the critics were unsure about or split over. A rejection in the sample retires that entry and sends its stratum's next 200 entries to the queue.

## Reproducing the pilot locally

With an embedded Postgres (never Docker) and `DATABASE_URL` pointing at it (the Postgres client generated from `prisma/postgres/schema.prisma`, migrations deployed), run from `server`:

```
npx tsx scripts/library-seed/pilotWorld.ts            # pilot roles, scorecards, JD drafts (refuses a non-local database)
npm run library:seed-export -- --out pools.json --roles software-engineer,enterprise-account-executive --bands developing,senior
npm run library:seed-generate -- --pools pools.json --out runs/pilot --per-pool 4 --concurrency 3
npm run library:seed-import -- runs/pilot/seed.jsonl
```
