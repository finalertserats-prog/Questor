import { Router, type Request } from 'express';
import { z } from 'zod';
import type { CandidatePipeline, InterviewRound } from '@prisma/client';
import { prisma, parseJsonOptional, parseJsonStrict } from '../db.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import { assertCanAccessCandidate, assertCanAccessRole, hasCapability } from '../services/access.js';
import { notifyCandidateOfHumanRound, type CandidateNotice } from '../services/roundCandidateNotice.js';
import { SCHEDULABLE_STATES, sendInterviewSchedule } from './interviews.js';
import { logAudit } from '../services/audit.js';
import { OBSERVER_NOTICE, withObserverNotice } from '../services/observerPolicy.js';
import { endObservation } from '../services/roundObserver.js';
import { extractEvidenceQuotes } from '../services/observerQuotes.js';
import { getEmail } from '../providers/email/index.js';
import { brandedEmail, headerSafe } from '../providers/email/branding.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { formatScheduledTime } from '../services/zonedTime.js';
import { tenantTimeZone } from '../services/tenantTimeZone.js';
import { resolveScheduleTime, scheduleTimeFields } from './scheduleTime.js';
import {
  DEFAULT_STAGES, nextStageKey, parseStages, parseStagesStrict, roundRolesFor, stagesSchema, type PipelineStage,
} from '../domain/pipelineStages.js';
import { DECISION_OUTCOMES, resolveTransition } from '../domain/pipelineAutonomy.js';
import { decidePipeline } from '../services/pipelineAutonomy.js';
import {
  createMeeting, initialMeetingFields, isStaleCreation, tenantMeetingProvider, MEETING_STATUS, type MeetingOutcome,
} from '../services/roundMeeting.js';
import { meetingUrlSchema, durationSchema } from './roundMeetingSchemas.js';

/**
 * The medallion pipeline: one candidate moving through ordered stages for one
 * role. The stage plan is snapshotted when the pipeline starts, stages run in
 * order, and a person records the outcome — at any stage, once.
 */
export const pipelinesRouter = Router();
pipelinesRouter.use(authenticate);

export type PipelineWithRounds = CandidatePipeline & { rounds: InterviewRound[] };

export function presentRound(round: InterviewRound) {
  return {
    id: round.id,
    stageKey: round.stageKey,
    conductedBy: round.conductedBy,
    aiObserver: round.aiObserver,
    hrMayObserve: round.hrMayObserve,
    sessionId: round.sessionId,
    interviewers: parseJsonOptional<string[]>(round.interviewersJson, [], { model: 'InterviewRound', id: round.id, field: 'interviewersJson' }),
    scheduledAt: round.scheduledAt,
    // The zone it was booked in; null for the older offset-only form.
    scheduledTimeZone: round.scheduledTimeZone,
    status: round.status,
    // What the interviewers wrote IS the evidence for a human stage — nothing
    // else records those rounds, because Questor does not host them. Withholding
    // it here meant the only way to read a completed round was the database, so
    // the candidate's own page could say a round happened but never what it
    // showed. It travels under the same candidate scope as the round itself, and
    // retention clears it from the row (services/dataRights.ts), so a round past
    // its window honestly returns ''.
    notes: round.notes,
    completedAt: round.completedAt,
    createdAt: round.createdAt,
    durationMinutes: round.durationMinutes,
    // The vendor's meeting id stays server-side: nothing in the UI needs it.
    // A human round from before meetings existed has no status; it simply
    // needs a link. The AI round runs in the Questor room and has none.
    meeting: round.conductedBy !== 'HUMAN' ? null : {
      provider: round.meetingProvider,
      status: round.meetingStatus ?? 'NEEDS_LINK',
      url: round.meetingUrl,
      error: round.meetingError,
      // A creation that never finished (server restart): offer the fallbacks again.
      stuck: isStaleCreation(round),
    },
  };
}

function presentPipeline(pipeline: PipelineWithRounds) {
  return {
    id: pipeline.id,
    candidateId: pipeline.candidateId,
    roleId: pipeline.roleId,
    stages: parseStagesStrict(pipeline.stagesJson, { model: 'CandidatePipeline', id: pipeline.id, field: 'stagesJson' }),
    currentStageKey: pipeline.currentStageKey,
    status: pipeline.status,
    decision: pipeline.decision,
    decisionReason: pipeline.decisionReason,
    decidedAtStageKey: pipeline.decidedAtStageKey,
    decidedAt: pipeline.decidedAt,
    rounds: pipeline.rounds.map(presentRound),
    createdAt: pipeline.createdAt,
    updatedAt: pipeline.updatedAt,
  };
}

