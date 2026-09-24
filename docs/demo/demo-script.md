# Questor guided demo — narration script

Status: **draft for the owner's approval** (2026-09-24). Nothing in the tour is built until this is agreed; the narration is recorded once, so a changed word later means a re-recording.

Storyboard: `scratchpad/mockups/questor-demo-storyboard.html` (one frame per beat, both themes, phone-safe).

---

## The arc

One hire, start to finish, in under six minutes. The organisation is the visitor's own sandbox, named after their company. The role is the **Senior Data Engineer in Bengaluru** the sandbox already holds. The candidate is **Priya Sharma**, whose CV the sandbox already holds; her interview with **Maya** has happened and is waiting for a person to review it — which is exactly where a hiring manager would find it on a Tuesday morning. The story walks the product's own four steps in order: the role and its scorecard; the candidate and what her CV says; the interview and the transcript it leaves; the assessment, with the machine's reading and the person's verdict kept apart. It ends at the decision, with the door — how a real organisation and a real person get in — and then hands the visitor two things to do next: explore with a role of their own, and take the interview themselves.

The screens appear because the story passes through them, never the other way round. Home, Dashboard, Roles, Candidates, Interviews, the assessment, the organisation sign-in page and the account request all feature — but each earns its place with a line about Priya, not a line about a tab. The narration never describes a button; it says what a person does and why Questor is built that way. Two lines say what Questor believes ("a claim without a quote is not evidence"; "the machine assesses, a person judges"). Everything else is plain.

---

## Voice

The voice is the product's own, as set in `app.css`: measured, declarative, no hype, British spelling, the occasional dry sentence. It explains *why* more than *what*. It never promises a quality the demo cannot deliver — nothing about how the interviewer sounds, nothing about speed or accuracy, no adjectives about the AI. It names real things on screen: Priya, Maya, the competencies as the scorecard lists them, the five interviewers by name, the three verdicts by name.

Recording notes: a single narrator; conversational studio read at roughly 150 words a minute; a beat of silence at the start and end of every file so the captions and the spotlight can settle first. Em dashes are pauses. Nothing is emphasised by volume.

---

## Cast and data (all real, all already in the sandbox)

| Thing | What the visitor actually sees | Where it comes from |
|---|---|---|
| Organisation | `<Company> (demo)` | `provisionDemoTenant` — the company on the demo request |
| Visitor's account | their own name, demo role | the `User` row named after the visitor |
| Role | **Senior Data Engineer** · Senior · Full-time · Bengaluru (Hybrid) · scorecard v1 approved | `DEMO_JD` through the role heuristic |
| Scorecard competencies (12) | SQL & Data Warehousing · Data Engineering & Pipelines · Cloud & Platform Architecture · ML / AI Engineering · Product Management · Security & Compliance · Data Modeling · Reliability & Operations · Communication · Problem Solving · Collaboration · Ownership & Impact — pass threshold 65, 3 must-pass | `extractRoleHeuristic(DEMO_JD)` (run against the release branch; see decisions 3 and 4) |
| Candidate (the story) | **Priya Sharma** — Senior Data Engineer, FinEdge Analytics; Snowflake, Airflow, dbt, Spark; B.Tech NIT Trichy | `DEMO_RESUME`, under her own name (decision 1) |
| Candidate (the visitor) | the visitor's own name, same CV, interview INVITED, consent not yet given | existing provisioning — this is the interview they take at the end |
| Interviewer | **Maya** | pinned for the seeded interview (decision 2) |
| Interview | COMPLETED, transcript of about a dozen turns, assessment scored, **not yet reviewed** | seeded from the headless simulation's answers (decision 1) |
| Verdicts | Proceed · Consider · Do not progress | `verdictVocabulary.ts` |
| Pipeline stages | Participation · Bronze · Silver · Gold · Diamond | `PipelinePanel` |
| Sign-in | `/o/<company>-demo` — "Sign in to <Company> (demo)"; `/signup` — "Request an account" with "a new organisation" / "an account at my organisation" | existing pages |

