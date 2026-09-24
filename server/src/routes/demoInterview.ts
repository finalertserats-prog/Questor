import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { asyncHandler, authenticate, HttpError } from '../middleware/index.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { logger } from '../logger.js';
import {
  DEMO_MODES, beforeYouStartLine, isDemoMode, modeLabel, type DemoMode,
} from '../domain/demoInterview.js';
import { DEMO_OBSERVER_SCRIPT, DEMO_SCRIPT_CANDIDATE, DEMO_SCRIPT_PERSONA } from '../domain/demoObserverScript.js';
import { startDemoInterview } from '../services/demoInterviewStart.js';
import { clockView, endRun, extendRun, liveRunForGrant, noteStage, runById, runForSession } from '../services/demoInterviewRun.js';
import { finishDemoRun } from '../services/demoInterviewFinish.js';
import { playUpTo } from '../services/demoObserverPlayer.js';
import { issueFeedbackTicket, submitFeedback } from '../services/demoFeedback.js';
import { demoInterviewReadiness } from '../services/demoReadiness.js';

/**
 * The demo interview, from the choice of mode to the feedback form.
 *
 * A router of its own rather than more of routes/demo.ts, because the guided
 * tour and the End demo control are being built alongside this in another
 * lane: two features editing one file is a merge conflict by construction.
 * Both mount under /api/demo.
 */
export const demoInterviewRouter = Router();

/** Everything here is the visitor's own sandbox, and nothing else's. */
function demoAuth(req: { auth?: { demo?: boolean; demoGrantId?: string; tenantId: string } }): { tenantId: string; demoGrantId: string } {
  if (req.auth?.demo !== true || !req.auth.demoGrantId) throw new HttpError(403, 'Only available in a demo.');
  return { tenantId: req.auth.tenantId, demoGrantId: req.auth.demoGrantId };
}

const startSchema = z.object({
  mode: z.enum(DEMO_MODES),
  /**
   * Taken on the way in, with no reason asked. Offered to everybody precisely
   * so that taking it is not a disclosure — see domain/demoInterview.ts.
   */
  extraTime: z.boolean().optional(),
}).strict();

/**
 * The signal the whole demo reads before offering anything.
 *
 * Published as its own endpoint because the guided-tour lane renders the demo
 * card and must be told what to render rather than working it out: one source
 * of truth, so the card and the route can never disagree about whether the
 * candidate-side interview is on offer.
 *
 * The reasons are deliberately absent from the response. A visitor is shown a
 * demo with one option instead of two, which tells them nothing is wrong —
 * because nothing is.
 */
demoInterviewRouter.get('/status', authenticate, asyncHandler(async (req, res) => {
  demoAuth(req);
  const ready = await demoInterviewReadiness();
  res.json({ interview: { candidate: ready.candidate, observer: ready.observer } });
}));

/**
 * The choice screen's own content, so the two modes are described in one place
 * and the page cannot drift from what the server will actually do.
 */
demoInterviewRouter.get('/interview/choices', authenticate, asyncHandler(async (req, res) => {
  const { tenantId, demoGrantId } = demoAuth(req);
  const open = await liveRunForGrant(demoGrantId);
  const role = await prisma.role.findFirst({ where: { tenantId }, orderBy: { createdAt: 'asc' }, select: { title: true } });
  const ready = await demoInterviewReadiness();
  const offered = DEMO_MODES.filter((mode) => mode === 'observer' || ready.candidate);
  res.json({
    roleTitle: role?.title ?? null,
    open: open ? { runId: open.id, mode: open.mode, ...clockView(open) } : null,
    // Only what can be delivered properly. A mode that is absent needs no
    // explanation; a mode that is present and disclaimed needs one, and the
    // explanation is what does the damage.
    choices: offered.map((mode: DemoMode) => ({
      mode,
      label: modeLabel(mode),
      // Said BEFORE they choose. Saying it here is what buys the right to say
      // nothing at all during the interview itself.
      timing: beforeYouStartLine(mode),
      detail: mode === 'candidate'
        ? 'You answer the interviewer yourself, out loud or by typing, against the Senior Data Engineer role in your sandbox. At the end you get the assessment it writes from your answers.'
        : `You watch the interviewer question ${DEMO_SCRIPT_CANDIDATE.fullName}, a written candidate from our test harness — ${DEMO_SCRIPT_PERSONA.label.toLowerCase()}. Nothing is asked of you. It plays at the pace a real interview runs.`,
      simulated: mode === 'observer',
    })),
  });
}));

