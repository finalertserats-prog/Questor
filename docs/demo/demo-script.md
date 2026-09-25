# Questor guided demo — narration script

Status: **approved and built** (2026-09-24). Draft 2 moved the door to the front at the owner's request; draft 3 recut B19 so the closing card offers only what is on, and dropped every line that described what the demo runs on. Nothing in the tour is built until this is agreed; the narration is recorded once, so a changed word later means a re-recording.

Storyboard: `scratchpad/mockups/questor-demo-storyboard.html` (one frame per beat, both themes, phone-safe).

---

## The arc

One hire, start to finish, in under six minutes. It opens at the door — the sandbox's own sign-in page — because the visitor has arrived inside an organisation without ever signing in, and a person should know where they are before a story starts. The organisation is the visitor's own sandbox, named after their company. The role is the **Senior Data Engineer in Bengaluru** the sandbox already holds. The candidate is **Priya Sharma**, whose CV the sandbox already holds; her interview with **Maya** has happened and is waiting for a person to review it — which is exactly where a hiring manager would find it on a Tuesday morning. The story walks the product's own four steps in order: the role and its scorecard; the candidate and what her CV says; the interview and the transcript it leaves; the assessment, with the machine's reading and the person's verdict kept apart. It ends at the decision, then answers the question a visitor only has once they want in — how an organisation and a person ask for an account — and hands them two things to do next: explore with a role of their own, and take the interview themselves.

The screens appear because the story passes through them, never the other way round. The door, Home, Dashboard, Roles, Candidates, Interviews, the assessment and the account request all feature — but each earns its place with a line about Priya, not a line about a tab. The narration never describes a button; it says what a person does and why Questor is built that way. Two lines say what Questor believes ("a claim without a quote is not evidence"; "the machine assesses, a person judges"). Everything else is plain.

---

## Voice

The voice is the product's own, as set in `app.css`: measured, declarative, no hype, British spelling, the occasional dry sentence. It explains *why* more than *what*. It never promises a quality the demo cannot deliver — nothing about how the interviewer sounds, nothing about speed or accuracy, no adjectives about the AI. It names real things on screen: Priya, Maya, the competencies as the scorecard lists them, the five interviewers by name, the three verdicts by name.

Recording notes: a single narrator; conversational studio read at roughly 150 words a minute; a beat of silence at the start and end of every file so the captions and the spotlight can settle first. Em dashes are pauses. Nothing is emphasised by volume.

---

## Cast and data (all real, all already in the sandbox)

| Thing | What the visitor actually sees | Where it comes from |
|---|---|---|
| Organisation | `<Company> (demo)` at `/o/<company>-demo` | `provisionDemoTenant` — the company on the demo request; the tenant's own slug |
| Visitor's account | their own name, demo role | the `User` row named after the visitor |
| Role | **Senior Data Engineer** · Senior · Full-time · Bengaluru (Hybrid) · scorecard v1 approved | `DEMO_JD` through the role heuristic |
| Scorecard competencies (11) | SQL & Data Warehousing · Data Engineering & Pipelines · Cloud & Platform Architecture · Machine Learning Engineering · Data Governance & Quality · Data Modeling · Reliability & Operations · Communication · Problem Solving · Collaboration · Ownership & Impact — pass threshold 65, 3 must-pass | `extractRoleHeuristic(DEMO_JD)` (run against the release branch; see decisions 3 and 4) |
| Candidate (the story) | **Priya Sharma** — Senior Data Engineer, FinEdge Analytics; Snowflake, Airflow, dbt, Spark; B.Tech NIT Trichy | `DEMO_RESUME`, under her own name (decision 1) |
| Candidate (the visitor) | the visitor's own name, same CV, interview INVITED, consent not yet given | existing provisioning — this is the interview they take at the end |
| Interviewer | **Maya** | pinned for the seeded interview (decision 2) |
| Interview | 30-minute slot, 25 turns over about 24 minutes, assessment scored, **not yet reviewed** | seeded from the headless simulation's answers (decision 1) |
| Verdicts | Proceed · Consider · Do not progress | `verdictVocabulary.ts` |
| Pipeline stages | Participation · Bronze · Silver · Gold · Diamond | `PipelinePanel` |
| Sign-in | `/o/<company>-demo` — the organisation's own sign-in card, "No account yet? Ask <Company> (demo) for one"; `/signup` — "Request an account": name, email, password, then "Start a new organisation — you would be its first user" / "Join an organisation — someone there already uses Questor" | current pages at 1f41c29 |

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

