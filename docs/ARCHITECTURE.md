# Questor Architecture

Maps to BRD §14 (Technical Architecture), §15 (Data Model), §16 (AI/ML).

## Layers

- **Experience layer** (`web/`): recruiter console, candidate portal, hosted interview room, admin.
- **Domain services** (`server/src/routes`, `services`): roles, candidates, scheduling/comms,
  interview orchestration, assessment, integration hub.
- **AI/media layer** (`server/src/engines`, `realtime`): media/turn handling, conversation runtime,
  Interview Director, evidence extractor, independent evaluator, policy engine.
- **Platform layer**: Express API gateway, JWT/RBAC identity, event/webhook bus, Prisma + SQLite/PG,
  artifact storage (DB-backed for MVP), model-execution telemetry.

## Core services → code

| BRD service | Location |
| --- | --- |
| API Gateway / BFF | `server/src/app.ts`, `middleware/` |
| Identity & Tenant | `services/auth.ts`, `routes/auth.ts`, JWT claims `{userId, tenantId, role}` |
| Role Intelligence | `engines/roleIntelligence.ts` |
| Candidate Profile | `engines/resumeParser.ts`, `engines/fitScoring.ts`, `engines/evidenceExtractor.ts` |
| Scheduling & Comms | `routes/interviews.ts`, `providers/email/` |
| Interview Orchestrator | `realtime/interviewEngine.ts`, `domain/stateMachine.ts` |
| Realtime Media | `realtime/socket.ts`, `web` Web Speech, `providers/speech.ts` |
| Conversation Runtime | `engines/conversationRuntime.ts`, `engines/interviewDirector.ts` |
| Policy & Guardrail | `engines/policyEngine.ts` |
| Assessment | `engines/evaluator.ts`, `engines/reportWriter.ts` |
| Artifact | `Artifact` table (resume, transcript, report) |
| Integration Hub | `providers/ats/`, `providers/meeting/`, `services/webhooks.ts` |
| Analytics/Governance | `routes/admin.ts`, `AuditEvent`, `ModelExecution` |

## Interview session state machine (§14.3)

`PROVISIONED → INVITED → ACCEPTED → READY_CHECK → WAITING → CONNECTING → DISCLOSURE → CONSENTED →
WARMUP → ASSESSING → CANDIDATE_QUESTIONS → CLOSING → PROCESSING → REVIEW_READY → HUMAN_REVIEWED →
CLOSED`, with exception states `RESCHEDULE_REQUIRED, NO_SHOW, CANDIDATE_WITHDREW, TECHNICAL_FAILURE,
POLICY_STOP, MANUAL_HANDOFF, CANCELLED`. Transitions are validated in `domain/stateMachine.ts`.

## The live interview loop

```
                 ┌────────────────────────────────────────────────┐
 candidate turn  │  submitCandidateTurn(text)                     │
 (voice/text) ─► │    1. persist Turn (diarized, timestamped)     │
                 │    2. Interview Director  → DirectorSignal      │  time / coverage / depth
                 │    3. Conversation Runtime → utterance          │  question bank + STAR follow-ups
                 │    4. Policy screen (block/rewrite)             │  + LLM augmentation (optional)
                 │    5. persist agent Turn, return it            │
                 └────────────────────────────────────────────────┘
 on close ─► finalizeInterview() ─► independent Evaluator ─► AssessmentVersion + report artifact
                                                             ─► webhook assessment.ready
```

The Director never speaks; the Runtime never scores; the Evaluator sees only transcript + rubric
(never name/appearance/accent). Checkpoints are persisted every turn so reconnects never duplicate
questions (BRD §14.4 resilience).

## Data model (§15.1)

`Tenant, User, Role, RoleScorecardVersion, Candidate, CandidateProfileVersion, EvidenceNode,
EvidenceEdge, InterviewPlanVersion, Invitation, InterviewSession, Turn, AssessmentVersion,
HumanReview, Artifact, AuditEvent, ModelExecution, WebhookEndpoint, WebhookDelivery`. Complex
sub-objects are stored as JSON strings for portability between SQLite and Postgres. Full schema:
`server/prisma/schema.prisma`.

## AI/ML responsibilities (§16.1) — enforced boundaries

| Function | Allowed | Not allowed | Where |
| --- | --- | --- | --- |
| Role parser | propose competencies | approve hiring criteria | `roleIntelligence.ts` (+ human approval gate) |
| Resume assessor | map evidence & uncertainty | infer protected traits / auto-reject | `fitScoring.ts` (excluded signals list) |
| Live interviewer | ask approved questions, capture evidence | finalize decisions, invent facts | `conversationRuntime.ts` |
| Interview Director | control time/coverage/policy | speak / change rubric | `interviewDirector.ts` |
| Evidence extractor | link claims to transcript spans | interpret emotion/appearance | `evidenceExtractor.ts` |
| Independent evaluator | score against rubric | use name/appearance/accent | `evaluator.ts` |
| Report writer | summarize structured facts | unsupported narrative | `reportWriter.ts` |