// Starting a sitting provisions rows and, in candidate mode, may spend on a
// model. A visitor cannot need more than a handful in an hour.
const startLimit = rateLimit({ name: 'demo-interview-start', windowMs: 60 * 60_000, max: 8, keyOf: (req) => req.auth?.demoGrantId ?? req.ip ?? 'unknown' });

demoInterviewRouter.post('/interview/start', authenticate, startLimit, asyncHandler(async (req, res) => {
  const { tenantId, demoGrantId } = demoAuth(req);
  const body = startSchema.parse(req.body);
  // The ROUTE is gated, not only the button. A visitor who deep-links to the
  // candidate-side interview while it cannot be delivered properly is sent
  // back to an offer they can take, never into an interview that would have
  // to degrade partway through.
  if (body.mode === 'candidate' && !(await demoInterviewReadiness()).candidate) {
    throw new HttpError(409, 'Watch an interview instead.', 'offer_observer');
  }
  const started = await startDemoInterview({ mode: body.mode, tenantId, demoGrantId, extendTime: body.extraTime });
  await noteStage(started.run.sessionId, 'chose_mode');
  res.status(201).json({
    runId: started.run.id,
    mode: started.run.mode,
    portalUrl: started.portalUrl,
    ...clockView(started.run),
  });
}));

/** The clock, for a page that wants to show it. Never the thing that enforces it. */
demoInterviewRouter.get('/interview/run/:id', authenticate, asyncHandler(async (req, res) => {
  const { demoGrantId } = demoAuth(req);
  const run = await runById(req.params.id);
  if (!run || run.demoGrantId !== demoGrantId) throw new HttpError(404, 'That demo interview is not running.');
  res.json({ runId: run.id, mode: run.mode, stage: run.stage, endReason: run.endReason, ...clockView(run) });
}));

demoInterviewRouter.post('/interview/run/:id/extra-time', authenticate, asyncHandler(async (req, res) => {
  const { demoGrantId } = demoAuth(req);
  const run = await runById(req.params.id);
  if (!run || run.demoGrantId !== demoGrantId) throw new HttpError(404, 'That demo interview is not running.');
  const extended = await extendRun(run.id);
  res.json({ runId: extended.id, ...clockView(extended) });
}));

/**
 * What the observer can see so far.
 *
 * The poll IS the playback: lines are written by whoever asks what has
 * happened, on a schedule computed from the sitting's start. So a watcher who
 * reloads sees the same conversation at the same point, two tabs agree, and a
 * watcher who closes the tab leaves nothing running.
 */
demoInterviewRouter.get('/interview/run/:id/watch', authenticate, asyncHandler(async (req, res) => {
  const { demoGrantId } = demoAuth(req);
  const run = await runById(req.params.id);
  if (!run || run.demoGrantId !== demoGrantId) throw new HttpError(404, 'That demo interview is not running.');
  if (run.mode !== 'observer') throw new HttpError(409, 'That demo interview is not one you are watching.');

  if (!run.endedAt) {
    await playUpTo({ sessionId: run.sessionId, startedAt: run.startedAt });
    await noteStage(run.sessionId, 'interviewing');
  }
  const turns = await prisma.turn.findMany({
    where: { sessionId: run.sessionId },
    orderBy: { index: 'asc' },
    select: { index: true, speaker: true, text: true, metaJson: true },
  });
  const session = await prisma.interviewSession.findUnique({
    where: { id: run.sessionId },
    select: { state: true, candidate: { select: { fullName: true } }, personaJson: true, invitation: { select: { tokenSealed: true, token: true } } },
  });
  const assessment = await prisma.assessmentVersion.findFirst({
    where: { sessionId: run.sessionId }, orderBy: { createdAt: 'desc' }, select: { id: true },
  });

  const fresh = await runById(run.id);
  res.json({
    runId: run.id,
    // Said on every single response, not once at the start: a watcher who
    // joins late, reloads, or comes back an hour later must never be able to
    // mistake this for a conversation somebody actually had.
    simulated: true,
    simulatedCandidate: DEMO_SCRIPT_CANDIDATE.fullName,
    interviewer: personaName(session?.personaJson),
    state: session?.state ?? 'UNKNOWN',
    complete: turns.length >= DEMO_OBSERVER_SCRIPT.length,
    assessmentId: assessment?.id ?? null,
    turns: turns.map((t) => ({ index: t.index, speaker: t.speaker, text: t.text, kind: kindOf(t.metaJson) })),
    ...(fresh ? clockView(fresh) : {}),
  });
}));

