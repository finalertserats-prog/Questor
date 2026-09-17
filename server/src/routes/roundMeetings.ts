import { Router, type Request } from 'express';
import { z } from 'zod';
import type { InterviewRound } from '@prisma/client';
import { prisma, parseJson } from '../db.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import { logAudit } from '../services/audit.js';
import { parseStages } from '../domain/pipelineStages.js';
import { roundMeetingStatus } from '../providers/meeting/roundMeetings.js';
import {
  cancelMeeting, isStaleCreation, rescheduleMeeting, retryMeeting, setManualLink, MEETING_STATUS,
  type MeetingOutcome, type RoundContext,
} from '../services/roundMeeting.js';
import { labelOf, loadPipeline, presentRound, type PipelineWithRounds } from './pipelines.js';
import { durationSchema, meetingUrlSchema } from './roundMeetingSchemas.js';

/**
 * Moving, cancelling and linking an interview round's meeting. Mounted under
 * /api/pipelines ahead of the pipelines router. Every route inherits the
 * pipeline's tenant and candidate scope through loadPipeline.
 */
export const roundMeetingsRouter = Router();
// Authenticated per route, not router-wide: this router sits in front of the
// pipelines router, and a router-level guard would run (and hit the database)
// a second time for every pipeline request passing through.

// Which provider will create links for this organisation's human rounds. Names
// and readiness only — never a credential, never which variables are missing.
roundMeetingsRouter.get('/meeting-provider', authenticate, requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId }, select: { policyJson: true } });
  const status = roundMeetingStatus(parseJson<Record<string, unknown>>(tenant?.policyJson ?? '{}', {}));
  res.json({ meetingProvider: { provider: status.provider, label: status.label, configured: status.configured } });
}));

async function loadRound(req: Request): Promise<{ pipeline: PipelineWithRounds; round: InterviewRound; ctx: RoundContext }> {
  const pipeline = await loadPipeline(req, req.params.id);
  const round = pipeline.rounds.find((r) => r.id === req.params.roundId);
  if (!round) throw new HttpError(404, 'Round not found');
  const ctx = { stageLabel: labelOf(parseStages(pipeline.stagesJson), round.stageKey), candidateId: pipeline.candidateId };
  return { pipeline, round, ctx };
}

async function respond(req: Request, pipeline: PipelineWithRounds, roundId: string, operation: string, meeting: MeetingOutcome | null) {
  if (meeting) {
    // Provider and resulting status only: the link and any message stay out of the audit trail.
    await logAudit({
      tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
      action: 'pipeline.round_meeting', entityType: 'CandidatePipeline', entityId: pipeline.id,
      after: { roundId, operation, provider: meeting.provider, status: meeting.status },
    });
  }
  const round = await prisma.interviewRound.findUniqueOrThrow({ where: { id: roundId } });
  return { round: presentRound(round), meeting };
}

const NOT_SCHEDULED = 'This round has already been completed or cancelled.';
const BUSY = 'The meeting for this round is being created. Try again in a moment.';

const rescheduleSchema = z.object({
  scheduledAt: z.string().datetime({ offset: true }),
  durationMinutes: durationSchema.optional(),
}).strict();

roundMeetingsRouter.post('/:id/rounds/:roundId/reschedule', authenticate, requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  const body = rescheduleSchema.parse(req.body);
  const { pipeline, round, ctx } = await loadRound(req);
  if (pipeline.status !== 'ACTIVE') throw new HttpError(409, 'A decision has already been recorded for this pipeline.');
  if (round.meetingStatus === MEETING_STATUS.CREATING && !isStaleCreation(round)) throw new HttpError(409, BUSY);

  const moved = await prisma.interviewRound.updateMany({
    where: { id: round.id, pipelineId: pipeline.id, status: 'SCHEDULED', meetingStatus: round.meetingStatus },
    data: { scheduledAt: new Date(body.scheduledAt), ...(body.durationMinutes ? { durationMinutes: body.durationMinutes } : {}) },
  });
  if (moved.count !== 1) throw new HttpError(409, NOT_SCHEDULED);

  await logAudit({
    tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'pipeline.round_rescheduled', entityType: 'CandidatePipeline', entityId: pipeline.id,
    before: { roundId: round.id, scheduledAt: round.scheduledAt.toISOString(), durationMinutes: round.durationMinutes },
    after: { roundId: round.id, scheduledAt: body.scheduledAt, durationMinutes: body.durationMinutes ?? round.durationMinutes },
  });

  const updated = await prisma.interviewRound.findUniqueOrThrow({ where: { id: round.id } });
  const meeting = updated.conductedBy === 'HUMAN' ? await rescheduleMeeting(updated, ctx) : null;
  res.json(await respond(req, pipeline, round.id, 'reschedule', meeting));
}));

roundMeetingsRouter.post('/:id/rounds/:roundId/cancel', authenticate, requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  const { pipeline, round } = await loadRound(req);

  const cancelled = await prisma.interviewRound.updateMany({
    where: { id: round.id, pipelineId: pipeline.id, status: 'SCHEDULED' },
    data: { status: 'CANCELLED' },
  });
  if (cancelled.count !== 1) throw new HttpError(409, NOT_SCHEDULED);

  await logAudit({
    tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'pipeline.round_cancelled', entityType: 'CandidatePipeline', entityId: pipeline.id,
    after: { roundId: round.id, stage: round.stageKey },
  });

  // Reads the row again so a creation that finished in the meantime is seen.
  const current = await prisma.interviewRound.findUniqueOrThrow({ where: { id: round.id } });
  const meeting = current.conductedBy === 'HUMAN' ? await cancelMeeting(current) : null;
  res.json(await respond(req, pipeline, round.id, 'cancel', meeting));
}));

roundMeetingsRouter.post('/:id/rounds/:roundId/meeting/retry', authenticate, requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  const { pipeline, round, ctx } = await loadRound(req);
  if (round.conductedBy !== 'HUMAN') throw new HttpError(409, 'The AI interview runs in the Questor room; it has no external meeting.');
  const result = await retryMeeting(round, ctx, req.auth!.tenantId);
  if (result.kind === 'conflict') throw new HttpError(409, result.message);
  res.json(await respond(req, pipeline, round.id, 'retry', result.outcome));
}));

roundMeetingsRouter.put('/:id/rounds/:roundId/meeting-link', authenticate, requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  const { url } = z.object({ url: meetingUrlSchema }).strict().parse(req.body);
  const { pipeline, round } = await loadRound(req);
  if (round.conductedBy !== 'HUMAN') throw new HttpError(409, 'The AI interview runs in the Questor room; it takes no meeting link.');
  if (round.status !== 'SCHEDULED') throw new HttpError(409, NOT_SCHEDULED);
  if (round.meetingExternalId) {
    throw new HttpError(409, 'This round already has a meeting created by the meeting provider. Cancel the round and schedule it again to use a different link.');
  }
  if (!(await setManualLink(round, url))) throw new HttpError(409, BUSY);
  const meeting: MeetingOutcome = { ok: true, provider: 'manual', status: MEETING_STATUS.MANUAL, url, message: 'Meeting link saved.' };
  res.json(await respond(req, pipeline, round.id, 'manual_link', meeting));
}));
