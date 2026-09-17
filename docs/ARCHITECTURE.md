# Questor architecture

Questor is a modular monolith: one web client and one server application. The server process owns the API, live interview sockets, provider adapters, and background jobs.

## Runtime components

```mermaid
flowchart LR
  Browser[Recruiter and candidate browsers] --> Nginx[nginx / static web]
  Browser --> API[Node process: Express API]
  Browser <--> Socket[Socket.IO interview room]
  API --- Socket
  API --> Prisma[Prisma client]
  Socket --> Prisma
  Jobs[Leased background jobs] --> Prisma
  API --> Providers[LLM / STT / TTS / email / ATS / meeting adapters]
  Jobs --> Webhooks[Webhook receivers]
  Prisma --> DB[(Postgres in production)]
  Local[(SQLite locally)] -. dev .- Prisma
```

Production uses PostgreSQL. Local development defaults to SQLite. The Postgres Prisma schema is generated from the SQLite source schema before Postgres client generation.

## Server shape

- Express REST API: `server/src/routes/*`.
- Socket.IO live interview runtime: `server/src/realtime/*`.
- Interview, evaluation, policy, role, and resume logic: `server/src/engines/*` and `server/src/domain/*`.
- Provider adapters: `server/src/providers/*`.
- Background jobs: `server/src/services/*`, started from `server/src/index.ts`.

`server/src/index.ts` runs preflight, starts retention, incomplete-interview, webhook delivery, and invitation-secret backfill work, creates the Express app, attaches Socket.IO, and listens. Jobs use database leases in `services/jobs.ts` and record `JobRun` rows for `/api/admin/ops`.

## Provider adapters

The zero-key path uses the heuristic LLM, browser speech, hosted interview rooms, generic connectors, and console email. Paid or external adapters are selected by environment. Variable names include `LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `STT_PROVIDER`, `DEEPGRAM_API_KEY`, `AZURE_SPEECH_KEY`, `TTS_PROVIDER`, `ELEVENLABS_API_KEY`, `EMAIL_PROVIDER`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SENDGRID_API_KEY`, `ATS_PROVIDER`, `ATS_BASE_URL`, `ATS_API_KEY`, and `MEETING_PROVIDER`.

## Multi-tenancy and authorization

Most business rows carry `tenantId`. Capabilities live in `server/src/domain/capabilities.ts`; object-level checks live in `server/src/services/access.ts`. Access decisions combine tenant, capability, and object scope. Role ownership and candidate ownership are separate because a recruiter can share a role without seeing every candidate under it.

## Interview state machine

The state machine is in `server/src/domain/stateMachine.ts`.

Main states: `PROVISIONED`, `INVITED`, `ACCEPTED`, `READY_CHECK`, `WAITING`, `CONNECTING`, `DISCLOSURE`, `CONSENTED`, `WARMUP`, `ASSESSING`, `CANDIDATE_QUESTIONS`, `CLOSING`, `PROCESSING`, `REVIEW_READY`, `HUMAN_REVIEWED`, `CLOSED`.

Exception states: `RESCHEDULE_REQUIRED`, `NO_SHOW`, `CANDIDATE_WITHDREW`, `TECHNICAL_FAILURE`, `POLICY_STOP`, `MANUAL_HANDOFF`, `CANCELLED`, `INCOMPLETE`.

```mermaid
stateDiagram-v2
  [*] --> PROVISIONED
  PROVISIONED --> INVITED
  INVITED --> ACCEPTED
  ACCEPTED --> READY_CHECK
  READY_CHECK --> WAITING
  WAITING --> CONNECTING
  CONNECTING --> DISCLOSURE
  DISCLOSURE --> CONSENTED
  CONSENTED --> WARMUP
  WARMUP --> ASSESSING
  ASSESSING --> CANDIDATE_QUESTIONS
  ASSESSING --> CLOSING
  CANDIDATE_QUESTIONS --> CLOSING
  CLOSING --> PROCESSING
  PROCESSING --> REVIEW_READY
  REVIEW_READY --> HUMAN_REVIEWED
  HUMAN_REVIEWED --> CLOSED
  INVITED --> NO_SHOW
  ACCEPTED --> RESCHEDULE_REQUIRED
  READY_CHECK --> TECHNICAL_FAILURE
  DISCLOSURE --> CANDIDATE_WITHDREW
  ASSESSING --> POLICY_STOP
  ASSESSING --> MANUAL_HANDOFF
  ASSESSING --> INCOMPLETE
  TECHNICAL_FAILURE --> RESCHEDULE_REQUIRED
  RESCHEDULE_REQUIRED --> INVITED
  POLICY_STOP --> MANUAL_HANDOFF
  NO_SHOW --> CLOSED
  CANDIDATE_WITHDREW --> CLOSED
  INCOMPLETE --> RESCHEDULE_REQUIRED
  CANCELLED --> [*]
  CLOSED --> [*]
```

## Consent, retention, erasure, legal hold

Consent is captured on sessions and controls observation/transcript behavior. Retention is session-centered in `services/dataRights.ts` because turns, assessments, artifacts, reviews, feedback, and model executions all belong to the recruitment purpose. Erasure deletes candidate-derived data in dependency order and keeps a non-personal audit record. Legal hold on a session or artifact blocks retention purge and explicit erasure.

## Trust boundaries and tokens

- Browser to API: cookie auth, CSRF protection, rate limits.
- Candidate portal: invitation token in URL; limiter keys on token where possible.
- API to providers: candidate data may leave the deployment when remote providers are configured.
- API to webhook receivers: signed outbound requests, public URL checks, durable retries.
- Operator shell to database: backups and drills contain candidate personal data.

Invitation tokens are hashed for lookup and sealed for display/resend in `services/invitations.ts`. The seal key is derived from `AUTH_SECRET`, so rotation makes stored sealed links unopenable. Signup-decision and feedback/human-request tokens are hash-only. Webhooks always carry the timestamped v2 signature. The original v1 header goes only to webhooks with `sendLegacySignature` on (new webhooks default off; rows that predate the column were backfilled on) and to none while `WEBHOOK_V1_SIGNATURE=off`.

## Web client

The React/Vite client lives under `web/src`:

- `pages/*` for route pages.
- `components/*` for shared UI and pure model helpers.
- `api/*` for API client and response modeling.
- Pure model modules include score/status/tour/dashboard/journey/pipeline helpers and are testable without a browser.

The interview room uses browser speech in the zero-key path and the server for session state and turns.

## Test strategy

Server tests run on SQLite per worker. Web model tests cover pure client behavior. Simulation scripts exercise interview flows without a browser or paid keys. The e2e suite belongs under `e2e/`; `docs/PENDING.md` says browser smoke coverage is still pending. Deploy health checks are not a replacement for migrations or e2e tests.

## Why not microservices now

Interviews, consent, retention, erasure, audit, and evidence need strong consistency. Splitting now would add distributed transactions, event replay, and cross-service authorization before independent scaling is needed. One process also keeps local setup simple.

## Seams if it ever splits

Likely split points are webhook delivery, retention/erasure, a provider gateway, the realtime interview service, and reporting read models. Before splitting, move rate limiting out of process and replace `prisma db push` with migrations.

## Could not confirm from the repo

- Exact production nginx configuration and backup log paths.
- Actual nightly dump format on the VPS; confirm with `pg_restore --list`.