### B02 · The door — 0:19
- **Screen:** `/o/<company>-demo` — the sandbox's own organisation sign-in page, in the public shell (no sidebar, no demo bar; the player carries End demo). Shown, never submitted; the visitor's session is untouched. **Anchor:** `org-signin` *(new — the sign-in card)*.
- **Narration / caption:**
  > First, where you are. Every organisation on Questor has its own sign-in page at its own address — this one is your sandbox's. Your demo link brought you past it; your team would come in through it each morning.
- **Why here:** the visitor arrived inside an organisation without signing in, which is quietly disorienting. The door first says where they are; "come in each morning" hands straight to Home.
- **Duration:** 38 words · ~15 s

### B03 · Home — 0:35
- **Screen:** `/` Home — the app returns to the shell. **Anchor:** `home-needs-you` *(new — the "What needs you" section)*. On a phone the drawer stays closed; this is page content.
- **Narration / caption:**
  > Home is where a hiring manager's day starts: what needs you, most urgent first; then what's coming up; then what's done. Near the top right now — an interview waiting for a person to review it.
- **Note:** Priya's unreviewed interview is what puts a row in "What needs you". The line says "near the top" rather than "one thing", so it stays true if the visitor's own invitation is also listed as closing soon.
- **Duration:** 35 words · ~14 s

### B04 · The Dashboard tab — 0:50
- **Screen:** `/?tab=dashboard` — the app switches tabs as the spotlight lands on the tab. **Anchor:** `landing-tab-dashboard` *(new — the Dashboard tab button)*.
- **Narration / caption:**
  > Beside Home sits the Dashboard: the same work, as numbers.
- **Duration:** 10 words · ~4 s

### B05 · Key metrics — 0:55
- **Screen:** `/?tab=dashboard`. **Anchor:** `kpis` *(existing)*.
- **Narration / caption:**
  > Open roles, candidates, who's in the pipeline, what's scheduled this week, what's waiting for review. Every tile is a link to the list behind it — a number you can't open is a number you can't check.
- **Duration:** 36 words · ~14 s

### B06 · The four steps — 1:10
- **Screen:** `/?tab=dashboard`. **Anchor:** `workflow` *(existing — the workflow diagram)*.
- **Narration / caption:**
  > And the whole of Questor is four steps: a role, a candidate, an interview, an assessment. Let's take them in order.
- **Duration:** 21 words · ~8 s

### B07 · The role — 1:19
- **Screen:** `/roles/<Senior Data Engineer>` — the app navigates via the sidebar's Roles item (spotlight brushes `nav-roles` for a beat, then lands on the page). **Anchor:** `role-scorecard-status` *(new — the "Scorecard approved — ready to interview candidates" banner)*.
- **Narration / caption:**
  > A role begins with its job description. Paste it in — this one is a Senior Data Engineer, in Bengaluru — and Questor drafts the scorecard: the competencies every interview for this role will be measured against.
- **Duration:** 35 words · ~14 s

### B08 · The scorecard — 1:34
- **Screen:** `/roles/<id>`, scrolled to the competencies. **Anchor:** `role-competencies` *(new — the CompetencyEditor card)*.
- **Narration / caption:**
  > For this role: SQL and data warehousing, pipelines, cloud architecture, data modelling, reliability — and the human ones: communication, problem solving, collaboration, ownership. Each carries a weight and a required level. A person approves the scorecard before anyone is interviewed, so every candidate is judged by the same instrument.