const withRounds = { rounds: { orderBy: { scheduledAt: 'asc' as const } } };

/** A pipeline in the caller's organisation AND object scope; 404 otherwise. */
export async function loadPipeline(req: Request, id: string): Promise<PipelineWithRounds> {
  const pipeline = await prisma.candidatePipeline.findFirst({ where: { id, tenantId: req.auth!.tenantId }, include: withRounds });
  if (!pipeline) throw new HttpError(404, 'Pipeline not found');
  // Pipelines inherit the candidate's scope rather than defining their own.
  await assertCanAccessCandidate(req.auth!, pipeline.candidateId);
  return pipeline;
}

async function reload(id: string): Promise<PipelineWithRounds> {
  return prisma.candidatePipeline.findUniqueOrThrow({ where: { id }, include: withRounds });
}

export function labelOf(stages: readonly PipelineStage[], key: string): string {
  return stages.find((stage) => stage.key === key)?.label ?? key;
}

const DECIDED = 'A decision has already been recorded for this pipeline.';

pipelinesRouter.post('/', requireCapability('interview:create'), asyncHandler(async (req, res) => {
  const { candidateId } = z.object({ candidateId: z.string().min(1) }).parse(req.body);
  const tenantId = req.auth!.tenantId;
  const candidate = await assertCanAccessCandidate(req.auth!, candidateId);
  if (!candidate.roleId) throw new HttpError(400, 'Attach the candidate to a role before starting a pipeline.');

  const role = await prisma.role.findFirst({ where: { id: candidate.roleId, tenantId }, select: { pipelineStagesJson: true } });
  const stages = role?.pipelineStagesJson ? parseStages(role.pipelineStagesJson) : DEFAULT_STAGES.map((s) => ({ ...s }));

  let pipeline: PipelineWithRounds;
  try {
    pipeline = await prisma.candidatePipeline.create({
      data: {
        tenantId, candidateId: candidate.id, roleId: candidate.roleId,
        stagesJson: JSON.stringify(stages), currentStageKey: stages[0].key, createdById: req.auth!.userId,
      },
      include: withRounds,
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') throw new HttpError(409, 'This candidate already has a pipeline for this role.');
    throw err;
  }

  await logAudit({
    tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'pipeline.created', entityType: 'CandidatePipeline', entityId: pipeline.id,
    after: { candidateId: candidate.id, roleId: candidate.roleId, stages: stages.map((s) => s.key) },
  });
  res.status(201).json({ pipeline: presentPipeline(pipeline) });
}));

// A candidate's pipelines. Scoped through the candidate, so naming a candidate
// in another organisation, or outside the caller's assignments, returns 404.
pipelinesRouter.get('/', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const { candidateId } = z.object({ candidateId: z.string().min(1) }).parse(req.query);
  const candidate = await assertCanAccessCandidate(req.auth!, candidateId);
  const pipelines = await prisma.candidatePipeline.findMany({
    where: { candidateId: candidate.id, tenantId: req.auth!.tenantId },
    orderBy: { createdAt: 'desc' },
    include: withRounds,
  });
  res.json({ pipelines: pipelines.map(presentPipeline) });
}));

pipelinesRouter.get('/:id', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  res.json({ pipeline: presentPipeline(await loadPipeline(req, req.params.id)) });
}));