function personaName(raw: string | undefined): string {
  if (!raw) return 'The interviewer';
  try {
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === 'string' && parsed.name ? parsed.name : 'The interviewer';
  } catch {
    return 'The interviewer';
  }
}

function kindOf(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown };
    return typeof parsed.kind === 'string' ? parsed.kind : '';
  } catch {
    return '';
  }
}

/** The visitor ending their own sitting early. */
demoInterviewRouter.post('/interview/run/:id/finish', authenticate, asyncHandler(async (req, res) => {
  const { demoGrantId } = demoAuth(req);
  const run = await runById(req.params.id);
  if (!run || run.demoGrantId !== demoGrantId) throw new HttpError(404, 'That demo interview is not running.');
  const outcome = await finishDemoRun(run, 'demo_ended');
  res.json({ outcome });
}));

/**
 * The ticket the feedback form uses.
 *
 * Handed out while the visitor is still signed in, because End demo clears the
 * session: the form itself runs signed out. See services/demoFeedback.ts.
 */
demoInterviewRouter.post('/interview/feedback-ticket', authenticate, asyncHandler(async (req, res) => {
  const { tenantId, demoGrantId } = demoAuth(req);
  const open = await liveRunForGrant(demoGrantId);
  const latest = open ?? (await prisma.demoInterviewRun.findFirst({
    where: { demoGrantId }, orderBy: { startedAt: 'desc' }, select: { id: true, mode: true, stage: true, sessionId: true },
  }));
  const ticket = await issueFeedbackTicket({
    tenantId,
    demoGrantId,
    runId: latest?.id ?? null,
    mode: latest && isDemoMode(latest.mode) ? latest.mode : 'none',
    stage: latest?.stage ?? 'chose_mode',
  });
  if (latest?.sessionId) await noteStage(latest.sessionId, 'saw_status');
  res.status(201).json({ token: ticket.token, expiresAt: ticket.expiresAt.toISOString() });
}));

/**
 * The feedback itself. NO authentication: the ticket is the credential, and by
 * the time this is called the demo session is usually already cleared.
 */
export const demoFeedbackRouter = Router();

const feedbackSchema = z.object({
  token: z.string().min(24).max(128),
  body: z.string().min(1).max(4_000),
  /**
   * 'spoken' means the browser's own recogniser produced these words. What is
   * stored either way is text: no audio reaches this server, and none is kept.
   */
  source: z.enum(['typed', 'spoken']).default('typed'),
}).strict();

const feedbackLimit = rateLimit({ name: 'demo-feedback', windowMs: 60 * 60_000, max: 20, keyOf: (req) => req.ip ?? 'unknown' });

demoFeedbackRouter.post('/', feedbackLimit, asyncHandler(async (req, res) => {
  const body = feedbackSchema.parse(req.body);
  const saved = await submitFeedback({ token: body.token, body: body.body, source: body.source });
  // The visitor is thanked the same way whether or not their text tripped the
  // screen. Telling them it was flagged would teach an attacker the shape of
  // the screen and would insult everybody else.
  logger.info({ id: saved.id }, 'Demo feedback received');
  res.status(201).json({ recorded: true });
}));

export { runForSession as _runForSession, endRun as _endRun };
