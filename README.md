# Questor — Autonomous AI First-Round Interview Agent

Questor conducts natural, structured, **voice-first first-round interviews**, adapts in real time,
collects evidence, and produces an honest, auditable assessment for **human review**. It is built
as an **evidence-led decision-support system** — it automates the interview operation but never
becomes an opaque, uncontrolled rejection machine (BRD §1).

> **Describe a role. Upload a resume. Approve the candidate. Questor runs the interview and returns
> a recruiter-ready, evidence-grounded assessment — a human makes the final call.**

This repository is a **complete, working open-source build**. It runs end-to-end with **zero paid
API keys** using a built-in heuristic reasoning engine and the browser's native Web Speech APIs.
Every paid component (LLM, STT, TTS, email, ATS, meeting platforms) has a **connector** you plug in
by setting an environment variable once you have a license — no code changes required.

---

## What's implemented

| BRD area | Status |
| --- | --- |
| Role intelligence — JD → Role Success Profile, competency model, weights, approval gate (FR-001–005) | ✅ |
| Resume ingestion (PDF/DOCX/text), normalization, evidence mapping, transparent fit score (FR-006–010) | ✅ |
| HR approval workflow + versioned interview plan (FR-011, FR-016) | ✅ |
| Invitations, scheduling, consent, candidate portal (FR-012–015, FR-043) | ✅ |
| **Live voice interview** — hosted browser room, barge-in, repeat, adaptive STAR follow-ups (FR-017–027) | ✅ |
| Diarized, timestamped transcript + evidence spans (FR-028–029) | ✅ |
| Independent evaluator — anchored rubric scoring, Not-Enough-Evidence, recommendation (FR-030–035) | ✅ |
| Recruiter console, report, PDF/Markdown export, human override (FR-032–037) | ✅ |
| Multi-tenant auth/RBAC, audit log, model-execution traceability (FR-038, FR-045) | ✅ |
| Public API + signed webhooks, ATS + meeting-adapter connectors (FR-039–041) | ✅ |
| Analytics funnel/quality; policy & prompt-injection guardrails (FR-042, §16.5) | ✅ |
| Interview session state machine (§14.3) | ✅ |

See [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) for the full requirement-to-code traceability map,
and [`docs/BUILD_STATUS.md`](docs/BUILD_STATUS.md) for an honest gap analysis (what's working vs.
simplified vs. still-to-build) and the recommended next-build roadmap.

---

## Quick start

```bash
# 1. Install everything (Node 20+)
npm install

# 2. Create the database, generate the client, load demo data
cp .env.example server/.env
npm run setup          # prisma db push + generate + seed

# 3. Run the app (server on :4000, web on :5173)
npm run dev
```

Open **http://localhost:5173** and sign in with the seeded recruiter:

```
Email:    demo@questor.local
Password: questor123
```

You'll find a ready-made **Senior Data Engineer** role (approved) and candidate **Priya Sharma**
(resume parsed, fit scored) with an interview already set up. Open the interview, **Send invitation**,
copy the portal link, and click **Open interview room** to conduct a live voice interview.

### Prove it works headlessly (no browser, no keys)

```bash
npm run test:e2e -w server
```

This runs a **complete simulated interview** — role → plan → live conversation (Interview Director +
Conversation Runtime) → independent evaluation → report — and asserts every score is grounded in
transcript evidence.

### Tests

```bash
npm test               # 31 unit + API integration tests (Vitest + Supertest)
```

---

## Architecture (BRD §14)

```
web/  React + Vite               server/  Node + Express + Prisma
 ├─ Recruiter console             ├─ routes/      REST API (auth, roles, candidates,
 ├─ Candidate portal              │               interviews, portal, assessments, admin)
 ├─ Hosted interview room  ◄────► ├─ realtime/    Socket.IO room + interview engine
 │   (Web Speech STT/TTS)         ├─ engines/     role intel, resume, fit, director,
 └─ Admin & connectors            │               conversation runtime, evaluator, policy
                                  ├─ providers/   llm · stt · tts · email · ats · meeting
                                  └─ prisma/      SQLite (default) / Postgres (connector)
```

The **Interview Director** owns time, coverage and depth; the **Conversation Runtime** turns its
signals into natural utterances; the **independent Evaluator** scores from transcript + rubric only.
Business logic and evidence records are kept independent of any voice/LLM/ATS vendor (BRD principle:
_vendor portability_).

Full detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Plugging in paid components

Everything below is optional. Set the variable in `server/.env` and restart — Questor detects the key
and routes to the connector, otherwise it uses the open-source default. See
[`docs/CONNECTORS.md`](docs/CONNECTORS.md).

| Component | Open-source default | Paid connectors (set a key to enable) |
| --- | --- | --- |
| LLM reasoning | Built-in heuristic engine | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` |
| Speech-to-text | Browser `SpeechRecognition` | Deepgram, Whisper, Azure Speech |
| Text-to-speech | Browser `speechSynthesis` | ElevenLabs, OpenAI, Azure |
| Email / comms | Console logger | SendGrid, SMTP |
| ATS | Generic REST/CSV | Greenhouse (+ generic) |
| Meeting | Hosted browser room | Teams, Zoom, Google Meet adapters |
| Database | SQLite | PostgreSQL |

---

## Responsible-AI guardrails (BRD §16–17)

- **No protected-trait inference.** The policy engine blocks/rewrites prohibited questions and strips
  non-job-related language from outputs. Fit scoring deliberately ignores age, caste, religion,
  nationality, marital status, appearance and accent.
- **Evidence over impression.** Every material score cites transcript spans; low-evidence dimensions
  are marked _Not Enough Evidence_ instead of being guessed.
- **Human accountability.** Questor emits Proceed / Consider / Do-Not-Progress with confidence; HR
  records the final disposition with a mandatory reason. Originals are retained in audit history.
- **Prompt-injection defense.** Candidate instructions ("ignore your rubric…") are detected and never
  obeyed; the rubric is never revealed in-session.
- **Auditable by default.** Role/plan/model/prompt/rubric versions and every reviewer override are
  persisted so any assessment can be reconstructed.

---

## License

Apache-2.0. This is a reference implementation of the Questor BRD; revalidate vendor docs, pricing,
licensing and legal/compliance requirements before any production release (BRD §25.5).