pipelinesRouter.post('/:id/advance', requireCapability('interview:create'), asyncHandler(async (req, res) => {
  const { toStageKey } = z.object({ toStageKey: z.string().min(1) }).parse(req.body);
  const pipeline = await loadPipeline(req, req.params.id);
  if (pipeline.status !== 'ACTIVE') throw new HttpError(409, DECIDED);

  const stages = parseStagesStrict(pipeline.stagesJson, { model: 'CandidatePipeline', id: pipeline.id, field: 'stagesJson' });
  const next = nextStageKey(stages, pipeline.currentStageKey);
  if (!next) throw new HttpError(409, 'This candidate is already at the final stage.');
  if (toStageKey !== next) throw new HttpError(409, `Stages run in order; the next stage is ${labelOf(stages, next)}.`);

  // Conditional on the stage we read, so two people advancing at once cannot both succeed.
  const moved = await prisma.candidatePipeline.updateMany({
    where: { id: pipeline.id, status: 'ACTIVE', currentStageKey: pipeline.currentStageKey },
    data: { currentStageKey: next },
  });
  if (moved.count !== 1) throw new HttpError(409, 'This pipeline changed while you were working on it. Reload and try again.');

  await logAudit({
    tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'pipeline.advanced', entityType: 'CandidatePipeline', entityId: pipeline.id,
    before: { stage: pipeline.currentStageKey }, after: { stage: next },
  });
  res.json({ pipeline: presentPipeline(await reload(pipeline.id)) });
}));

interface SchedulingNotice {
  readonly delivered: boolean;
  readonly link: string;
  readonly deliveryNote: string;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Email the person who scheduled a round the link they need. Reports whether it
 * was actually delivered — the console provider delivers nothing, and saying
 * "sent" regardless is how links silently go unseen.
 */
async function notifyScheduler(o: { to: string; stageLabel: string; scheduledAt: Date; timeZone: string; link: string; aiRound: boolean; meetingUrl: string | null }): Promise<SchedulingNotice> {
  const email = getEmail();
  if (!email.delivers) {
    return { delivered: false, link: o.link, deliveryNote: `Email is not configured to deliver (provider "${email.name}"). Use the link here.` };
  }
  // In the zone the round was booked in, else the tenant's: a bare GMT time is
  // converted in the reader's head, and wrongly whenever they forget to.
  const when = formatScheduledTime(o.scheduledAt, o.timeZone);
  // Stage labels are configurable, so strip control characters before they
  // reach a subject line or plain-text body, where a line break could forge
  // headers or text. HTML escaping below does not cover these.
  const label = o.stageLabel.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  const intro = o.aiRound
    ? `The ${label} AI interview is scheduled for ${when}. You can observe it live here:`
    : `The ${label} interview is scheduled for ${when}. The candidate and their pipeline are here:`;
  const join = o.meetingUrl ? `\nMeeting link: ${o.meetingUrl}` : '';
  const joinHtml = o.meetingUrl ? `<p>Meeting link: <a href="${escapeHtml(o.meetingUrl)}">${escapeHtml(o.meetingUrl)}</a></p>` : '';
  try {
    await email.send(brandedEmail({
      to: o.to,
      subject: `${headerSafe(label)} interview scheduled`,
      text: `${intro}\n${o.link}${join}`,
      html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(o.link)}">${escapeHtml(o.link)}</a></p>${joinHtml}`,
    }));
    return { delivered: true, link: o.link, deliveryNote: `Sent to ${o.to}.` };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Round scheduling email failed');
    return { delivered: false, link: o.link, deliveryNote: 'The email could not be sent. Use the link here.' };
  }
}

async function firstMeeting(round: InterviewRound, stageLabel: string, candidateId: string): Promise<MeetingOutcome> {
  if (round.meetingStatus === MEETING_STATUS.CREATING) return createMeeting(round, { stageLabel, candidateId });
  if (round.meetingStatus === MEETING_STATUS.MANUAL) {
    return { ok: true, provider: 'manual', status: MEETING_STATUS.MANUAL, url: round.meetingUrl, message: 'Your meeting link was saved.' };
  }
  return { ok: false, provider: 'manual', status: MEETING_STATUS.NEEDS_LINK, url: null, message: 'No meeting provider is selected. Add a meeting link for this round.' };
}

/**
 * Tell the candidate about a round just booked. The AI round goes out as the
 * interview invitation, carrying the time the session now holds; a human round
 * as a note with the time and meeting link. A round already past sends nothing.
 */
