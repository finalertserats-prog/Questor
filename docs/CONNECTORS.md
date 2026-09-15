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

Default `MEETING_PROVIDER=hosted` — the fully-implemented Questor browser room. It needs **no vendor
account and no credentials**; it only needs a reachable database and `WEB_ORIGIN` set to the public
https address (browsers block camera/microphone on plain http).

Teams / Zoom / Meet adapters publish their capabilities and graceful-fallback behavior and are wired
as connector seams (`server/src/providers/meeting/`). **Current status:** their credentials can be set
and verified, but meeting creation / media through them is not built yet — interviews use the
hosted room regardless of which adapter is configured.

### Setting up and testing an adapter

**Admin → Connectors → Meeting adapters** shows, per adapter:

- **Status** — *Not configured* / *Configured*, computed from which variable **names** are set.
  Values never leave the server; `GET /api/admin/providers` returns `env: [{ name, present }]` only.
- **How to set up** — what to create at the vendor, the exact variables, required
  scopes/permissions, redirect/webhook URLs (none for these app-only flows), and the vendor docs.
  The same text lives in `web/src/components/connectorGuides.ts`.
- **Test connection** — `POST /api/admin/connectors/meeting/:adapterId/test`. Requires
  `admin:manage`, rate limited to 10 tests per user per 10 minutes, and audited as
  `connector.tested` with the adapter id and outcome (`ok` / `failed` / `not_configured`) only.
  Returns `{ ok, message }`; unknown adapter → 404; missing variables → 409 naming them. The test
  makes the lightest authenticated call (obtaining an OAuth token, 8 s timeout). No meeting is
  created, and neither tokens nor vendor response bodies are returned or logged.

| Adapter | Create at the vendor | Variables (`server/.env`) | Test performs |
|---|---|---|---|
| `hosted` | nothing | none | database `SELECT 1`; `WEB_ORIGIN` valid (https in production) |
| `zoom` | Zoom Marketplace **Server-to-Server OAuth** app, activated | `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` | `POST https://zoom.us/oauth/token` (`account_credentials`) |
| `teams` | Microsoft Entra **app registration** + client secret; Graph application permissions `OnlineMeetings.ReadWrite.All`, `Calls.JoinGroupCall.All`, `Calls.AccessMedia.All` with admin consent; Teams application access policy | `MS_GRAPH_TENANT_ID`, `MS_GRAPH_CLIENT_ID`, `MS_GRAPH_CLIENT_SECRET` | client-credentials token from `login.microsoftonline.com/<tenant>/oauth2/v2.0/token` |
| `meet` | Google Cloud project with Meet REST API enabled, **service account** + JSON key, Workspace **domain-wide delegation** for `https://www.googleapis.com/auth/meetings.space.created` | `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `GOOGLE_IMPERSONATED_USER` | signed JWT exchanged at `https://oauth2.googleapis.com/token` |

```env
MEETING_PROVIDER=hosted    # or teams | zoom | meet

ZOOM_ACCOUNT_ID=<Account ID>
ZOOM_CLIENT_ID=<Client ID>
ZOOM_CLIENT_SECRET=<Client Secret>

MS_GRAPH_TENANT_ID=<Directory (tenant) ID>
MS_GRAPH_CLIENT_ID=<Application (client) ID>
MS_GRAPH_CLIENT_SECRET=<client secret Value>

GOOGLE_SERVICE_ACCOUNT_EMAIL=<client_email from the JSON key>
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="<private_key from the JSON key, keeping its \n sequences>"
GOOGLE_IMPERSONATED_USER=<Workspace user meetings are created as>
```

**Why credentials stay in `server/.env` (not a settings screen):** connectors are deployment-wide
(one server, one Zoom app), not per-tenant settings, and keeping keys out of the database means a
database backup, export or injection bug cannot hand out vendor access. There is intentionally no
API that accepts or stores a key. Edit `server/.env`, restart the server, then use *Test connection*.

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
