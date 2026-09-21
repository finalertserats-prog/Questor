import { Router, type Request } from 'express';
import { z } from 'zod';
import type { InterviewRound } from '@prisma/client';
import { prisma, parseJsonOptional } from '../db.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import { logAudit } from '../services/audit.js';
import { hasCapability } from '../services/access.js';
import { notifyCandidateOfHumanRound, type CandidateNotice, type RoundNoticeKind } from '../services/roundCandidateNotice.js';
import { parseStages } from '../domain/pipelineStages.js';
import { roundMeetingStatus } from '../providers/meeting/roundMeetings.js';
import {
  cancelMeeting, isStaleCreation, markRoundCancelled, rescheduleMeeting, retryMeeting, setManualLink, MEETING_STATUS,
  type MeetingOutcome, type RoundContext,
} from '../services/roundMeeting.js';
import { labelOf, loadPipeline, presentRound, type PipelineWithRounds } from './pipelines.js';
import { durationSchema, meetingUrlSchema } from './roundMeetingSchemas.js';
import { assertInFuture, resolveScheduleTime, scheduleTimeFields } from './scheduleTime.js';

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
  const status = roundMeetingStatus(parseJsonOptional<Record<string, unknown>>(tenant?.policyJson, {}, { model: 'Tenant', id: req.auth!.tenantId, field: 'policyJson' }));
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

/**
 * Tell the candidate what changed about their round: its new time, or the
 * meeting link it did not have when it was booked. Reads the row again so the
 * email carries what is stored now.
 */
async function tellCandidate(req: Request, pipeline: PipelineWithRounds, roundId: string, stageLabel: string, kind: RoundNoticeKind): Promise<CandidateNotice> {
  if (!hasCapability(req.auth!, 'interview:invite')) {
    return { sent: false, note: 'Your account cannot email candidates, so the candidate was not emailed.' };
  }
  const round = await prisma.interviewRound.findFirstOrThrow({ where: { id: roundId, pipelineId: pipeline.id, tenantId: req.auth!.tenantId } });
  return notifyCandidateOfHumanRound({ round, candidateId: pipeline.candidateId, roleId: pipeline.roleId, stageLabel, kind });
}

const NOT_SCHEDULED = 'This round has already been completed or cancelled.';
// The AI interview's time and availability live on its interview session;
// moving or cancelling only the round would leave the session usable at the old time.
const AI_ROUND = 'The AI interview is managed from the interview itself, not from the round. Reschedule or cancel it on the interview page.';
const BUSY = 'The meeting for this round is being created. Try again in a moment.';

const rescheduleSchema = z.object({
  ...scheduleTimeFields,
  durationMinutes: durationSchema.optional(),
}).strict();

roundMeetingsRouter.post('/:id/rounds/:roundId/reschedule', authenticate, requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  const body = rescheduleSchema.parse(req.body);
  // Moving a round is always forward: unlike booking one, there is no "record
  // a round that already happened" case for a move.
  const booked = resolveScheduleTime(body);
  assertInFuture(booked.at);
  const { pipeline, round, ctx } = await loadRound(req);
  if (round.conductedBy !== 'HUMAN') throw new HttpError(409, AI_ROUND);
  if (pipeline.status !== 'ACTIVE') throw new HttpError(409, 'A decision has already been recorded for this pipeline.');
  if (round.meetingStatus === MEETING_STATUS.CREATING && !isStaleCreation(round)) throw new HttpError(409, BUSY);

  const moved = await prisma.interviewRound.updateMany({
    where: { id: round.id, pipelineId: pipeline.id, status: 'SCHEDULED', meetingStatus: round.meetingStatus },
    data: { scheduledAt: booked.at, scheduledTimeZone: booked.timeZone, ...(body.durationMinutes ? { durationMinutes: body.durationMinutes } : {}) },
  });
  if (moved.count !== 1) throw new HttpError(409, NOT_SCHEDULED);

  await logAudit({
    tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'pipeline.round_rescheduled', entityType: 'CandidatePipeline', entityId: pipeline.id,
    before: { roundId: round.id, scheduledAt: round.scheduledAt.toISOString(), scheduledTimeZone: round.scheduledTimeZone, durationMinutes: round.durationMinutes },
    after: { roundId: round.id, scheduledAt: booked.at.toISOString(), scheduledTimeZone: booked.timeZone, durationMinutes: body.durationMinutes ?? round.durationMinutes },
  });

  const updated = await prisma.interviewRound.findUniqueOrThrow({ where: { id: round.id } });
  const meeting = await rescheduleMeeting(updated, ctx);
  const candidateNotice = await tellCandidate(req, pipeline, round.id, ctx.stageLabel, 'moved');
  res.json({ ...await respond(req, pipeline, round.id, 'reschedule', meeting), candidateNotice });
}));