async function noticeForNewRound(
  req: Request,
  round: InterviewRound,
  o: { pipeline: CandidatePipeline; stageLabel: string; aiRound: boolean },
): Promise<CandidateNotice> {
  if (round.scheduledAt.getTime() <= Date.now()) {
    return { sent: false, note: 'The round time has passed, so the candidate was not emailed.' };
  }
  if (o.aiRound && round.sessionId) return sendInterviewSchedule(req, round.sessionId);
  if (round.conductedBy !== 'HUMAN') {
    return { sent: false, note: 'No interview is linked to this round yet, so the candidate was not emailed.' };
  }
  if (!hasCapability(req.auth!, 'interview:invite')) {
    return { sent: false, note: 'Your account cannot email candidates, so the candidate was not emailed.' };
  }
  return notifyCandidateOfHumanRound({
    round, candidateId: o.pipeline.candidateId, roleId: o.pipeline.roleId, stageLabel: o.stageLabel, kind: 'booked',
  });
}

const roundSchema = z.object({
  stageKey: z.string().min(1),
  // A date, time and zone, or the older offset-aware instant (see
  // scheduleTime.ts). Deliberately NOT limited to the future: a round that
  // already happened is recorded here too, notes and all.
  ...scheduleTimeFields,
  sessionId: z.string().min(1).optional(),
  interviewers: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
  durationMinutes: durationSchema.optional(),
  // A link the recruiter already has. Human rounds only; skips vendor creation.
  meetingUrl: meetingUrlSchema.optional(),
});

