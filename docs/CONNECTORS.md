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

The AI interview always runs in the hosted room. Teams / Zoom / Meet create the **meeting links for
human interview rounds** (see [Meeting links for human rounds](#meeting-links-for-human-rounds));
live media and bot join through them are not built.

### Setting up and testing an adapter

**Admin → Connectors → Meeting adapters** shows, per adapter:

- **Status** — *Not configured* / *Configured*, computed from which variable **names** are set.
  Values never leave the server; `GET /api/admin/providers` returns `env: [{ name, present }]` only.
- **How to set up** — what to create at the vendor, the exact variables, required
  scopes/permissions, redirect/webhook URLs (none for these app-only flows), and the vendor docs.
  The same text lives in `web/src/components/connectorGuides.ts`.
- **Test connection** — `POST /api/admin/connectors/meeting/:adapterId/test`. Requires
  `admin:manage`, rate limited to 10 tests per user and 30 per adapter across the whole deployment.
  The per-adapter limit is deployment-wide on purpose — the vendor app is shared by every organisation —
  so heavy testing by one organisation's admin can make another's wait out the window
  per 10 minutes, and audited as `connector.tested` with the adapter id and outcome
  (`ok` / `failed` / `not_configured`) only. The same event is also written to the server log with
  tenant and user ids, because credentials are shared by every tenant and each tenant's audit trail
  only shows its own tests. Which variables are set (`env`) is only returned to admins.
  Returns `{ ok, message }`; unknown adapter → 404; missing variables → 409 naming them. The test
  makes the lightest authenticated call (obtaining an OAuth token, 8 s timeout). No meeting is
  created, and neither tokens nor vendor response bodies are returned or logged.

| Adapter | Create at the vendor | Variables (`server/.env`) | Test performs |
|---|---|---|---|
| `hosted` | nothing | none | database `SELECT 1`; `WEB_ORIGIN` valid (https in production) |
| `zoom` | Zoom Marketplace **Server-to-Server OAuth** app, activated, scopes `meeting:write:meeting:admin`, `meeting:update:meeting:admin`, `meeting:delete:meeting:admin` | `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` (+ `ZOOM_HOST_USER_ID` to create meetings) | `POST https://zoom.us/oauth/token` (`account_credentials`) |
| `teams` | Microsoft Entra **app registration** + client secret; Graph application permission `Calendars.ReadWrite` with admin consent | `MS_GRAPH_TENANT_ID`, `MS_GRAPH_CLIENT_ID`, `MS_GRAPH_CLIENT_SECRET` (+ `MS_GRAPH_ORGANIZER_USER_ID` to create meetings) | client-credentials token from `login.microsoftonline.com/<tenant>/oauth2/v2.0/token` |
| `meet` | Google Cloud project with the **Calendar API** enabled, **service account** + JSON key, Workspace **domain-wide delegation** for `https://www.googleapis.com/auth/calendar.events` | `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, `GOOGLE_IMPERSONATED_USER` | signed JWT exchanged at `https://oauth2.googleapis.com/token` |

```env
MEETING_PROVIDER=hosted    # the AI interview room
ROUND_MEETING_PROVIDER=manual    # or teams | zoom | meet — links for human rounds

ZOOM_ACCOUNT_ID=<Account ID>
ZOOM_CLIENT_ID=<Client ID>
ZOOM_CLIENT_SECRET=<Client Secret>
ZOOM_HOST_USER_ID=<email or user id of the Zoom host>

MS_GRAPH_TENANT_ID=<Directory (tenant) ID>
MS_GRAPH_CLIENT_ID=<Application (client) ID>
MS_GRAPH_CLIENT_SECRET=<client secret Value>
MS_GRAPH_ORGANIZER_USER_ID=<object id or email of the organiser mailbox>

GOOGLE_SERVICE_ACCOUNT_EMAIL=<client_email from the JSON key>
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="<private_key from the JSON key, keeping its \n sequences>"
GOOGLE_IMPERSONATED_USER=<Workspace user meetings are created as>
```

**Why credentials stay in `server/.env` (not a settings screen):** connectors are deployment-wide
(one server, one Zoom app), not per-tenant settings, and keeping keys out of the database means a
database backup, export or injection bug cannot hand out vendor access. There is intentionally no
API that accepts or stores a key. Edit `server/.env`, restart the server, then use *Test connection*.

### Meeting links for human rounds

When a recruiter schedules a **human** interview round (`POST /api/pipelines/:id/rounds`), Questor
creates the meeting with the selected provider and stores its join link on the round.

- **Selection.** `ROUND_MEETING_PROVIDER` (`manual` | `teams` | `zoom` | `meet`, default `manual`) is the
  deployment default. An organisation admin can override it in **Admin → Connectors → Meeting links for
  human rounds** (tenant policy key `roundMeetingProvider`). Credentials are always the server's.
- **What each provider does.**
  - `zoom` — `POST https://api.zoom.us/v2/users/{ZOOM_HOST_USER_ID}/meetings` (scheduled meeting,
    waiting room on); reschedule `PATCH /v2/meetings/{id}`; cancel `DELETE /v2/meetings/{id}`.
  - `teams` — `POST https://graph.microsoft.com/v1.0/users/{MS_GRAPH_ORGANIZER_USER_ID}/events` with
    `isOnlineMeeting: true`, `onlineMeetingProvider: "teamsForBusiness"`; join URL from
    `onlineMeeting.joinUrl`; reschedule `PATCH …/events/{id}`; cancel `DELETE …/events/{id}` (the event
    has no attendees, so there are no invitations to withdraw).
  - `meet` — `POST https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1`
    with `conferenceData.createRequest` (`hangoutsMeet`), as `GOOGLE_IMPERSONATED_USER`; reschedule
    `PATCH …/events/{id}`; cancel `DELETE …/events/{id}`. The service-account JWT is signed with
    `node:crypto`; no Google SDK is used.
  - `manual` — nothing is created; the recruiter pastes an https link when scheduling or later.
- **No candidate data goes to the vendor.** The meeting title is "<stage> interview (Questor)", the
  description links to the candidate page by id, and no attendees are added. The recruiter shares the
  join link.
- **The booking is never lost.** The round is saved before any vendor call. If creation fails, the round
  stays scheduled with meeting status `NEEDS_LINK` and a plain message; the UI offers **Try again** and
  **Add link manually** (`POST …/rounds/:roundId/meeting/retry`, `PUT …/rounds/:roundId/meeting-link`).
- **Reschedule / cancel.** `POST …/rounds/:roundId/reschedule` and `POST …/rounds/:roundId/cancel` move or
  remove the vendor meeting through the provider that created it (stored on the round), even if the
  organisation has since switched provider. A vendor failure leaves the round's change in place and
  marks the meeting `OUT_OF_SYNC` or `CANCEL_FAILED`, which *Try again* resolves.
- **Calls.** 10 s timeout; redirects refused; OAuth tokens cached per credential set until 60 s before
  expiry and dropped on a 401. Only idempotent calls (token requests, reads, `PATCH` with absolute
  times, `DELETE`) are retried — twice, on network errors, 429 and 5xx. Creation is never retried
  automatically, so a slow vendor cannot produce two meetings. Vendor response bodies, tokens and
  secrets are never logged or returned; errors map to fixed sentences.
- **Status.** `GET /api/admin/providers` → `roundMeeting` (selected provider, source, readiness, and for
  admins the variable names with presence only). `GET /api/pipelines/meeting-provider` gives schedulers
  the provider name and readiness.
- **Data rights.** The vendor meeting id, join URL and error are stored on the round
  (`meetingProvider`, `meetingExternalId`, `meetingUrl`, `meetingStatus`, `meetingError`). Erasing a
  candidate removes their still-booked vendor meetings (best effort, after the rows are deleted;
  reported as `deleted.externalMeetings`). The retention sweep clears the link, id and error from
  completed or cancelled rounds past the window (`deleted.roundMeetingLinks`), honouring legal holds.

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