---

## How to read a beat

- **Screen** — the route the app genuinely navigates to before the line starts.
- **Anchor** — the `data-tour` value spotlighted. *Existing* anchors are already in the markup; *new* ones are added in the build, and a web test fails if any anchor in the script is missing from the rendered page.
- **Narration** — the words as spoken. **The caption is the narration, verbatim** — nothing is audio-only. The one place the caption carries more than the audio is the start card and the two closing cards, which show the visitor's name and the demo's live caps and notices as *text only* (the audio is recorded once and cannot say a name).
- **Duration** — speech at ~150 wpm, rounded; add roughly a second between beats for the navigation and the spotlight to settle.
- A missing anchor skips the beat cleanly (the existing `findPresent` rule); the audio for a skipped beat is not played.

---

## The beats

### B00 · Start card — nothing plays yet
- **Screen:** `/` (Home tab), the app fully loaded behind a centred card. **Anchor:** none (centred).
- **On the card (text, not audio):**
  > **Hello, {visitor's first name}.**
  > This is a five-minute story of one hire in Questor, told over the real product. Nothing plays until you press Start. Captions stay on throughout; you can pause, replay a line, or skip ahead at any time.
  > **[ Start the story ]**  [ Skip — explore Questor instead ]  · End demo
- **Why:** browsers refuse audio without a gesture, and a visitor deserves to choose the moment. The name comes from the demo request; the audio never says it.
- **Duration:** until pressed.

### B01 · Welcome — 0:00
- **Screen:** `/` Home. **Anchor:** none (centred card, scrim over the page).
- **Narration / caption:**
  > Welcome to Questor. In the next five minutes you'll follow one hire from beginning to end: a role, a candidate, an interview, the evidence, and a decision. The real product moves behind these words, so what you see is what your team would see.
- **Duration:** 44 words · ~18 s

### B02 · Home — 0:19
- **Screen:** `/` Home. **Anchor:** `home-needs-you` *(new — the "What needs you" section)*. On a phone the drawer stays closed; this is page content.
- **Narration / caption:**
  > Home is where a hiring manager's day starts: what needs you, most urgent first; then what's coming up; then what's done. Near the top right now — an interview waiting for a person to review it. We'll come back to that.
- **Note:** Priya's unreviewed interview is what puts a row in "What needs you". The line says "near the top" rather than "one thing", so it stays true if the visitor's own invitation is also listed as closing soon.
- **Duration:** 40 words · ~16 s

### B03 · The Dashboard tab — 0:36
- **Screen:** `/?tab=dashboard` — the app switches tabs as the spotlight lands on the tab. **Anchor:** `landing-tab-dashboard` *(new — the Dashboard tab button)*.
- **Narration / caption:**
  > Beside Home sits the Dashboard: the same work, as numbers.
- **Duration:** 10 words · ~4 s

### B04 · Key metrics — 0:41
- **Screen:** `/?tab=dashboard`. **Anchor:** `kpis` *(existing)*.
- **Narration / caption:**
  > Open roles, candidates, who's in the pipeline, what's scheduled this week, what's waiting for review. Every tile is a link to the list behind it — a number you can't open is a number you can't check.
- **Duration:** 36 words · ~14 s

### B05 · The four steps — 0:56
- **Screen:** `/?tab=dashboard`. **Anchor:** `workflow` *(existing — the workflow diagram)*.
- **Narration / caption:**
  > And the whole of Questor is four steps: a role, a candidate, an interview, an assessment. Let's take them in order.
- **Duration:** 21 words · ~8 s

### B06 · The role — 1:05
- **Screen:** `/roles/<Senior Data Engineer>` — the app navigates via the sidebar's Roles item (spotlight brushes `nav-roles` for a beat, then lands on the page). **Anchor:** `role-scorecard-status` *(new — the "Scorecard approved — ready to interview candidates" banner)*.
- **Narration / caption:**
  > A role begins with its job description. Paste it in — this one is a Senior Data Engineer, in Bengaluru — and Questor drafts the scorecard: the competencies every interview for this role will be measured against.
- **Duration:** 35 words · ~14 s

### B07 · The scorecard — 1:20
- **Screen:** `/roles/<id>`, scrolled to the competencies. **Anchor:** `role-competencies` *(new — the CompetencyEditor card)*.
- **Narration / caption:**
  > For this role: SQL and data warehousing, pipelines, cloud architecture, data modelling, reliability — and the human ones: communication, problem solving, collaboration, ownership. Each carries a weight and a required level. A person approves the scorecard before anyone is interviewed, so every candidate is judged by the same instrument.
- **Note:** every competency named is on the seeded scorecard, in the order it lists them. The line does not claim to be the whole list (see decision 3 about the two it leaves out).
- **Duration:** 48 words · ~19 s

### B08 · The candidate — 1:40
- **Screen:** `/candidates/<Priya Sharma>` (Candidate profile tab), via `nav-candidates`. **Anchor:** `candidate-fit` *(new — the "What the CV says about this role" card)*.
- **Narration / caption:**
  > Priya Sharma has applied. Her CV is read against the scorecard, line by line: where it points at a competency, and where it's silent. This is what the CV says. It says nothing yet about Priya — that comes from the interview.
- **Duration:** 41 words · ~16 s

### B09 · The path — 1:57
- **Screen:** `/candidates/<id>`, Candidate journey tab — the app switches tabs. **Anchor:** `candidate-pipeline` *(new — the PipelinePanel)*.
- **Narration / caption:**
  > Her journey tab shows the path every candidate walks: Participation; Bronze, the profile review; Silver, the AI interview; Gold, the human rounds, where the AI only listens and transcribes; and Diamond, decided. Questor moves her forward on its own. The call that matters, it leaves to a person.
- **Duration:** 48 words · ~19 s

### B10 · Setting up the interview — 2:17
- **Screen:** `/candidates/<id>`, journey tab, scrolled to the set-up card. **Anchor:** `candidate-setup-interview` *(new — the "Set up interview" card)*.
- **Narration / caption:**
  > Here an interview is set up: how long, what gets asked, and which of Questor's five interviewers — Avery, Maya, Adrian, Elena or Theo — runs it. They differ in name and voice, nothing else. The candidate gets a link, a plain statement that they'll be talking to an AI, and nothing begins until they've agreed.
- **Duration:** 54 words · ~22 s

### B11 · The interview — 2:40
- **Screen:** `/interviews/<Priya's session>`, via `nav-interviews`. **Anchor:** `interview-transcript` *(new — the Transcript card)*.
- **Narration / caption:**
  > This is Priya's interview with Maya, as it happened. Maya asked; Priya answered; where an answer was thin, Maya asked again. Every turn is kept with its time, because in Questor a claim without a quote is not evidence.
- **Note:** the seeded transcript is fixed text (decision 1), so "where an answer was thin, Maya asked again" is guaranteed to be visible — one follow-up turn is part of the seed.
- **Duration:** 39 words · ~16 s

### B12 · What the AI found — 2:57
- **Screen:** `/assessments/<id>`, Part 1. **Anchor:** `assessment-ai` *(new — the Part 1 section, `#part-ai`)*.
- **Narration / caption:**
  > After the interview, the assessment. For each competency: the level the AI found, and the quote from the transcript, with its timestamp, that supports it. Where there wasn't enough evidence it says so, rather than guessing. Strengths, concerns, and the questions it couldn't settle are listed just as plainly.
- **Duration:** 49 words · ~19 s

### B13 · What the reviewer decides — 3:17
- **Screen:** `/assessments/<id>`, Part 2. **Anchor:** `assessment-review` *(new — the Part 2 section)*.
- **Narration / caption:**
  > Then the part that makes Questor what it is. A person reads the transcript — Questor checks that they have — and records their own verdict: proceed, consider, or do not progress. Where an organisation reviews blind, the AI's recommendation stays out of sight until the reviewer has written theirs. The machine assesses. A person judges.
- **Note:** "where an organisation reviews blind" is conditional on purpose: the line is true whether the sandbox's org setting is blind or not.
- **Duration:** 54 words · ~22 s

### B14 · Where they differ — 3:40
- **Screen:** `/assessments/<id>`, Part 3. **Anchor:** `assessment-differences` *(new — the Part 3 section, `#part-differences`; it renders "nothing to compare yet" before a review, which is the state the story is in)*.
- **Narration / caption:**
  > And where the two differ, both readings sit side by side, with no commentary from either. Over a season of hiring, that's how a team learns where the machine can be trusted — and where it can't.
- **Duration:** 36 words · ~14 s

### B15 · The decision — 3:55
- **Screen:** `/assessments/<id>`, back to Part 2's verdict form. **Anchor:** `assessment-verdict` *(new — the VerdictPanel form)*.
- **Narration / caption:**
  > This is where the decision is recorded. A verdict moves Priya on: to the human rounds, or to a decision with a feedback letter drafted for her — because a candidate who gave you forty-five minutes deserves more than silence.
- **Duration:** 39 words · ~16 s

### B16 · The door — 4:12
- **Screen:** `/o/<company>-demo` — the sandbox's own organisation sign-in page, rendered in the public shell (the tour's player bar stays; the sidebar and demo bar are not on this page, so End demo lives on the player). **Anchor:** `org-signin` *(new — the sign-in card)*.
- **Narration / caption:**
  > Before you explore, the door. Every organisation on Questor has its own sign-in page at its own address; this is where your team would come in each morning.