pipelinesRouter.post('/:id/rounds', requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  const body = roundSchema.parse(req.body);
  const booked = resolveScheduleTime(body);
  const tenantId = req.auth!.tenantId;
  const pipeline = await loadPipeline(req, req.params.id);
  if (pipeline.status !== 'ACTIVE') throw new HttpError(409, DECIDED);
  if (body.stageKey !== pipeline.currentStageKey) {
    throw new HttpError(409, 'Rounds are scheduled for the stage the candidate is currently at.');
  }

  const stage = parseStagesStrict(pipeline.stagesJson, { model: 'CandidatePipeline', id: pipeline.id, field: 'stagesJson' }).find((s) => s.key === body.stageKey);
  const roles = stage ? roundRolesFor(stage.kind) : null;
  if (!stage || !roles) throw new HttpError(409, `${stage?.label ?? 'This stage'} is not an interview stage.`);
  const humanRound = roles.conductedBy === 'HUMAN';
  if (body.meetingUrl && !humanRound) throw new HttpError(400, 'The AI interview runs in the Questor room; it takes no meeting link.');
  const meetingFields = humanRound ? initialMeetingFields(await tenantMeetingProvider(tenantId), body.meetingUrl) : {};

  if (body.sessionId) {
    const session = await prisma.interviewSession.findFirst({
      where: { id: body.sessionId, tenantId, candidateId: pipeline.candidateId }, select: { id: true },
    });
    if (!session) throw new HttpError(404, 'Interview session not found for this candidate.');
  }

  // Re-check the pipeline inside the same transaction as the insert. Checking
  // it only on load left a gap in which a concurrent decision or advance could
  // land, producing a round after a decision or for a stage already left.
  const { round, noticeAdded } = await prisma.$transaction(async (tx) => {
    let noticeAdded = false;
    const stillHere = await tx.candidatePipeline.updateMany({
      where: { id: pipeline.id, status: 'ACTIVE', currentStageKey: stage.key },
      data: { updatedAt: new Date() },
    });
    if (stillHere.count !== 1) throw new HttpError(409, 'This pipeline changed while you were working on it. Reload and try again.');

    // HR may silently observe the AI interview, so the candidate must be told
    // before they consent. After consent the notice cannot be added
    // retroactively; observation of that session then stays unavailable.
    if (roles.hrMayObserve && body.sessionId) {
      const session = await tx.interviewSession.findUniqueOrThrow({ where: { id: body.sessionId }, select: { consentJson: true } });
      // Read strictly: this block writes the record back, and a damaged one
      // would be replaced by a disclosure holding only the observer notice.
      const consent = parseJsonStrict<Record<string, unknown>>(session.consentJson, { model: 'InterviewSession', id: body.sessionId, field: 'consentJson' });
      if (!consent.consentedAt) {
        const disclosureText = withObserverNotice(typeof consent.disclosureText === 'string' ? consent.disclosureText : '');
        if (disclosureText !== consent.disclosureText) {
          // Conditional on the consent record being exactly what was read: if the
          // candidate consents in between, their fresh consent must not be
          // overwritten by this stale copy — the notice is simply not added.
          const updated = await tx.interviewSession.updateMany({
            where: { id: body.sessionId, consentJson: session.consentJson },
            data: { consentJson: JSON.stringify({ ...consent, disclosureText }) },
          });
          noticeAdded = updated.count === 1;
        }
      }
    }

    // The AI round IS the interview session: the portal, the invitation and
    // the interview page read the session's time, so it takes the round's.
    // Only an interview still ahead is moved; a round recorded afterwards
    // leaves a held interview's record alone.
    if (!humanRound && body.sessionId && booked.at.getTime() > Date.now()) {
      await tx.interviewSession.updateMany({
        where: { id: body.sessionId, tenantId, state: { in: [...SCHEDULABLE_STATES] } },
        data: { scheduledAt: booked.at, scheduledTimeZone: booked.timeZone },
      });
    }

    const created = await tx.interviewRound.create({
      data: {
        tenantId, pipelineId: pipeline.id, stageKey: stage.key,
        conductedBy: roles.conductedBy, aiObserver: roles.aiObserver, hrMayObserve: roles.hrMayObserve,
        sessionId: body.sessionId ?? null, interviewersJson: JSON.stringify(body.interviewers ?? []),
        scheduledAt: booked.at, scheduledTimeZone: booked.timeZone, createdById: req.auth!.userId,
        ...(body.durationMinutes ? { durationMinutes: body.durationMinutes } : {}),
        ...meetingFields,
      },
    });
    return { round: created, noticeAdded };
  });

  // Changing what a candidate is told is a legal disclosure change: record who
  // made it and when. Written after the transaction commits, so the audit can
  // never claim a change that rolled back.
  if (noticeAdded && body.sessionId) {
    await logAudit({
      tenantId, actorType: 'user', actorId: req.auth!.userId,
      action: 'interview.observer_notice_added', entityType: 'InterviewSession', entityId: body.sessionId,
      after: { notice: OBSERVER_NOTICE, pipelineId: pipeline.id },
    });
  }

  await logAudit({
    tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'pipeline.round_scheduled', entityType: 'CandidatePipeline', entityId: pipeline.id,
    after: { roundId: round.id, stage: stage.key, conductedBy: roles.conductedBy, scheduledAt: booked.at.toISOString(), scheduledTimeZone: booked.timeZone },
  });

  // The booking is saved above; the meeting is set up now, outside the
  // transaction, and a failure only changes what the recruiter is told.
  const meeting = humanRound ? await firstMeeting(round, stage.label, pipeline.candidateId) : null;
  if (meeting) {
    await logAudit({
      tenantId, actorType: 'user', actorId: req.auth!.userId,
      action: 'pipeline.round_meeting', entityType: 'CandidatePipeline', entityId: pipeline.id,
      after: { roundId: round.id, operation: 'create', provider: meeting.provider, status: meeting.status },
    });
  }

  // HR gets the link they need: the live observe page for the AI interview,
  // otherwise the candidate's page, where the pipeline lives.
  const aiRound = round.conductedBy === 'AI' && round.sessionId !== null;
  const link = aiRound
    ? `${config.webOrigin}/interviews/${round.sessionId}/observe`
    : `${config.webOrigin}/candidates/${pipeline.candidateId}`;
  const notification = await notifyScheduler({
    to: req.auth!.email, stageLabel: stage.label, scheduledAt: round.scheduledAt,
    timeZone: round.scheduledTimeZone ?? await tenantTimeZone(tenantId),
    link, aiRound, meetingUrl: meeting?.url ?? null,
  });

  const saved = await prisma.interviewRound.findUniqueOrThrow({ where: { id: round.id } });
  const candidateNotice = await noticeForNewRound(req, saved, { pipeline, stageLabel: stage.label, aiRound });
  res.status(201).json({ round: presentRound(saved), notification, meeting, candidateNotice });
}));

const completeSchema = z.object({
  notes: z.string().trim().min(20, 'Record what the round showed — this is the evidence for the stage.').max(10000),
});