- **Note:** every competency named is on the seeded scorecard, in the order it lists them. The line does not claim to be the whole list (see decision 3 about the ones it leaves out).
- **Duration:** 48 words · ~19 s

### B09 · The candidate — 1:54
- **Screen:** `/candidates/<Priya Sharma>` (Candidate profile tab), via `nav-candidates`. **Anchor:** `candidate-fit` *(new — the "What the CV says about this role" card)*.
- **Narration / caption:**
  > Priya Sharma has applied. Her CV is read against the scorecard, line by line: where it points at a competency, and where it's silent. This is what the CV says. It says nothing yet about Priya — that comes from the interview.
- **Duration:** 41 words · ~16 s

### B10 · The path — 2:11
- **Screen:** `/candidates/<id>`, Candidate journey tab — the app switches tabs. **Anchor:** `candidate-pipeline` *(new — the PipelinePanel)*.
- **Narration / caption:**
  > Her journey tab shows the path every candidate walks: Participation; Bronze, the profile review; Silver, the AI interview; Gold, the human rounds, where the AI only listens and transcribes; and Diamond, decided. Questor moves her forward on its own. The call that matters, it leaves to a person.
- **Duration:** 48 words · ~19 s

### B11 · Setting up the interview — 2:31
- **Screen:** `/candidates/<id>`, journey tab, scrolled to the set-up card. **Anchor:** `candidate-setup-interview` *(new — the "Set up interview" card)*.
- **Narration / caption:**
  > Here an interview is set up: how long, what gets asked, and which of Questor's five interviewers — Avery, Maya, Adrian, Elena or Theo — runs it. They differ in name and voice, nothing else. The candidate gets a link, a plain statement that they'll be talking to an AI, and nothing begins until they've agreed.
- **Duration:** 54 words · ~22 s

### B12 · The interview — 2:54
- **Screen:** `/interviews/<Priya's session>`, via `nav-interviews`. **Anchor:** `interview-transcript` *(new — the Transcript card)*.
- **Narration / caption:**
  > This is Priya's interview with Maya, as it happened. Maya asked; Priya answered; where an answer was thin, Maya asked again. Every turn is kept with its time, because in Questor a claim without a quote is not evidence.
- **Note:** the seeded transcript is fixed text (decision 1), so "where an answer was thin, Maya asked again" is guaranteed to be visible — one follow-up turn is part of the seed.
- **Duration:** 39 words · ~16 s

### B13 · What the AI found — 3:11
- **Screen:** `/assessments/<id>`, Part 1. **Anchor:** `assessment-ai` *(new — the Part 1 section, `#part-ai`)*.
- **Narration / caption:**
  > After the interview, the assessment. For each competency: the level the AI found, and the quote from the transcript, with its timestamp, that supports it. Where there wasn't enough evidence it says so, rather than guessing. Strengths, concerns, and the questions it couldn't settle are listed just as plainly.
- **Duration:** 49 words · ~19 s

### B14 · What the reviewer decides — 3:31
- **Screen:** `/assessments/<id>`, Part 2. **Anchor:** `assessment-review` *(new — the Part 2 section)*.
- **Narration / caption:**
  > Then the part that makes Questor what it is. A person reads the transcript — Questor checks that they have — and records their own verdict: proceed, consider, or do not progress. Where an organisation reviews blind, the AI's recommendation stays out of sight until the reviewer has written theirs. The machine assesses. A person judges.
- **Note:** "where an organisation reviews blind" is conditional on purpose: the line is true whether the sandbox's org setting is blind or not.
- **Duration:** 54 words · ~22 s

### B15 · Where they differ — 3:54
- **Screen:** `/assessments/<id>`, Part 3. **Anchor:** `assessment-differences` *(new — the Part 3 section, `#part-differences`; it renders "nothing to compare yet" before a review, which is the state the story is in)*.
- **Narration / caption:**
  > And where the two differ, both readings sit side by side, with no commentary from either. Over a season of hiring, that's how a team learns where the machine can be trusted — and where it can't.
- **Duration:** 36 words · ~14 s