roundMeetingsRouter.post('/:id/rounds/:roundId/cancel', authenticate, requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  const { pipeline, round } = await loadRound(req);
  if (round.conductedBy !== 'HUMAN') throw new HttpError(409, AI_ROUND);

  if (!(await markRoundCancelled(round.id, pipeline.id))) throw new HttpError(409, NOT_SCHEDULED);

  await logAudit({
    tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'pipeline.round_cancelled', entityType: 'CandidatePipeline', entityId: pipeline.id,
    after: { roundId: round.id, stage: round.stageKey },
  });

  // Reads the row again so a creation that finished in the meantime is seen.
  const current = await prisma.interviewRound.findUniqueOrThrow({ where: { id: round.id } });
  const meeting = await cancelMeeting(current);
  res.json(await respond(req, pipeline, round.id, 'cancel', meeting));
}));

roundMeetingsRouter.post('/:id/rounds/:roundId/meeting/retry', authenticate, requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  const { pipeline, round, ctx } = await loadRound(req);
  if (round.conductedBy !== 'HUMAN') throw new HttpError(409, 'The AI interview runs in the Questor room; it has no external meeting.');
  const result = await retryMeeting(round, ctx, req.auth!.tenantId);
  if (result.kind === 'conflict') throw new HttpError(409, result.message);
  // A link that exists only now (the first creation failed) has not reached the candidate yet.
  const newLink = result.outcome?.ok && result.outcome.url && result.outcome.url !== round.meetingUrl && round.status === 'SCHEDULED';
  const candidateNotice = newLink ? await tellCandidate(req, pipeline, round.id, ctx.stageLabel, 'link') : undefined;
  res.json({ ...await respond(req, pipeline, round.id, 'retry', result.outcome), ...(candidateNotice ? { candidateNotice } : {}) });
}));

roundMeetingsRouter.put('/:id/rounds/:roundId/meeting-link', authenticate, requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  const { url } = z.object({ url: meetingUrlSchema }).strict().parse(req.body);
  const { pipeline, round, ctx } = await loadRound(req);
  if (round.conductedBy !== 'HUMAN') throw new HttpError(409, 'The AI interview runs in the Questor room; it takes no meeting link.');
  if (round.status !== 'SCHEDULED') throw new HttpError(409, NOT_SCHEDULED);
  if (round.meetingExternalId) {
    throw new HttpError(409, 'This round already has a meeting created by the meeting provider. Cancel the round and schedule it again to use a different link.');
  }
  if (!(await setManualLink(round, url))) throw new HttpError(409, BUSY);
  const meeting: MeetingOutcome = { ok: true, provider: 'manual', status: MEETING_STATUS.MANUAL, url, message: 'Meeting link saved.' };
  const candidateNotice = url !== round.meetingUrl ? await tellCandidate(req, pipeline, round.id, ctx.stageLabel, 'link') : undefined;
  res.json({ ...await respond(req, pipeline, round.id, 'manual_link', meeting), ...(candidateNotice ? { candidateNotice } : {}) });
}));