- **Duration:** 28 words · ~11 s

### B17 · Asking to be let in — 4:24
- **Screen:** `/signup`. **Anchor:** `signup-modes` *(new — the "What are you asking for?" fieldset, with both options inside it)*.
- **Narration / caption:**
  > And nobody opens an account by themselves. A new organisation registers here; a person asks their organisation for an account here. Each request goes to a human, who opens the door — or doesn't. Slower than a sign-up button. That's the point.
- **Duration:** 41 words · ~16 s

### B18 · Yours to explore — 4:41
- **Screen:** `/` Home. **Anchor:** none (centred card). The tour overlay lifts as this line ends; the app is live underneath.
- **Narration / caption:**
  > That's the story. Now Questor is yours. Open anything — or better, paste a job description of your own and watch Questor draft its scorecard. Everything here is sample data in a sandbox that's deleted afterwards; nothing you do can reach a real customer.
- **On the card, text only, beneath the caption:** `In the demo you can add up to 2 roles, 3 candidates and 3 interviews.` — the numbers come from the server (`GET /demo/status`), never hard-coded in the tour, so a cap change never contradicts the card.
- **Duration:** 43 words · ~17 s

### B19 · The interview, two ways — 4:59
- **Screen:** `/` Home. **Anchor:** none (centred card with the two choices; the choice itself is the other lane's UI — this beat hands over to it).
- **Narration / caption:**
  > And the best part. You can take the interview yourself, as the candidate: a real conversation with one of our interviewers, about the role you've just seen. It's a demo, so it's timed — around fifteen minutes, and it draws to a close the way a real first round does. Or, if you'd rather watch than talk, sit in as the observer and see a full interview play through. Choose when you're ready; end the demo whenever you like.
- **On the card (text only):** `[ Take the interview as the candidate — about 15 minutes, timed ]` · `[ Watch an interview as the observer ]` · `[ Explore first ]` · End demo. When the server reports the live model or provider speech is off (`GET /demo/status`), one line is added under the first button: *"While the production model is off for demos, the sample interview runs on Questor's built-in interviewer and your browser's voice. The questions are real; the voice is not."* — and nothing is ever said inside the interview.
- **Why this beat is written the way it is:** the owner's rule is that nothing may break character mid-interview — no "your limit has been reached", no countdown, no apology. So the framing happens here, once, warmly, before the choice: it is a demo, it is timed, it ends the way a real first round ends. After this the interview is the interview.
- **Duration:** 78 words · ~31 s

**End of narration: about 5:30 of speech, about 5:55 with navigation.** If the owner wants it under 5:30 wall-clock, B05 (8 s) and B14 (14 s) are the two lines that can go without breaking the story.

---

## Timing summary

| Beat | Screen | Anchor | Words | ~s | Ends at |
|---|---|---|---|---|---|
| B01 Welcome | Home | — | 44 | 18 | 0:18 |
| B02 Home | Home | home-needs-you | 40 | 16 | 0:35 |
| B03 Dashboard tab | Dashboard | landing-tab-dashboard | 10 | 4 | 0:40 |
| B04 Key metrics | Dashboard | kpis | 36 | 14 | 0:55 |
| B05 Four steps | Dashboard | workflow | 21 | 8 | 1:04 |
| B06 The role | Role | role-scorecard-status | 35 | 14 | 1:19 |
| B07 Scorecard | Role | role-competencies | 48 | 19 | 1:39 |
| B08 Candidate | Candidate · profile | candidate-fit | 41 | 16 | 1:56 |
| B09 The path | Candidate · journey | candidate-pipeline | 48 | 19 | 2:16 |
| B10 Set-up | Candidate · journey | candidate-setup-interview | 54 | 22 | 2:39 |
| B11 Interview | Interview | interview-transcript | 39 | 16 | 2:56 |
| B12 AI found | Assessment · 1 | assessment-ai | 49 | 19 | 3:16 |
| B13 Reviewer | Assessment · 2 | assessment-review | 54 | 22 | 3:39 |
| B14 Differ | Assessment · 3 | assessment-differences | 36 | 14 | 3:54 |
| B15 Decision | Assessment · 2 | assessment-verdict | 39 | 16 | 4:11 |
| B16 The door | /o/slug | org-signin | 28 | 11 | 4:23 |
| B17 Asking in | /signup | signup-modes | 41 | 16 | 4:40 |
| B18 Explore | Home | — | 43 | 17 | 4:58 |
| B19 Interview | Home | — | 78 | 31 | 5:30 |
| | | **Total** | **784** | **~332 + ~24 nav** | **~5:55** |

Every anchor marked *new* is one `data-tour` attribute on an element that already exists. Twelve new anchors, seven existing (`nav-roles`, `nav-candidates`, `nav-interviews` are brushed in passing; `kpis`, `workflow`, `landing-tab-*`, `nav-dashboard` are landed on).

---

## What is on screen at every beat

The player is a bar docked to the bottom of the viewport (a sheet on a phone), not a coach-mark beside the element — captions are always in the same place, and the spotlight is free to be anywhere on the page. It carries, left to right:

- the caption (the narration, verbatim, in the product's UI face; `aria-live="polite"`, one announcement per beat — "Beat 7 of 19: The scorecard", then the line);
- progress as a hairline rule with an accent segment, and `7 / 19` in mono;
- controls, all real buttons with visible labels: **Pause / Resume** (Space), **Replay this line** (R), **Skip this beat** (→), **Back** (←), **Skip the tour** (Esc), **End demo** (its own confirm, exactly the demo bar's).

Focus stays in the player while the tour runs (the existing tour's focus trap); Tab wraps within it. With `prefers-reduced-motion`, the spotlight jumps instead of gliding and the page scrolls instantly (`tourMotion`). With no audio file for a beat, or audio blocked, the beat runs on its caption for the scripted duration and a small "captions only" mark shows on the player; nothing else changes. The spotlight is the existing `tour-spotlight` ring and scrim.

---

## Decisions the script depends on (for the owner)

1. **Seed a completed, unreviewed interview for Priya Sharma.** Today the sandbox holds one candidate (the visitor's name over Priya's CV) with one INVITED interview — no transcript, no assessment, so B11–B15 would play over empty states. The proposal: provisioning adds Priya Sharma as a second candidate on the same role, with a fixed transcript (the headless simulation's answers, which are hers, plus one follow-up turn) and a scored assessment, **not yet reviewed** — so she appears in "What needs you" (B02), the verdict form is live (B15), and Part 3 honestly reads "nothing to compare yet" (B14). Fixed text rather than a live run, so the recorded narration can never drift from what is on screen. The visitor's own candidate stays as it is: theirs to interview.
   - *Side-effect to decide:* two candidates would then share one CV text. The clean fix is a second short CV for the visitor's candidate (new seed content, about 20 lines); the cheap fix is to accept it — the visitor is unlikely to open both profiles side by side.
2. **Pin Maya as Priya's interviewer** in the seeded interview (today's provisioning picks at random), so B11 can say her name. The visitor's own interview keeps the random pick — they will meet whichever of the five they get, exactly as B10 says.
3. **The seeded scorecard contains "Product Management" and "ML / AI Engineering".** Both are real output of the heuristic on the JD ("partner with … product teams", "machine learning feature pipelines"). The narration lists only what a hiring manager would nod at; a visitor scrolling the role page will still see the other two. Recommend the demo scorecard be curated (drop Product Management; keep or drop ML / AI) — it is `status: 'approved'` seed data, not something the visitor generates. This is a judgement about how the product presents itself, so it is the owner's.
4. **The role header reads "Bengaluru (Hybrid) | Employment type: Full-time | Level: Senior" as the location**, because `DEMO_JD` puts all three on one line and the heuristic takes the whole line. A one-line change to the seed text (three lines instead of one) fixes what the visitor sees; the engine is untouched.
5. **Exploring lets them create, within 2 roles / 3 candidates / 3 interviews** (owner, 2026-09-24). `assertDemoCreationCap` is lowered, nothing else about the guards changes, and every refusal (a cap, `/admin`, a blocked action) is reworded to the demo's friendly form — "This is a read-only part of the demo" / "That's the demo's limit — two roles is enough to see how it works" — never an error tone. The cap numbers on the B18 card come from the server.
6. **When the AI is degraded** (no credit: built-in writer, browser voice) the pre-recorded narration and the seeded evidence are unaffected, which is why the story is seeded rather than generated. For the live parts, the choice made here is *say it once, before, in text; never during*: the B19 card shows the one-line notice only when `GET /demo/status` reports the live model or provider speech is off, and the audio never mentions voice or model at all, so the recording is true in both states. With the owner's decision to run the real model on a budget for the candidate-side interview, the notice will normally be absent.
7. **The sign-in story sits at the end, over the real public pages** (B16–B17), as the bridge from "the story" to "how you'd get in for real". The tour overlay must therefore mount above both the app shell and the public shell, and the player carries End demo because the demo bar is not on those pages. If the owner would rather the door came first, B16–B17 move to before B01 with no change to their words.

---

## What the audio will take (for the report)

- **Source of truth:** the narration lines in this file are lifted into `web/src/components/demo/demoScript.ts` (one object per beat: id, route, anchor, caption, seconds). The captions and the recording script are the same strings, so they cannot drift.
- **Files:** one audio file per beat — `web/public/demo/narration/B01.mp3` … `B19.mp3` — plus `manifest.json` `{ beatId: { durationMs, sha256 } }`. The player looks up the manifest at start; a beat with no entry runs on its caption for the scripted seconds. **Dropping the files in later needs no code change.**
- **Generation:** `scripts/demo-narration.mjs` reads `demoScript.ts`, calls OpenAI's speech endpoint once per beat with a single fixed voice and the "studio, conversational, unhurried" instruction, writes the files and the manifest. It needs `OPENAI_API_KEY` with credit on the account, run once from a developer machine, and the output committed (about 19 files, roughly 3–4 MB in total at 64 kbps). ~780 words ≈ 4,300 characters; at list prices for the text-to-speech models this is pennies, not dollars — well under a dollar even at the HD tier. Re-running it after a wording change costs the same again.
- **Alternative with no credit at all:** a human read into any recorder, exported as the same 19 files, is equally valid — the player does not care where the audio came from.
- **Until then:** the tour ships and works fully from captions; the "captions only" mark on the player is the only sign.
