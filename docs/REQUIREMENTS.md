# Requirement traceability (BRD §6 Functional Requirements)

Each functional requirement mapped to its implementation and, where applicable, its test.

| ID | Requirement (short) | Implementation | Test |
| --- | --- | --- | --- |
| FR-001 | Create role from JD/file/ATS/form | `routes/roles.ts` POST `/roles`; `providers/ats` | api.test |
| FR-002 | Extract title/level/skills/etc. with source + confidence | `engines/roleIntelligence.ts` `extractRole*` | engines.test |
| FR-003 | Competency model, no scoring until approved | `routes/roles.ts` approve gate; `interviews.ts` requires approved scorecard | api.test (rejects before approve) |
| FR-004 | Classify essential/preferred/trainable/non-scoring | `roleIntelligence.ts` `classify`, `normalizeWeights` | engines.test |
| FR-005 | Detect exclusionary JD language, suggest neutral | `roleIntelligence.ts` `EXCLUSIONARY_TERMS`; `/roles/:id/validate` | engines.test |
| FR-006 | Ingest PDF/DOCX/ATS payloads; clear error path | `engines/resumeParser.ts`; `candidates.ts` 422 handling | api.test |
| FR-007 | Normalize employment/education/projects/skills | `resumeParser.ts` `normalizeProfile` | engines.test |
| FR-008 | Map evidence to competencies (explicit/inferred/missing) | `engines/fitScoring.ts`; EvidenceNode/Edge | engines.test |
| FR-009 | Pre-interview fit score + confidence, not hidden binary | `fitScoring.ts` weighted components | engines.test |
| FR-010 | Flag claims to validate as neutral probes | `fitScoring.ts` `probes`, `missing` | engines.test |
| FR-011 | HR approval before invitation | `routes/interviews.ts` `approve` required; audit `interview.approved` | api.test |
| FR-012 | Branded invitation email/SMS; track delivery | `interviews.ts` `/invite`; `providers/email` | — |
| FR-013 | Candidate self-scheduling within slots/timezone | `interviews.ts` `/schedule`; portal | — |
| FR-014 | Reschedule/cancel/expiry/reminder/no-show | `interviews.ts` `/cancel`; state machine | — |
| FR-015 | AI disclosure + consent capture (version/timestamp/channel) | `routes/portal.ts` `/consent` | — |
| FR-016 | Versioned interview plan (coverage/time/intents/prohibited) | `engines/interviewPlanner.ts` | engines.test, api.test |
| FR-017 | Bidirectional live voice, sub-2s target | `web` InterviewRoom + Web Speech; `realtime/socket.ts` | e2e sim |
| FR-018 | Barge-in/repeat/clarify/pause/resume | InterviewRoom controls; runtime `clarify`/`repeat` | — |
| FR-019 | Intro/process/consent/audio check logged | portal tech-check; runtime `disclosure` block | — |
| FR-020 | Progress easy→role depth by evidence not demographics | `interviewDirector.ts` depth from `answerQuality` | engines.test |
| FR-021 | Adaptive STAR follow-ups tied to competency | `conversationRuntime.ts` `starFollowup` | e2e sim |
| FR-022 | Structured comparable coverage + omission report | `interviewPlanner.ts`, `interviewDirector.ts` coverageState | engines.test |
| FR-023 | Avoid prohibited questions/protected inference | `engines/policyEngine.ts` `screenQuestion` | engines.test |
| FR-024 | Detect unclear/generic/inconsistent; neutral clarify | runtime clarify; evaluator `detectContradictions` | — |
| FR-025 | Interviewer personas (style only, not scoring) | `personaJson`; runtime tone | — |
| FR-026 | Optional coding/case/presentation modules | `interviewPlanner.ts` `module` blocks | — |
| FR-027 | Close with candidate questions, no unapproved decision | runtime `close` utterance | e2e sim |
| FR-028 | Record per policy/consent; visible indicator; encrypted | portal consent; InterviewRoom recording badge; Artifact | — |
| FR-029 | Diarized timestamped transcript; jump to moment | `Turn` speaker/startMs; transcript artifact | e2e sim |
| FR-030 | Score competency w/ anchored levels + evidence sufficiency | `engines/evaluator.ts` | e2e sim |
| FR-031 | Separate communication from accent/fluency | Communication competency rubric; excluded signals | — |
| FR-032 | Strengths/concerns/open questions/contradictions/rec | `evaluator.ts` result fields | e2e sim |
| FR-033 | Human review, score & recommendation override + reason | `routes/assessments.ts` `/review`; HumanReview | api.test |
| FR-034 | Express uncertainty; Not-Enough-Evidence, no silent reduction | `evaluator.ts` NEE excluded from overall | e2e sim |
| FR-035 | Independent post-interview evaluator (separate from interviewer) | `evaluator.ts` (separate pass) | e2e sim |
| FR-036 | Recruiter dashboard, filter/export | `web` Dashboard/InterviewsList; `admin/analytics` | api.test |
| FR-037 | Report w/ scorecard, evidence, transcript, export | `reportWriter.ts`; `/assessments/:id/report` | — |
| FR-038 | Multi-tenant RBAC/SSO/audit/retention/policies | auth + tenant scoping; `AuditEvent`; `admin/policy` | api.test |
| FR-039 | APIs/webhooks w/ idempotency/auth/retry/signatures | `services/webhooks.ts` HMAC + backoff | — |
| FR-040 | ATS adapters (launch + generic REST/CSV) | `providers/ats`; `/assessments/:id/export` | — |
| FR-041 | Teams/Zoom/Meet adapters w/ capabilities + fallback | `providers/meeting` | api.test (providers) |
| FR-042 | Analytics: funnel/quality/overrides/latency/fairness | `routes/admin.ts` `/analytics` | api.test |
| FR-043 | Candidate portal: schedule/techcheck/consent/support | `routes/portal.ts`; `web` Portal | — |
| FR-044 | Configurable languages/voices/translated reports | plan `language`; speech provider languages | — |
| FR-045 | Model/prompt/rubric/policy/config version history | `ModelExecution`, versioned scorecards/plans/assessments | — |

**Legend:** _e2e sim_ = `npm run test:e2e -w server` (full interview simulation).
Items without an automated test are exercised through the running UI/API and are structurally in place.
