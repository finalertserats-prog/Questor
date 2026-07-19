# Questor — Build Status & Next-Session Roadmap

_Snapshot date: 19 July 2026 · Baseline commit: initial Questor build (PR #1)_

This document is an honest gap analysis of the current build against the BRD. Use it to plan the
next build session. Legend: ✅ working · 🟡 simplified (works, not production-grade) · 🔌 connector
seam (coded, not licensed/integrated) · ❌ not built.

---

## ✅ Built and working (verified end-to-end)

Verified via 31 unit/API tests, a headless interview E2E, and a full real-browser run
(login → live interview → assessment → human review).

| Area | BRD refs | State |
| --- | --- | --- |
| Role intelligence: JD → Role Success Profile, competency model, weights, **approval gate** | FR-001–005, §7 | ✅ heuristic + optional LLM |
| Resume ingest (PDF/DOCX/text), normalization, evidence mapping, **transparent fit score** | FR-006–010, §7.2 | ✅ |
| Interview plan (versioned, time-boxed coverage); HR approval before invite | FR-011, FR-016 | ✅ |
| **Live voice interview** — hosted browser room, adaptive STAR follow-ups, barge-in/repeat, text fallback | FR-017–027 | ✅ browser Web Speech |
| Interview Director (time/coverage/depth) + Conversation Runtime + session state machine | §14.2–14.3, §16.2 | ✅ |
| Diarized, timestamped transcript + evidence spans | FR-028–029 | ✅ |
| **Independent evaluator** — rubric scoring, Not-Enough-Evidence, recommendation, confidence | FR-030–035 | ✅ |
| Recruiter console, candidate portal (consent/tech-check), assessment view + **human override** | FR-032–037, FR-043 | ✅ |
| Multi-tenant auth/RBAC, audit log, model-execution traceability, signed webhooks, analytics funnel | FR-038–039, FR-042, FR-045 | ✅ |
| Policy/guardrails: prohibited-question blocking, protected-trait exclusion, prompt-injection defense | FR-023, §16.5 | ✅ |

This is a genuine, demoable product ≈ the BRD's "Lean validation MVP" shape, minus production hardening.

---

## 🟡 Simplified — works, but not production-grade yet

- **Reasoning quality.** Default engine is heuristic (deterministic rules) → runs with zero keys but
  is **not the conversational depth or scoring validity of a real LLM**. Plugging in Anthropic/OpenAI
  (connector exists) is step one; then real prompt engineering + rubric tuning.
- **Voice.** Browser Web Speech is turn-based, not true full-duplex low-latency streaming. BRD's
  **≤1.5s p95 + natural barge-in** needs a managed realtime voice stack.
- **Report export.** Markdown + JSON only. **PDF / ATS-formatted export not built.**
- **Recording.** Consent + on-screen indicator exist, but **audio is not actually captured, encrypted,
  or stored** — transcript is the artifact today.
- **Artifacts/storage.** Stored as text in the DB, not S3-compatible encrypted object storage with
  lifecycle/legal-hold.

---

## 🔌 Connectors present, not yet integrated/licensed

Seams exist and are declared, but none are wired to a live third-party service:

- STT (Deepgram / Whisper / Azure), TTS (ElevenLabs / OpenAI / Azure)
- **Meeting adapters** (Teams / Zoom / Meet) — capability-declared only; live media/bot-join not implemented (FR-041)
- Email / SMS / WhatsApp (console default; SendGrid/SMTP coded, others not) (FR-012)
- ATS (generic REST + Greenhouse stub; no live sync tested) (FR-040)

---

## ❌ Not built — real gaps for enterprise/production

### Engineering
- SSO / OIDC / SAML + SCIM provisioning (only email + JWT today) — FR-038, §14.2
- Encryption at rest, KMS/secrets manager, WAF, rate-limiting middleware, DLP/SIEM — §17, §19.1
- Durable workflow engine (Temporal), event bus (Kafka), Redis, object storage, prod Postgres,
  **Kubernetes / multi-region**, OpenTelemetry observability — §19.1
- Coding / work-sample / case modules — planner slots them; **no actual coding environment** — FR-026
- Real scheduling (calendar conflict/timezone logic is minimal), reminders, no-show automation — FR-013–014
- Multilingual models + localized voices + translated reports (language field only) — FR-044
- **Fairness / adverse-impact monitoring** (currently stubbed: "not computed") — FR-042, §16

### Non-engineering (BRD launch gates §3.3 — programs, not code)
- Scoring-validity study (**≥0.75 human agreement**), calibration dataset, red-team safety suite
- Independent **penetration test**, security certification, privacy/legal review (DPDP / EEOC / EU AI Act / Illinois AIVIA)
- Human-panel evidence-grounding audit (≥95%), conversation-quality rating (≥4.2/5 median)

---

## Recommended next build order

1. **Wire a real LLM** (Anthropic) + prompt/rubric tuning → immediate jump in interview & scoring
   quality. _Already seamed: set `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`; then harden the
   prompts in `engines/roleIntelligence.ts`, `conversationRuntime.ts`, `evaluator.ts`._
2. **Managed realtime voice** (streaming STT + TTS) → hit the latency/naturalness bar.
3. **Recording capture + encrypted object storage + PDF export** → complete the evidence/artifact story.
4. **SSO + encryption-at-rest + rate limiting + Postgres** → enterprise security baseline.
5. **One live ATS + one meeting adapter** (pick the design partner's stack).
6. **Fairness monitoring + validation study + pen test** → clear the BRD launch gates.

---

## How to resume quickly next session

```bash
npm install && cp .env.example server/.env && npm run setup && npm run dev
# Recruiter: http://localhost:5173  ·  demo@questor.local / questor123
npm test -w server            # 31 unit + API tests
npm run test:e2e -w server    # full headless interview + assessment
```

Key code seams for the next steps:
- LLM: `server/src/providers/llm/` (+ `generateJson` used by engines)
- Voice: `web/src/speech.ts`, `server/src/providers/speech.ts`, `server/src/realtime/`
- Connectors: `server/src/providers/{email,ats,meeting}/`
- Requirement traceability: `docs/REQUIREMENTS.md`
