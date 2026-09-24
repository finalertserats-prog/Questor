# Demo interview — the contract between this lane and the guided-tour lane

`feature/demo-interview` (wt-demoint) owns the two interview modes, the
fifteen-minute cap, the spend ceiling and the feedback step.
`feature/guided-demo` (wt-demo) owns the narrated tour, read-only explore and
the **End demo** control.

Neither lane edits the other's files. This is what each publishes.

## What this lane publishes

### `GET /api/demo/status` — the readiness signal (the tour lane's endpoint)

**Read this before rendering any demo interview affordance.**

```json
{ "visitor": {...}, "caps": {...}, "story": {...},
  "modes": { "candidate": true, "observer": true } }
```

`modes` is the field this lane fills. The tour lane published the endpoint and
left `demoInterviewModes()` a stub; it now answers from
`services/demoReadiness.ts`. There is ONE status endpoint — two routers on
`/api/demo` both declaring `/status` meant the first mounted won and the other
was dead code.

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

## Where the two lanes meet, as shipped

1. **`demoInterviewModes()` is filled.** The tour left it a stub returning both
   modes off; it now answers from `services/demoReadiness.ts`. The bar's button
   and the tour's closing card follow it without further wiring.
2. **The bar's gate reads EITHER mode.** It asked only about the candidate
   side, from before watching one existed — which hid the button on every
   deployment without a live model, exactly the deployment the written
   interview is for.
3. **Both closing choices go to `/demo/interview?start=<mode>`.** The card
   offered both but handled only `candidate`, by opening the sample interview's
   portal link directly. That path plans no sitting, claims no allowance and
   records no run, so the fifteen minutes would not have been enforced on it.
   `openSampleInterview` is retired with its last caller.
4. **End demo mints a feedback ticket first**, in the shared
   `components/demo/endDemo.ts`, as above.
5. **Explore caps.** `assertDemoCreationCap` keeps the tour lane's
   DEMO_SEEDED + DEMO_ADDED_CAPS shape; what the demo itself provisions —
   observer mode's written candidate and its session — is excluded from the
   count, so watching an interview does not cost the visitor one of theirs.

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