### B16 · The decision — 4:09
- **Screen:** `/assessments/<id>`, back to Part 2's verdict form. **Anchor:** `assessment-verdict` *(new — the VerdictPanel form)*.
- **Narration / caption:**
  > This is where the decision is recorded. A verdict moves Priya on: to the human rounds, or to a decision with a feedback letter drafted for her — because a candidate who gave you half an hour deserves more than silence.
- **Duration:** 39 words · ~16 s

### B17 · Asking to be let in — 4:26
- **Screen:** `/signup` (public shell). **Anchor:** `signup-modes` *(new — the "What are you asking for?" fieldset, with both options inside it)*.
- **Narration / caption:**
  > When you want in for real — nobody opens an account by themselves. A new organisation starts here; a person asks to join theirs here. Each request goes to a human, who opens the door, or doesn't. Slower than a sign-up button. That's the point.
- **Why here, not with the door:** the door says where you are; this answers "how would I get in", which a visitor only asks once they want in. Administrative trivia at the start, the natural next step at the end.
- **Duration:** 46 words · ~18 s

### B18 · Yours to explore — 4:45
- **Screen:** `/` Home. **Anchor:** none (centred card). The tour overlay lifts as this line ends; the app is live underneath.
- **Narration / caption:**
  > That's the story. Now Questor is yours. Open anything — or better, paste a job description of your own and watch Questor draft its scorecard. Everything here is sample data in a sandbox that's deleted afterwards; nothing you do can reach a real customer.
- **On the card, text only, beneath the caption:** `In the demo you can add up to 2 roles, 3 candidates and 3 interviews.` — the numbers come from the server (`GET /demo/status`), never hard-coded in the tour, so a cap change never contradicts the card.
- **Duration:** 43 words · ~17 s

