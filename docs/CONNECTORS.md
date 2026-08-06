# Connectors — plugging in paid components

Questor runs fully on open-source defaults. Each paid component is behind a provider abstraction with
a connector you enable by setting environment variables in `server/.env` and restarting the server.
No code changes are needed. Check current wiring at any time in **Admin → Connectors**
(`GET /api/admin/providers`).

---

## LLM reasoning (interviewer, evaluator, report writer)

Default `LLM_PROVIDER=heuristic` — a deterministic engine that needs no key and powers the entire
interview and scoring loop offline. When a remote model is configured, engines call it for richer
question phrasing / rationale and **fall back to the heuristic on any error** (so it never breaks).

```env
# Anthropic
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-5

# or OpenAI
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
```

Implementation: `server/src/providers/llm/` (`anthropic.ts`, `openai.ts`, `heuristic.ts`). Every call
is logged to the `ModelExecution` table for traceability (BRD FR-045).

---

## Speech-to-text (candidate voice)

Default `STT_PROVIDER=webspeech` — the browser's `SpeechRecognition`, zero-key, streaming.

```env
STT_PROVIDER=deepgram      # DEEPGRAM_API_KEY=...
STT_PROVIDER=whisper       # uses OPENAI_API_KEY
STT_PROVIDER=azure         # AZURE_SPEECH_KEY=..., AZURE_SPEECH_REGION=...
```

The server advertises the active capability to the client (`sttCapability()` in
`server/src/providers/speech.ts`); the interview room switches transport accordingly.

## Text-to-speech (interviewer voice)

Default `TTS_PROVIDER=webspeech` — the browser's `speechSynthesis`.

```env
TTS_PROVIDER=elevenlabs    # ELEVENLABS_API_KEY=..., ELEVENLABS_VOICE_ID=...
TTS_PROVIDER=openai        # uses OPENAI_API_KEY
TTS_PROVIDER=azure         # AZURE_SPEECH_KEY=...
```

A server-side ElevenLabs synth is included (`synthesizeElevenLabs`) as a worked example.

---

## Email / communications (invitations, reminders)

Default `EMAIL_PROVIDER=console` — logs the invitation to the server console (great for local dev).

```env
EMAIL_PROVIDER=sendgrid    # SENDGRID_API_KEY=...
EMAIL_PROVIDER=smtp        # SMTP_HOST/PORT/USER/PASS
EMAIL_FROM="Questor Interviews <no-reply@yourco.com>"
```

Implementation: `server/src/providers/email/`.

---

## ATS

Default `ATS_PROVIDER=generic` — a generic REST connector (set `ATS_BASE_URL`, `ATS_API_KEY`). Fetch a
requisition to create a role, and push assessments back.

```env
ATS_PROVIDER=greenhouse
ATS_BASE_URL=https://harvest.greenhouse.io/v1
ATS_API_KEY=...
```

Implementation: `server/src/providers/ats/`.

---

## Meeting platforms

Default `MEETING_PROVIDER=hosted` — the fully-implemented Questor browser room. Teams / Zoom / Meet
adapters publish their capabilities and graceful-fallback behavior and are wired as connector seams
(`server/src/providers/meeting/`). Each references the official SDK docs (BRD §13, §25.5). When SDK
credentials are added, the adapter creates/joins the meeting and streams media; on missing
credentials it falls back to the hosted room.

```env
MEETING_PROVIDER=teams     # Microsoft Graph + real-time media
MEETING_PROVIDER=zoom      # Meeting SDK + RTMS
MEETING_PROVIDER=meet      # Google Meet API (post-conference artifacts)
```

---

## Database — PostgreSQL

Default is SQLite (`DATABASE_URL="file:./data/questor.db"`). To use Postgres:

1. Edit `server/prisma/schema.prisma` → `datasource db { provider = "postgresql" }`.
2. Set `DATABASE_URL="postgresql://user:pass@host:5432/questor?schema=public"`.
3. `npm run db:generate -w server && npm run db:push -w server && npm run db:seed -w server`.

A ready `docker-compose.yml` provides a local Postgres + the app.

---

## Outbound webhooks (BRD FR-039)

Register endpoints in **Admin → Webhooks** (or `POST /api/admin/webhooks`). Questor emits
`candidate.parsed`, `invitation.sent`, `invitation.accepted`, `interview.started`,
`assessment.ready`, `review.completed`. Each delivery is signed with HMAC-SHA256 in the
`x-questor-signature` header (verify with `WEBHOOK_SIGNING_SECRET`) and retried with exponential
backoff.
