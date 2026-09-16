import { Router, type Request } from 'express';
import { z } from 'zod';
import type { CandidatePipeline, InterviewRound } from '@prisma/client';
import { prisma, parseJson } from '../db.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import { assertCanAccessCandidate, assertCanAccessRole } from '../services/access.js';
import { logAudit } from '../services/audit.js';
import { OBSERVER_NOTICE, withObserverNotice } from '../services/observerPolicy.js';
import { getEmail } from '../providers/email/index.js';
import { brandedEmail } from '../providers/email/branding.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  DEFAULT_STAGES, nextStageKey, parseStages, roundRolesFor, stagesSchema, type PipelineStage,
} from '../domain/pipelineStages.js';

/**
 * The medallion pipeline: one candidate moving through ordered stages for one
 * role. The stage plan is snapshotted when the pipeline starts, stages run in
 * order, and a person records the outcome — at any stage, once.
 */
export const pipelinesRouter = Router();
pipelinesRouter.use(authenticate);

type PipelineWithRounds = CandidatePipeline & { rounds: InterviewRound[] };

function presentRound(round: InterviewRound) {
  return {
    id: round.id,
    stageKey: round.stageKey,
    conductedBy: round.conductedBy,
    aiObserver: round.aiObserver,
    hrMayObserve: round.hrMayObserve,
    sessionId: round.sessionId,
    interviewers: parseJson<string[]>(round.interviewersJson, []),
    scheduledAt: round.scheduledAt,
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
  };
}

function presentPipeline(pipeline: PipelineWithRounds) {
  return {
    id: pipeline.id,
    candidateId: pipeline.candidateId,
    roleId: pipeline.roleId,
    stages: parseStages(pipeline.stagesJson),
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
async function loadPipeline(req: Request, id: string): Promise<PipelineWithRounds> {
  const pipeline = await prisma.candidatePipeline.findFirst({ where: { id, tenantId: req.auth!.tenantId }, include: withRounds });
  if (!pipeline) throw new HttpError(404, 'Pipeline not found');
  // Pipelines inherit the candidate's scope rather than defining their own.
  await assertCanAccessCandidate(req.auth!, pipeline.candidateId);
  return pipeline;
}

async function reload(id: string): Promise<PipelineWithRounds> {
  return prisma.candidatePipeline.findUniqueOrThrow({ where: { id }, include: withRounds });
}

function labelOf(stages: readonly PipelineStage[], key: string): string {
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

  const stages = parseStages(pipeline.stagesJson);
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
async function notifyScheduler(o: { to: string; stageLabel: string; scheduledAt: Date; link: string; aiRound: boolean }): Promise<SchedulingNotice> {
  const email = getEmail();
  if (!email.delivers) {
    return { delivered: false, link: o.link, deliveryNote: `Email is not configured to deliver (provider "${email.name}"). Use the link here.` };
  }
  const when = o.scheduledAt.toUTCString();
  // Stage labels are configurable, so strip control characters before they
  // reach a subject line or plain-text body, where a line break could forge
  // headers or text. HTML escaping below does not cover these.
  const label = o.stageLabel.replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  const intro = o.aiRound
    ? `The ${label} AI interview is scheduled for ${when}. You can observe it live here:`
    : `The ${label} interview is scheduled for ${when}. The candidate and their pipeline are here:`;
  try {
    await email.send(brandedEmail({
      to: o.to,
      subject: `${label} interview scheduled`,
      text: `${intro}\n${o.link}`,
      html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(o.link)}">${escapeHtml(o.link)}</a></p>`,
    }));
    return { delivered: true, link: o.link, deliveryNote: `Sent to ${o.to}.` };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Round scheduling email failed');
    return { delivered: false, link: o.link, deliveryNote: 'The email could not be sent. Use the link here.' };
  }
}

const roundSchema = z.object({
  stageKey: z.string().min(1),
  scheduledAt: z.string().datetime(),
  sessionId: z.string().min(1).optional(),
  interviewers: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
});

pipelinesRouter.post('/:id/rounds', requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  const body = roundSchema.parse(req.body);
  const tenantId = req.auth!.tenantId;
  const pipeline = await loadPipeline(req, req.params.id);
  if (pipeline.status !== 'ACTIVE') throw new HttpError(409, DECIDED);
  if (body.stageKey !== pipeline.currentStageKey) {
    throw new HttpError(409, 'Rounds are scheduled for the stage the candidate is currently at.');
  }

  const stage = parseStages(pipeline.stagesJson).find((s) => s.key === body.stageKey);
  const roles = stage ? roundRolesFor(stage.kind) : null;
  if (!stage || !roles) throw new HttpError(409, `${stage?.label ?? 'This stage'} is not an interview stage.`);

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
      const consent = parseJson<Record<string, unknown>>(session.consentJson, {});
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

    const created = await tx.interviewRound.create({
      data: {
        tenantId, pipelineId: pipeline.id, stageKey: stage.key,
        conductedBy: roles.conductedBy, aiObserver: roles.aiObserver, hrMayObserve: roles.hrMayObserve,
        sessionId: body.sessionId ?? null, interviewersJson: JSON.stringify(body.interviewers ?? []),
        scheduledAt: new Date(body.scheduledAt), createdById: req.auth!.userId,
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
    after: { roundId: round.id, stage: stage.key, conductedBy: roles.conductedBy, scheduledAt: body.scheduledAt },
  });

  // HR gets the link they need: the live observe page for the AI interview,
  // otherwise the candidate's page, where the pipeline lives.
  const aiRound = round.conductedBy === 'AI' && round.sessionId !== null;
  const link = aiRound
    ? `${config.webOrigin}/interviews/${round.sessionId}/observe`
    : `${config.webOrigin}/candidates/${pipeline.candidateId}`;
  const notification = await notifyScheduler({ to: req.auth!.email, stageLabel: stage.label, scheduledAt: round.scheduledAt, link, aiRound });

  res.status(201).json({ round: presentRound(round), notification });
}));

const completeSchema = z.object({
  notes: z.string().trim().min(20, 'Record what the round showed — this is the evidence for the stage.').max(10000),
});

// Closing a round with what it showed. Until the AI observer can transcribe
// human rounds, these notes are the evidence the summary relies on.
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

  await logAudit({
    tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'pipeline.round_completed', entityType: 'CandidatePipeline', entityId: pipeline.id,
    after: { roundId: round.id, stage: round.stageKey },
  });
  res.json({ round: presentRound(await prisma.interviewRound.findUniqueOrThrow({ where: { id: round.id } })) });
}));

const decisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED', 'WITHDRAWN']),
  reason: z.string().trim().min(10, 'Record why this decision was made.').max(1000),
});

// A person records the outcome. Held to assessment:review, the same capability
// that signs off an assessment, so this cannot become an automated step.
pipelinesRouter.post('/:id/decision', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  const body = decisionSchema.parse(req.body);
  const pipeline = await loadPipeline(req, req.params.id);

  if (pipeline.status !== 'ACTIVE') throw new HttpError(409, DECIDED);

  // Conditional on the stage we read as well as the status: a concurrent
  // advance would otherwise leave the decision recorded against a stage the
  // candidate had already left.
  const decided = await prisma.candidatePipeline.updateMany({
    where: { id: pipeline.id, status: 'ACTIVE', currentStageKey: pipeline.currentStageKey },
    data: {
      status: 'DECIDED', decision: body.decision, decisionReason: body.reason,
      decidedAtStageKey: pipeline.currentStageKey, decidedById: req.auth!.userId, decidedAt: new Date(),
    },
  });
  if (decided.count !== 1) throw new HttpError(409, 'This pipeline changed while you were working on it. Reload and try again.');

  // The reason itself stays on the pipeline, which erasure removes. Audit rows
  // outlive erasure, so they record that a reason was given, not what it said.
  await logAudit({
    tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'pipeline.decided', entityType: 'CandidatePipeline', entityId: pipeline.id,
    after: { decision: body.decision, stage: pipeline.currentStageKey, reasonRecorded: true },
  });
  res.json({ pipeline: presentPipeline(await reload(pipeline.id)) });
}));

interface StageSummary extends PipelineStage {
  readonly hasEvidence: boolean;
  readonly detail: string;
}

// Reports only the evidence Questor actually holds, and names what is missing.
pipelinesRouter.get('/:id/summary', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const pipeline = await loadPipeline(req, req.params.id);
  const stages = parseStages(pipeline.stagesJson);

  const profile = await prisma.candidateProfileVersion.findFirst({
    where: { candidateId: pipeline.candidateId }, orderBy: { version: 'desc' }, select: { fitScoreJson: true },
  });
  const fit = profile ? parseJson<{ overall?: unknown }>(profile.fitScoreJson, {}) : {};
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