### B19 · The interview, two ways — 5:03
- **Screen:** `/` Home. **Anchor:** none (centred card with the two choices; the choice itself is the other lane's UI — this beat hands over to it).
- **Narration / caption:**
  > And the best part: the interview itself. Sit in on one, with one of our interviewers, about the role you've just seen. It's a demo, so it's short — about fifteen minutes — and it ends the way a real first round ends. Choose when you're ready.
- **On the card (text only):** exactly the ways of sitting the interview that `GET /demo/status` reports as on offer — `[ Take the interview as the candidate — about 15 minutes ]` and/or `[ Watch an interview from the hiring team's side ]` — plus `[ Explore first ]`. An option that is not on offer is simply absent: no greyed button, no explanation. When neither is on offer the beat is not played at all. Nothing on the card or in the audio describes what the demo runs on.
- **Why this beat is written the way it is:** the owner's rule is that nothing may break character mid-interview — no "your limit has been reached", no countdown, no apology. So the framing happens here, once, warmly, before the choice: it is a demo, it is short, it ends the way a real first round ends. After this the interview is the interview. And the audio names no mode, so the one recording holds whichever the card offers.
- **Duration:** 45 words · ~18 s

**End of narration: about 5:05 of speech, about 5:25 with navigation.** If the owner wants it shorter still, B06 (8 s) and B15 (14 s) are the two lines that can go without breaking the story.

---

## Timing summary

| Beat | Screen | Anchor | Words | ~s | Ends at |
|---|---|---|---|---|---|
| B01 Welcome | Home | — | 44 | 18 | 0:18 |
| B02 The door | /o/slug | org-signin | 38 | 15 | 0:34 |
| B03 Home | Home | home-needs-you | 35 | 14 | 0:49 |
| B04 Dashboard tab | Dashboard | landing-tab-dashboard | 10 | 4 | 0:54 |
| B05 Key metrics | Dashboard | kpis | 36 | 14 | 1:09 |
| B06 Four steps | Dashboard | workflow | 21 | 8 | 1:18 |
| B07 The role | Role | role-scorecard-status | 35 | 14 | 1:33 |
| B08 Scorecard | Role | role-competencies | 48 | 19 | 1:53 |
| B09 Candidate | Candidate · profile | candidate-fit | 41 | 16 | 2:10 |
| B10 The path | Candidate · journey | candidate-pipeline | 48 | 19 | 2:30 |
| B11 Set-up | Candidate · journey | candidate-setup-interview | 54 | 22 | 2:53 |
| B12 Interview | Interview | interview-transcript | 39 | 16 | 3:10 |
| B13 AI found | Assessment · 1 | assessment-ai | 49 | 19 | 3:30 |
| B14 Reviewer | Assessment · 2 | assessment-review | 54 | 22 | 3:53 |
| B15 Differ | Assessment · 3 | assessment-differences | 36 | 14 | 4:08 |
| B16 Decision | Assessment · 2 | assessment-verdict | 39 | 16 | 4:25 |
| B17 Asking in | /signup | signup-modes | 46 | 18 | 4:44 |
| B18 Explore | Home | — | 43 | 17 | 5:02 |
| B19 Interview | Home | — | 45 | 18 | 5:21 |
| | | **Total** | **761** | **~304 + ~18 nav** | **~5:22** |

Every anchor marked *new* is one `data-tour` attribute on an element that already exists. Twelve new anchors, seven existing (`nav-roles`, `nav-candidates`, `nav-interviews` are brushed in passing; `kpis`, `workflow`, `landing-tab-*`, `nav-dashboard` are landed on). The public pages (`/o/:slug`, `/signup`) were re-checked against 1f41c29: the org page is the organisation's own sign-in card with "No account yet? Ask <org> for one"; signup now asks for a password and offers "Start a new organisation" / "Join an organisation" — the B17 line was reworded to match ("starts here" / "asks to join theirs here").

---

## What is on screen at every beat

**Revised 2026-09-25 (owner's verdict on the built version):** the docked player and the self-advancing narration are gone. The demo is presented exactly as the product tour is — the spotlight ring and scrim, and a coach-mark card anchored beside the element (a sheet at phone width), carrying "Step 8 of 19", a title, the line, and **Skip tour / Back / Next** (Finish on the last). The visitor reads and presses Next; nothing advances on its own, and no audio is played or waited for. The two closing cards carry their buttons above Back and Next (B18: **New role**; B19: exactly the ways of sitting the interview that are on), and **End demo** sits under a rule at the foot of every card, with its own confirm, so the way out is there on the public pages where the demo bar is not. The lines above were written to be spoken; `demoScript.ts` carries them cut for reading on a card (the list of competencies in B08 is left to the screen, which is spotlighting it), with nothing they taught removed. The rest of this section is kept for the recording, should it ever be wanted.

Focus stays in the card while the tour runs (the product tour's focus trap); Tab wraps within it. With `prefers-reduced-motion`, the spotlight jumps instead of gliding and the page scrolls instantly (`tourMotion`). Because B02 and B17 are public-shell pages, the overlay mounts above both shells.

---

## Decisions the script depends on (for the owner)

1. **Seed a completed, unreviewed interview for Priya Sharma.** Today the sandbox holds one candidate (the visitor's name over Priya's CV) with one INVITED interview — no transcript, no assessment, so B12–B16 would play over empty states. The proposal: provisioning adds Priya Sharma as a second candidate on the same role, with a fixed transcript (the headless simulation's answers, which are hers, plus one follow-up turn) and a scored assessment, **not yet reviewed** — so she appears in "What needs you" (B03), the verdict form is live (B16), and Part 3 honestly reads "nothing to compare yet" (B15). Fixed text rather than a live run, so the recorded narration can never drift from what is on screen. The visitor's own candidate stays as it is: theirs to interview.
   - *Side-effect to decide:* two candidates would then share one CV text. The clean fix is a second short CV for the visitor's candidate (new seed content, about 20 lines); the cheap fix is to accept it — the visitor is unlikely to open both profiles side by side.
2. **Pin Maya as Priya's interviewer** in the seeded interview (today's provisioning picks at random), so B12 can say her name. The visitor's own interview keeps the random pick — they will meet whichever of the five they get, exactly as B11 says.
3. **The seeded scorecard contains "Product Management" and "ML / AI Engineering".** Both are real output of the heuristic on the JD ("partner with … product teams", "machine learning feature pipelines"). The narration lists only what a hiring manager would nod at; a visitor scrolling the role page will still see the other two. Recommend the demo scorecard be curated (drop Product Management; keep or drop ML / AI) — it is `status: 'approved'` seed data, not something the visitor generates. This is a judgement about how the product presents itself, so it is the owner's.
4. **The role header reads "Bengaluru (Hybrid) | Employment type: Full-time | Level: Senior" as the location**, because `DEMO_JD` puts all three on one line and the heuristic takes the whole line. A one-line change to the seed text (three lines instead of one) fixes what the visitor sees; the engine is untouched.
5. **Exploring lets them create, within 2 roles / 3 candidates / 3 interviews** (owner, 2026-09-24). `assertDemoCreationCap` is lowered, nothing else about the guards changes, and every refusal (a cap, `/admin`, a blocked action) is reworded to the demo's friendly form — "This is a read-only part of the demo" / "That's the demo's limit — two roles is enough to see how it works" — never an error tone. The cap numbers on the B18 card come from the server.
6. **When the AI is degraded** (no credit: built-in writer, browser voice) the pre-recorded narration and the seeded evidence are unaffected, which is why the story is seeded rather than generated. For the live parts, the rule (owner, 2026-09-24) is that nothing below the product's standard is offered, so there is nothing to disclaim: `GET /demo/status` reports which ways of sitting the interview are on (`modes.candidate`, `modes.observer` — both the demo-interview lane's switches, in `services/demoPolicy.ts`), the B19 card renders exactly those, and the beat is not played when neither is on. The narration never mentions voice, model or mode, so one recording holds in every state. The demo bar's own "Try the interview as the candidate" button is the interview lane's to gate by the same signal.
7. **The door opens the story (B02) and the account request closes it (B17)** — the owner's call, 2026-09-24. Both are public-shell pages, so the tour overlay mounts above both the app shell and the public shell, and the player carries End demo on them.

### Which of these gate the build

- **Needed before the seed and tour work can start: 1** (and **2** with it — one line in the same seed change). It decides what the sandbox contains, which anchors have real content behind them, the Home line, and what the e2e walk asserts.
- **Can be built without, and settled any time before recording: 3 and 4.** Both are seed-text edits independent of the tour; the narration is true either way.
- **Already decided or the script's own call: 5, 6, 7.**
- Meanwhile the player, the twelve anchors and their test, `GET /demo/status`, the lower caps and the friendly refusals can all start today.

---

## What the audio will take (for the report)

- **Source of truth:** the narration lines in this file are lifted into `web/src/components/demo/demoScript.ts` (one object per beat: id, route, anchor, caption, seconds). The captions and the recording script are the same strings, so they cannot drift.
- **Files:** one audio file per beat — `web/public/demo/narration/B01.mp3` … `B19.mp3` — plus `manifest.json` `{ beatId: { durationMs, sha256 } }`. The player looks up the manifest at start; a beat with no entry runs on its caption for the scripted seconds. **Dropping the files in later needs no code change.**
- **Generation:** `scripts/demo-narration.mjs` reads `demoScript.ts`, calls OpenAI's speech endpoint once per beat with a single fixed voice and the "studio, conversational, unhurried" instruction, writes the files and the manifest. It needs `OPENAI_API_KEY` with credit on the account, run once from a developer machine, and the output committed (about 19 files, roughly 3–4 MB in total at 64 kbps). ~790 words ≈ 4,300 characters; at list prices for the text-to-speech models this is pennies, not dollars — well under a dollar even at the HD tier. Re-running it after a wording change costs the same again.
- **Alternative with no credit at all:** a human read into any recorder, exported as the same 19 files, is equally valid — the player does not care where the audio came from.
- **Until then:** the tour ships and works fully from captions, and says nothing about it.