// Closing a round with what it showed. The interviewers' notes are the
// assessment; an AI observer, where both parties agreed, only adds a transcript
// and verbatim quotes beside them.
pipelinesRouter.post('/:id/rounds/:roundId/complete', requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  const { notes } = completeSchema.parse(req.body);
  const pipeline = await loadPipeline(req, req.params.id);
  const round = pipeline.rounds.find((r) => r.id === req.params.roundId);
  if (!round) throw new HttpError(404, 'Round not found');

  const completed = await prisma.interviewRound.updateMany({
    where: { id: round.id, pipelineId: pipeline.id, status: 'SCHEDULED' },
    data: { status: 'COMPLETED', notes, completedAt: new Date() },
  });
  if (completed.count !== 1) throw new HttpError(409, 'This round has already been completed or cancelled.');

  // The round is over, so its AI observer is too: capture closes and the
  // transcript becomes read-only. Quotes are extracted in the background; the
  // round's own completion does not wait on a model.
  const observationId = await endObservation(round.id, req.auth!.userId);
  if (observationId) {
    void extractEvidenceQuotes(observationId).catch((err: unknown) => {
      logger.error({ err: err instanceof Error ? err.message : String(err), observationId }, 'Observer quote extraction crashed');
    });
  }

  await logAudit({
    tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'pipeline.round_completed', entityType: 'CandidatePipeline', entityId: pipeline.id,
    after: { roundId: round.id, stage: round.stageKey },
  });
  res.json({ round: presentRound(await prisma.interviewRound.findUniqueOrThrow({ where: { id: round.id } })) });
}));

// Finalising a candidate: the one move to the last stage (Diamond) that the
// process never makes on its own. Held to assessment:review, like the
// decision, so it stays a person's call. Forward only, from any earlier stage.
pipelinesRouter.post('/:id/finalize', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  const pipeline = await loadPipeline(req, req.params.id);
  if (pipeline.status !== 'ACTIVE') throw new HttpError(409, DECIDED);

  const stages = parseStagesStrict(pipeline.stagesJson, { model: 'CandidatePipeline', id: pipeline.id, field: 'stagesJson' });
  const transition = resolveTransition(stages, pipeline.currentStageKey, 'candidate.finalized');
  if (!transition) throw new HttpError(409, 'This candidate is already at the final stage.');

  const moved = await prisma.candidatePipeline.updateMany({
    where: { id: pipeline.id, status: 'ACTIVE', currentStageKey: transition.from },
    data: { currentStageKey: transition.to },
  });
  if (moved.count !== 1) throw new HttpError(409, 'This pipeline changed while you were working on it. Reload and try again.');

  await logAudit({
    tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'pipeline.finalized', entityType: 'CandidatePipeline', entityId: pipeline.id,
    before: { stage: transition.from }, after: { stage: transition.to },
  });
  res.json({ pipeline: presentPipeline(await reload(pipeline.id)) });
}));

const decisionSchema = z.object({
  decision: z.enum(DECISION_OUTCOMES),
  reason: z.string().trim().min(10, 'Record why this decision was made.').max(1000),
  // The stage the person was looking at when they decided. Required, and it
  // must still be where the candidate is: a retried approval that reads the
  // stage afresh would move them twice and skip a human round.
  stageKey: z.string().min(1),
});

// A person records the outcome, and the pipeline follows it: approval moves
// the candidate to the next stage (the last stage closes them as approved),
// rejection and withdrawal close the pipeline (services/pipelineAutonomy.ts).
// Held to assessment:review, the same capability that signs off an
// assessment, so this cannot become an automated step.
pipelinesRouter.post('/:id/decision', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  const body = decisionSchema.parse(req.body);
  const pipeline = await loadPipeline(req, req.params.id);
  if (pipeline.status !== 'ACTIVE') throw new HttpError(409, DECIDED);

  const stages = parseStagesStrict(pipeline.stagesJson, { model: 'CandidatePipeline', id: pipeline.id, field: 'stagesJson' });
  if (body.stageKey !== pipeline.currentStageKey) {
    throw new HttpError(409, `That decision was about ${labelOf(stages, body.stageKey)}, but the candidate is now at ${labelOf(stages, pipeline.currentStageKey)}. Reload and decide again.`);
  }

  const result = await decidePipeline(pipeline, {
    tenantId: req.auth!.tenantId, outcome: body.decision, reason: body.reason,
    about: { stageKey: pipeline.currentStageKey }, source: 'pipeline', actorId: req.auth!.userId, trigger: 'pipeline.decision',
  });
  if (!result.applied) {
    if (result.because === 'already_decided') throw new HttpError(409, DECIDED);
    // "Nothing to do" here means a concurrent move carried the candidate past
    // the stage this decision was about: the same answer as a contended write.
    throw new HttpError(409, 'This pipeline changed while you were working on it. Reload and try again.');
  }
  res.json({ pipeline: presentPipeline(await reload(pipeline.id)), effect: result.effect });
}));

