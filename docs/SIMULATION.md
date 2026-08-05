# Interview simulation harness

A measurement rig for the interviewer itself. Nine agent seats across three
local AI CLIs conduct, sit, and judge interviews against generated roles and
candidates, so that changes to Questor's questioning can be scored rather than
argued about.

It exists to answer one question with a number: **is the interview pitched at the
person actually in it?**

## The two lanes

| Lane | Interviewer | Purpose |
|---|---|---|
| **A** | Questor's real engine | The subject under test. Runs the actual planner, director, conversation runtime and evaluator against the real database, so the transcript is what a real candidate would have got. |
| **B** | A peer AI | The benchmark. What a capable general model does with the same JD, the same CV and the same person answering. |

Both lanes are then scored **blind** by a third peer that had no hand in either.

Judging is per-transcript and absolute, not pairwise. A pairwise judge is more
sensitive but inherits position bias and collapses when one lane fails — which,
in a sweep, is routine. Absolute scores also give the thing the harness is for:
a number that can be tracked across runs as the engine changes.

## The nine seats

Three peers (`claude`, `gemini`, `codex`) fill three roles, giving six
permutations. Each permutation seats one peer as the benchmark interviewer, one
as the candidate, and the third as judge — so no model ever scores an interview
it took part in.

```
interviewer  candidate  judge
claude       gemini     codex
claude       codex      gemini
gemini       claude     codex
gemini       codex      claude
codex        claude     gemini
codex        gemini     claude
```

Permutations rotate across cells so no peer is stuck in one seat for a whole
sweep. The judge peer also doubles as the generator agent for that cell's role
and candidate — it is the one seat with no interview to conduct.

## Experience bands

Six non-overlapping bands, in `src/sim/bands.ts`. The brief asked for ~18
year-ranges; they overlap, and a new question per year is not what changes with
experience. What changes is the **abstraction**: the craft, the system around it,
or the organisation around that.

| Band | Years (prior) | Abstraction |
|---|---|---|
| `emerging` | 0–2 | craft |
| `developing` | 2–5 | craft |
| `established` | 5–8 | system |
| `senior` | 8–12 | system |
| `principal` | 12–18 | organisation |
| `executive` | 18+ | organisation |

Each band carries an `askAbout` list, an `avoid` list, a starting follow-up tier
and an evidence bar. The `avoid` list is the point: a fresher must not be asked
how they architected a system, and a twenty-year veteran must not be asked about
syntax.

**Years are a prior, not the answer.** Banding on years-since-graduation is an
age proxy, and `policyRules.prohibitedTopics` already lists `age`. `inferBand()`
starts from years and then moves at most one band on evidenced scope — promoting
only when the evidence sits *above* the band's own abstraction, so a principal
mentioning P&L is describing the job rather than exceeding it.

## Running it

```bash
# One interview through Lane A — the cheapest proof the rig is wired up.
npm run sim:smoke -w server

# A full sweep, with a report written to server/sim-results/.
npm run sim -w server

# Synthesise the interviewer's lines through both paid TTS connectors.
npm run sim:voice -w server
```

Point it at its own database. It writes synthetic candidates, transcripts and
assessments, and those must never land beside real ones:

```bash
DATABASE_URL="file:./data/sim.db" npx prisma db push --skip-generate -w server
```

It refuses to run with `NODE_ENV=production` unless `ALLOW_SIM_SEED=true`.

### Sweep options

| Variable | Default | Meaning |
|---|---|---|
| `SIM_BANDS` | all six | Bands to cover, comma-separated. |
| `SIM_FAMILIES` | `data_engineering` | Role families. Eight are defined. |
| `SIM_STRENGTHS` | `strong` | `strong`, `borderline`, `weak`. |
| `SIM_LANE_A_ONLY` | `false` | Skip the benchmark lane. Roughly halves the runtime. |
| `SIM_CONCURRENCY` | `2` | Cells in flight. SQLite dislikes much more. |
| `SIM_GENERATE` | `false` | Have a peer invent roles and CVs instead of using templates. |

Budget roughly **5 minutes per Lane A interview** and 2–3 for Lane B, plus a
judging call each. A six-band, both-lane sweep at concurrency 2 takes about half
an hour.

## Templates versus generated fixtures

Both paths exist deliberately.

`SIM_GENERATE=true` asks a peer to invent the role and the candidate, which is
what gives a sweep variety. The default templates are deterministic, which is
what makes the harness testable at all — a fixture that changes every run cannot
tell you whether the engine changed.

The template candidates satisfy a round-trip property enforced by the test
suite: a resume generated *for* a band must infer back *to* that band. Without
it, a calibration failure measured later could just as easily be the fixture's
fault as the engine's.

## What the judge is asked

Four scores, 0–10 — calibration, engagement, evidence yield, fairness — plus the
field that matters most: **which band the questions were actually pitched at**,
judged from the questions alone.

Band distance is then computed as arithmetic on that observation rather than
asked of the judge, so the headline metric is not the judge's opinion of its own
opinion.

### Blinding

Done properly or not worth doing. Before judging, a transcript has the persona
name removed, model self-identification removed, and the **consent disclosure
dropped entirely** — only Lane A produces one, so leaving it in tells the judge
which lane it is reading before it reaches a single question. The candidate's
"yes, I can hear you" goes with it, being an answer to a question that is no
longer there.

The test suite asserts that a Lane A and a Lane B transcript with identical
content anonymise to byte-identical text.

## What it does not measure

Voice realism. The peers reach their models through text CLIs and cannot listen
to audio. `npm run sim:voice` measures latency, size, failure rate and an
order-of-magnitude cost, writes the clips side by side, and leaves the
perceptual judgement to a person. A fabricated realism score would look like
evidence while being nothing of the kind.

## Layout

| File | Role |
|---|---|
| `bands.ts` | Experience bands and scope inference. Shared vocabulary. |
| `peers.ts` | The three CLIs behind one interface. JSON extraction, retry, timeout. |
| `roleFactory.ts` | Generates job descriptions, by family and band. |
| `candidateFactory.ts` | Generates CVs and answering personas. |
| `session.ts` | Provisions a real interview session for generated fixtures. |
| `candidateAgent.ts` | The peer playing the candidate. Shared by both lanes. |
| `laneA.ts` | Questor's engine conducts the interview. |
| `laneB.ts` | A peer conducts the interview. |
| `judge.ts` | Blind scoring and anonymisation. |
| `run.ts` | Sweep orchestration and reporting. |
| `voiceAB.ts` | TTS connector comparison. |
| `smoke.ts` | One interview, end to end. |

Peer calls go through `execFile` with the prompt as a single argv entry and no
shell — the harness feeds these processes generated JDs and CVs, text full of
quotes, backticks and `$`, and a shell string would turn that content into
syntax. Claude is wrapped in `bash -c 'claude -p "$1"' -- <prompt>` because Node
will not spawn a Windows `.cmd` shim directly; the command string is fixed and
the prompt arrives as a positional parameter.
