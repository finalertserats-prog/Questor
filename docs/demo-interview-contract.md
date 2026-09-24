# Demo interview — the contract between this lane and the guided-tour lane

`feature/demo-interview` (wt-demoint) owns the two interview modes, the
fifteen-minute cap, the spend ceiling and the feedback step.
`feature/guided-demo` (wt-demo) owns the narrated tour, read-only explore and
the **End demo** control.

Neither lane edits the other's files. This is what each publishes.

## What this lane publishes

### `GET /api/demo/status` — the readiness signal

**Read this before rendering any demo interview affordance.**

```json
{ "interview": { "candidate": true, "observer": true } }
```

`candidate` is false whenever the candidate-side interview cannot be delivered
properly: no real model configured, the primary resting after an auth or quota
failure, the day's demo budget without room for a whole sitting, or no server
speech. `observer` is always true — it is a written interview and needs nothing
to be working.

**Render only what this says is true.** Do not grey the candidate option out,
and do not explain its absence. Owner, 2026-09-24: *nothing below standard is
served, and nothing is disclaimed.* The route enforces the same thing, so a
deep link cannot get past a card that is out of date — a refused start comes
back `409` with `code: "offer_observer"`, which means "re-read the offer", not
"show an error".

### Routes this lane owns

| Route | Who | What |
|---|---|---|
| `/demo/interview` | signed-in demo | the mode choice |
| `/demo/watch/:runId` | signed-in demo | watching the written interview |
| `/demo/feedback/:token` | **signed out** | the feedback form |

`GET /api/demo/interview/choices` returns only deliverable modes, already
worded. The tour should link to `/demo/interview` rather than composing its own
copy, so there is one place the fifteen minutes is explained.

### The feedback ticket — what End demo does, and must keep doing

`POST /api/demo/end` clears the session, so the feedback form cannot
authenticate as the visitor. The order is:

```
POST /api/demo/interview/feedback-ticket   → { token, expiresAt }
POST /api/demo/end
navigate to /demo/feedback/<token>
```

**This lane has already wired that into the demo bar's End demo handler**
(`web/src/App.tsx`, `endDemo`) rather than leaving the feedback step
unreachable. Failing to get a ticket does not stop the demo ending — the
visitor just goes to `/demo/ended` as before. If the guided-tour lane rebuilds
that control, keep the three steps in that order.

The ticket is hashed at rest, single use, good for 24 hours, and works after
the session is gone — which is also what lets a visitor who closed the tab come
back to it. Asking twice re-issues the same row rather than making a second
one, so it is safe to call on every End demo press.

If End demo is pressed with no interview taken, call it anyway: the row records
`mode: "none"` and the owner still gets the feedback.

## What this lane expects from the guided-tour lane

1. **The demo bar's interview button now goes to `/demo/interview`.** This lane
   changed it (`web/src/App.tsx`) from opening the portal in a new tab to
   linking to the choice screen, because the fifteen minutes has to be
   explained before anything starts. If the tour rebuilds that bar, keep the
   link.
2. **End demo mints a feedback ticket first**, as above.
3. **Explore caps are 2 roles / 3 candidates / 3 interviews** (owner,
   2026-09-24). This lane changed `assertDemoCreationCap` in
   `server/src/services/demoAccess.ts` from 3/5/5. What the demo itself
   provisions — observer mode's written candidate and its session — is excluded
   from the count, so watching an interview does not cost the visitor one of
   theirs.

## Shared files this lane touched

Small, deliberate edits, listed so a rebase is readable:

- `server/src/realtime/interviewEngine.ts` — one call in `produceAgentTurn` to
  shape a demo turn at the time box, and `withPrefix` on the appended text.
- `server/src/providers/llm/index.ts` — the demo spend gate now consults
  `demoInterviewMaySpend` before returning null.
- `server/src/services/demoPolicy.ts` — two additions: the model exception and
  the matching voice exception.
- `server/src/services/demoAccess.ts` — the purge takes the three new tables;
  the explore caps are the owner's numbers.
- `server/src/seed/demoData.ts` — `wipe()` clears the new tables.
- `server/src/app.ts`, `server/src/index.ts` — mounts and the sweep job.
- `web/src/App.tsx`, `web/src/main.tsx` — routes, the stylesheet import, the
  demo bar's interview link, and the three-step End demo handler above.

## The one rule that binds both lanes

**The interviewer never breaks character.** The demo's bounds are stated once,
before the visitor chooses, and never again. No countdown in the room, no
"limit reached", no apology for what the product cannot do today. If a boundary
has to be visible it is spoken by the interviewer, in its own voice, moving the
conversation along. `staysInCharacter()` in
`server/src/domain/demoInterview.ts` is the guard, and it is worth using on any
demo copy either lane writes.