interface StageSummary extends PipelineStage {
  readonly hasEvidence: boolean;
  readonly detail: string;
}

// Reports only the evidence Questor actually holds, and names what is missing.
pipelinesRouter.get('/:id/summary', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const pipeline = await loadPipeline(req, req.params.id);
  const stages = parseStagesStrict(pipeline.stagesJson, { model: 'CandidatePipeline', id: pipeline.id, field: 'stagesJson' });

  const profile = await prisma.candidateProfileVersion.findFirst({
    where: { candidateId: pipeline.candidateId }, orderBy: { version: 'desc' }, select: { id: true, fitScoreJson: true },
  });
  const fit = profile
    ? parseJsonStrict<{ overall?: unknown }>(profile.fitScoreJson, { model: 'CandidateProfileVersion', id: profile.id, field: 'fitScoreJson' })
    : {};
  const aiSessionIds = pipeline.rounds.filter((r) => r.conductedBy === 'AI' && r.sessionId).map((r) => r.sessionId as string);
  const assessments = aiSessionIds.length > 0
    ? await prisma.assessmentVersion.findMany({ where: { sessionId: { in: aiSessionIds } }, orderBy: { version: 'desc' }, select: { sessionId: true, recommendation: true } })
    : [];

  const summarise = (stage: PipelineStage): StageSummary => {
    const rounds = pipeline.rounds.filter((r) => r.stageKey === stage.key);
    switch (stage.kind) {
      case 'intake':
        return { ...stage, hasEvidence: true, detail: 'Candidate profile onboarded.' };
      case 'profile_review':
        return typeof fit.overall === 'number'
          ? { ...stage, hasEvidence: true, detail: `AI profile review: job fit ${Math.round(fit.overall)}/100.` }
          : { ...stage, hasEvidence: false, detail: 'No AI profile review yet.' };
      case 'ai_interview': {
        const assessed = assessments.find((a) => rounds.some((r) => r.sessionId === a.sessionId));
        return assessed
          ? { ...stage, hasEvidence: true, detail: `AI interview assessed: ${assessed.recommendation}.` }
          : { ...stage, hasEvidence: false, detail: 'No assessed AI interview yet.' };
      }
      case 'human_interview': {
        const completed = rounds.filter((r) => r.status === 'COMPLETED' && r.notes.trim().length > 0);
        return completed.length > 0
          ? { ...stage, hasEvidence: true, detail: `${completed.length} completed round(s) with recorded evidence.` }
          : { ...stage, hasEvidence: false, detail: 'No completed human round with recorded evidence yet.' };
      }
      default: {
        const unreachable: never = stage.kind;
        throw new Error(`Unknown stage kind: ${String(unreachable)}`);
      }
    }
  };

  const summaries = stages.map(summarise);
  res.json({
    summary: {
      stages: summaries,
      missingEvidence: summaries.filter((s) => !s.hasEvidence).map((s) => s.label),
      note: 'This summary reports only the evidence Questor holds. A person makes the final decision.',
    },
  });
}));

/** Per-role stage plan. Mounted under /api/roles; changes apply to new pipelines only. */
export const rolePipelineRouter = Router();
rolePipelineRouter.use(authenticate);

rolePipelineRouter.put('/:id/pipeline-stages', requireCapability('role:edit_scorecard'), asyncHandler(async (req, res) => {
  const { stages } = z.object({ stages: stagesSchema }).parse(req.body);
  await assertCanAccessRole(req.auth!, req.params.id);
  await prisma.role.update({ where: { id: req.params.id }, data: { pipelineStagesJson: JSON.stringify(stages) } });
  await logAudit({
    tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'role.pipeline_stages_changed', entityType: 'Role', entityId: req.params.id,
    after: { stages: stages.map((s) => s.key) },
  });
  res.json({ stages });
}));

