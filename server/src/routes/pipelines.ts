import { Router, type Request } from 'express';
import { z } from 'zod';
import type { CandidatePipeline, InterviewRound, Prisma } from '@prisma/client';
import { prisma, parseJsonOptional, parseJsonStrict } from '../db.js';
import { asyncHandler, authenticate, requireAnyCapability, requireCapability, HttpError } from '../middleware/index.js';
import {
  assignCandidate, assertCanAccessCandidate, assertCanAccessRole, capabilitiesOf, hasCapability,
} from '../services/access.js';
import { aiConclusionVisible } from '../services/shadowMode.js';
import { notifyCandidateOfHumanRound, type CandidateNotice } from '../services/roundCandidateNotice.js';
import { notifyRoundInterviewers } from '../services/roundInterviewerNotice.js';
import { sendInterviewSchedule, writeSessionSchedule } from './interviews.js';
import { logAudit } from '../services/audit.js';
import { OBSERVER_NOTICE, withObserverNotice } from '../services/observerPolicy.js';
import { endObservation } from '../services/roundObserver.js';
import { extractEvidenceQuotes } from '../services/observerQuotes.js';
import { getEmail } from '../providers/email/index.js';
import { brandedEmail, headerSafe } from '../providers/email/branding.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { FIT_PROVISIONAL_SHORT } from '../domain/fitVocabulary.js';
import { formatScheduledTime } from '../services/zonedTime.js';
import { tenantTimeZone } from '../services/tenantTimeZone.js';
import { resolveScheduleTime, scheduleTimeFields } from './scheduleTime.js';
import {
  DEFAULT_STAGES, nextStageKey, parseStages, parseStagesStrict, roundRolesFor, roundRolesForConductor,
  ROUND_CONDUCTORS, stagesSchema, type PipelineStage, type RoundConductor,
} from '../domain/pipelineStages.js';
import {
  checkEvidenceEntries, evidenceKindOf, evidenceView, parseEvidenceEntries, peerNotesWereVisible, peerQuarantine,
  MAX_ENTRY_CHARS, MAX_EVIDENCE_ENTRIES, type QuarantineInput,
} from '../domain/roundEvidence.js';
import {
  ENTRY_NOTICE_VERSION, blockOfRound, captureReport,
  type ObservationStatus, type RoundSnapshot,
} from '../domain/observedRound.js';
import { invitationSecretColumns, mintInvitationToken } from '../services/invitations.js';
import { scorecardForFit } from '../services/scorecards.js';
import { DECISION_OUTCOMES, resolveTransition } from '../domain/pipelineAutonomy.js';
import { decidePipeline } from '../services/pipelineAutonomy.js';
import { awardOnPromotion, isAwardConflict, noteAwards, type StruckAward } from '../services/candidateAwards.js';
import { humanReviewCheck } from '../services/humanReviewGate.js';
import { candidateOwnZone } from '../services/scheduleZone.js';
import { humanReviewRefusal, HUMAN_REVIEW_REQUIRED } from '../domain/humanReviewRule.js';
import {
  createMeeting, initialMeetingFields, isStaleCreation, tenantMeetingProvider, MEETING_STATUS, type MeetingOutcome,
} from '../services/roundMeeting.js';
import { meetingUrlSchema, durationSchema } from './roundMeetingSchemas.js';
import { LATEST_PROFILE } from '../services/resumeProfile.js';

/**
 * The medallion pipeline: one candidate moving through ordered stages for one
 * role. The stage plan is snapshotted when the pipeline starts, stages run in
 * order, and a person records the outcome — at any stage, once.
 */
export const pipelinesRouter = Router();
pipelinesRouter.use(authenticate);

/** A round with everything a reader needs: who is seated on it, and what it captured. */
export const roundInclude = {
  panel: { orderBy: { createdAt: 'asc' as const }, include: { user: { select: { id: true, name: true } } } },
  observation: {
    select: {
      status: true, captureStatus: true, oneSided: true,
      withdrawnReason: true, stoppedBy: true, declinedBy: true,
      // SPEECH only. A gap is a stretch the observer could NOT capture, so a
      // round whose every segment is a gap has captured nothing — counting
      // those would let it report as a transcript of a conversation none of
      // which was heard.
      _count: { select: { segments: { where: { kind: 'SPEECH' } } } },
      participants: { select: { party: true, personId: true, consentAt: true, declinedAt: true, admittedAt: true } },
    },
  },
};

export type RoundRow = InterviewRound & {
  panel: Array<{ userId: string; seat: string; user: { id: string; name: string } }>;
  observation: {
    status: string;
    captureStatus: string;
    oneSided: boolean;
    withdrawnReason: string;
    stoppedBy: string | null;
    declinedBy: string | null;
    _count: { segments: number };
    participants: Array<{
      party: string; personId: string;
      consentAt: Date | null; declinedAt: Date | null; admittedAt: Date | null;
    }>;
  } | null;
};

export type PipelineWithRounds = CandidatePipeline & { rounds: RoundRow[] };

/**
 * Who is reading, and what else is on this candidate's pipeline. Both are
 * needed to answer the peer-quarantine question (domain/roundEvidence.ts),
 * which cannot be decided from one round in isolation.
 */
export interface RoundViewer {
  readonly userId: string;
  readonly decides: boolean;
  readonly pipeline: { readonly status: string; readonly currentStageKey: string };
  readonly rounds: QuarantineInput['rounds'];
  /** Names of everyone a round on this pipeline names, by user id. */
  readonly names: Readonly<Record<string, string>>;
}

export async function roundViewer(req: Request, pipeline: PipelineWithRounds): Promise<RoundViewer> {
  // The person who wrote a round's record is often not seated on it — a
  // recruiter closes the round the SME conducted — so their name cannot be read
  // off the panel. Resolved once for the whole pipeline rather than per round.
  const recorders = pipeline.rounds.map((r) => r.recordedByUserId).filter((id): id is string => id !== null);
  const users = recorders.length > 0
    ? await prisma.user.findMany({ where: { id: { in: recorders }, tenantId: pipeline.tenantId }, select: { id: true, name: true } })
    : [];
  const names: Record<string, string> = {};
  for (const round of pipeline.rounds) for (const seat of round.panel) names[seat.userId] = seat.user.name;
  for (const user of users) names[user.id] = user.name;
  return {
    userId: req.auth!.userId,
    decides: hasCapability(req.auth!, 'assessment:review'),
    pipeline: { status: pipeline.status, currentStageKey: pipeline.currentStageKey },
    rounds: pipeline.rounds.map((r) => ({
      id: r.id, stageKey: r.stageKey, conductedBy: r.conductedBy,
      panelUserIds: r.panel.map((p) => p.userId), hasNotes: r.notes.trim().length > 0,
    })),
    names,
  };
}

/** The round as the shared "why can this not go ahead" reader wants it. */
function observedSnapshot(round: RoundRow): RoundSnapshot {
  return {
    roundStatus: round.status,
    seats: round.panel.map((seat) => seat.userId),
    observation: round.observation ? { ...round.observation, speechCount: round.observation._count.segments } : null,
  };
}

export function presentRound(round: RoundRow, viewer: RoundViewer) {
  const quarantine = peerQuarantine({
    round: { id: round.id, stageKey: round.stageKey, conductedBy: round.conductedBy },
    viewerUserId: viewer.userId, viewerDecides: viewer.decides, rounds: viewer.rounds, pipeline: viewer.pipeline,
  });
  // Computed from what the round actually holds, never from what this reader is
  // allowed to see: a round whose record is quarantined has still been recorded,
  // and saying otherwise to a colleague would be a lie about the process rather
  // than a protection of it.
  const entries = parseEvidenceEntries(parseJsonOptional<unknown>(round.evidenceJson, [], { model: 'InterviewRound', id: round.id, field: 'evidenceJson' }));
  const evidence = evidenceView(evidenceKindOf({
    notes: round.notes,
    structuredCount: entries.length,
    observationStatus: round.observation?.status ?? null,
    segmentCount: round.observation?._count.segments ?? 0,
    // A recording that heard one voice is not a transcript, whatever it
    // contains (domain/roundEvidence.ts).
    oneSided: round.observation?.oneSided ?? false,
  }));
  return {
    id: round.id,
    stageKey: round.stageKey,
    conductedBy: round.conductedBy,
    aiObserver: round.aiObserver,
    hrMayObserve: round.hrMayObserve,
    sessionId: round.sessionId,
    interviewers: parseJsonOptional<string[]>(round.interviewersJson, [], { model: 'InterviewRound', id: round.id, field: 'interviewersJson' }),
    // The Questor users conducting it. Separate from `interviewers` above,
    // which is typed names and may hold an external panellist with no account.
    panel: round.panel.map((seat) => ({ userId: seat.userId, name: seat.user.name, seat: seat.seat })),
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
    //
    // One reader is held back: another interviewer on this candidate at this
    // same stage, until the team has decided. They are there to form a second
    // opinion, and an opinion formed after reading the first is not one.
    notes: quarantine.withheld ? '' : round.notes,
    // The structured record travels with the prose and is withheld with it:
    // a peer who could read the claims and quotes would be anchored by exactly
    // the part of the record that is meant to persuade.
    evidenceEntries: quarantine.withheld ? [] : entries,
    // Why both are empty, so a withheld round never reads as a round that
    // showed nothing. '' whenever nothing is being withheld.
    notesWithheld: quarantine.reason,
    evidence,
    // Why this round cannot go ahead, when it cannot. Same discipline as
    // `notesWithheld` above: a round nobody may enter must never read like a
    // round nobody got round to booking, so it carries a sentence and what can
    // be done next rather than a status the page would have to interpret.
    observerBlocked: blockOfRound(observedSnapshot(round)),
    // What the recording got, once the round is over: everything, some of it,
    // one voice, or nothing. A fact about the recording, said to HR in the same
    // register as a round that could not go ahead.
    captureReport: round.observation
      ? captureReport({
        status: round.observation.status as ObservationStatus,
        speechCount: round.observation._count.segments,
        captureStatus: round.observation.captureStatus,
        oneSided: round.observation.oneSided,
      })
      : null,
    // Who wrote the record, for a certificate that would otherwise have to say
    // "the hiring team". Null on a round closed before the author was stored.
    recordedBy: round.recordedByUserId
      ? { userId: round.recordedByUserId, name: viewer.names[round.recordedByUserId] ?? '' }
      : null,
    // Whether a peer round's record was readable when this one was written.
    // Null means the round predates the record; see roundEvidence.ts.
    peerNotesSeenBefore: round.peerNotesSeenBefore,
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

function presentPipeline(pipeline: PipelineWithRounds, viewer: RoundViewer) {
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
    rounds: pipeline.rounds.map((round) => presentRound(round, viewer)),
    createdAt: pipeline.createdAt,
    updatedAt: pipeline.updatedAt,
  };
}

const withRounds = { rounds: { orderBy: { scheduledAt: 'asc' as const }, include: roundInclude } };

/** A pipeline in the caller's organisation AND object scope; 404 otherwise. */
export async function loadPipeline(req: Request, id: string): Promise<PipelineWithRounds> {
  const pipeline = await prisma.candidatePipeline.findFirst({ where: { id, tenantId: req.auth!.tenantId }, include: withRounds });
  if (!pipeline) throw new HttpError(404, 'Pipeline not found');
  // Pipelines inherit the candidate's scope rather than defining their own.
  await assertCanAccessCandidate(req.auth!, pipeline.candidateId);
  return pipeline;
}

/**
 * The two capabilities that reach a round's own endpoints: the ordinary one,
 * and the subject-matter expert's. An expert holds neither `candidate:read` nor
 * `interview:schedule` by design, so naming only the first would leave the
 * person who actually conducted the round unable to record what they saw.
 */
const MAY_REACH_A_ROUND = requireAnyCapability('candidate:read', 'sme:assigned_read');

/**
 * A pipeline this caller may work with, reached EITHER the ordinary way — they
 * are entitled to the candidate — OR because they are seated on one of its
 * rounds.
 *
 * The seat is the narrower and more accurate fact, and it is deliberately not
 * expressed as a candidate assignment. `CandidateAssignment` rows outlive a
 * role change, so a grant minted here would still be sitting there on the day
 * an expert's account was re-roled to recruiter, silently handing them the full
 * candidate scope over someone they had only been asked to advise on — the
 * hazard services/access.ts `assignedCandidateIds` documents and excludes the
 * `sme` relation to avoid. A seat cannot widen like that: nothing but this
 * round reads it, and it disappears with the round.
 */
async function loadPipelineForPanel(req: Request, id: string): Promise<PipelineWithRounds> {
  const pipeline = await prisma.candidatePipeline.findFirst({
    where: { id, tenantId: req.auth!.tenantId }, include: withRounds,
  });
  if (!pipeline) throw new HttpError(404, 'Pipeline not found');
  const seated = pipeline.rounds.some((round) => round.panel.some((seat) => seat.userId === req.auth!.userId));
  // Not seated: the ordinary scope check, and its 404, apply unchanged.
  if (!seated) await assertCanAccessCandidate(req.auth!, pipeline.candidateId);
  return pipeline;
}

async function reload(id: string): Promise<PipelineWithRounds> {
  return prisma.candidatePipeline.findUniqueOrThrow({ where: { id }, include: withRounds });
}

export function labelOf(stages: readonly PipelineStage[], key: string): string {
  return stages.find((stage) => stage.key === key)?.label ?? key;
}

const DECIDED = 'A decision has already been recorded for this pipeline.';

/**
 * What a move reports about the badges it struck. The verification token is
 * never here: it is the key to a public page, and this response travels to
 * every screen that moves a candidate.
 */
function presentAward(award: StruckAward) {
  return { tier: award.tier, reference: award.reference };
}

const MOVED_UNDER_YOU = 'This pipeline changed while you were working on it. Reload and try again.';

/**
 * Run a move and the badges it earns as one transaction, and answer a tier
 * that was struck by someone else in the meantime as the contention it is.
 * Without this the person who lost the race is shown a 500 for a pipeline that
 * is in a perfectly good state.
 */
async function moveAndAward(run: (tx: Prisma.TransactionClient) => Promise<StruckAward[]>): Promise<StruckAward[]> {
  try {
    return await prisma.$transaction(run);
  } catch (err) {
    if (isAwardConflict(err)) throw new HttpError(409, MOVED_UNDER_YOU);
    throw err;
  }
}

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
  res.status(201).json({ pipeline: presentPipeline(pipeline, await roundViewer(req, pipeline)) });
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
  const presented = await Promise.all(pipelines.map(async (p) => presentPipeline(p, await roundViewer(req, p))));
  res.json({ pipelines: presented });
}));

/**
 * The colleagues who can be named to conduct a round.
 *
 * A denylist rather than an allowlist, deliberately. The SME role is being
 * added in its own lane; an allowlist built from the roles that exist today
 * would silently omit it, and the first SME booked would be refused by a rule
 * nobody remembered writing. Only the auditor is excluded, because compliance
 * is defined as seeing that things happened rather than seeing candidates.
 */
pipelinesRouter.get('/interviewers', requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  const users = await prisma.user.findMany({
    where: { tenantId: req.auth!.tenantId, role: { not: 'auditor' } },
    orderBy: { name: 'asc' },
    // Names and roles only: nothing here needs an email address, and a staff
    // directory is not what booking an interview asked for.
    select: { id: true, name: true, role: true },
  });
  res.json({ interviewers: users });
}));

pipelinesRouter.get('/:id', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const pipeline = await loadPipeline(req, req.params.id);
  res.json({ pipeline: presentPipeline(pipeline, await roundViewer(req, pipeline)) });
}));

pipelinesRouter.post('/:id/advance', requireCapability('interview:create'), asyncHandler(async (req, res) => {
  const { toStageKey } = z.object({ toStageKey: z.string().min(1) }).parse(req.body);
  const pipeline = await loadPipeline(req, req.params.id);
  if (pipeline.status !== 'ACTIVE') throw new HttpError(409, DECIDED);

  const stages = parseStagesStrict(pipeline.stagesJson, { model: 'CandidatePipeline', id: pipeline.id, field: 'stagesJson' });
  const next = nextStageKey(stages, pipeline.currentStageKey);
  if (!next) throw new HttpError(409, 'This candidate is already at the final stage.');
  if (toStageKey !== next) throw new HttpError(409, `Stages run in order; the next stage is ${labelOf(stages, next)}.`);

  // The move and the badges it earns commit together or not at all. A journey
  // showing a candidate at Gold with no Silver badge, or a Silver badge for a
  // move that rolled back, is a record that contradicts itself with nothing to
  // say which half is right.
  const awards = await moveAndAward(async (tx) => {
    // Conditional on the stage we read, so two people advancing at once cannot both succeed.
    const moved = await tx.candidatePipeline.updateMany({
      where: { id: pipeline.id, status: 'ACTIVE', currentStageKey: pipeline.currentStageKey },
      data: { currentStageKey: next },
    });
    if (moved.count !== 1) throw new HttpError(409, MOVED_UNDER_YOU);
    return awardOnPromotion(tx, {
      tenantId: req.auth!.tenantId, candidateId: pipeline.candidateId, roleId: pipeline.roleId,
      stages, fromStageKey: pipeline.currentStageKey, toStageKey: next, actorId: req.auth!.userId,
    });
  });

  await logAudit({
    tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'pipeline.advanced', entityType: 'CandidatePipeline', entityId: pipeline.id,
    // What this move struck is not repeated here: each badge writes its own
    // award.struck event, with the reference a holder would quote. Two records
    // of one fact is two things to keep in step.
    before: { stage: pipeline.currentStageKey }, after: { stage: next },
  });
  await noteAwards({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, candidateId: pipeline.candidateId, awards });
  const fresh = await reload(pipeline.id);
  res.json({ pipeline: presentPipeline(fresh, await roundViewer(req, fresh)), awards: awards.map(presentAward) });
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
    round, candidateId: o.pipeline.candidateId, roleId: o.pipeline.roleId, stageLabel: o.stageLabel,
    reason: { of: 'first', kind: 'booked' },
  });
}

/**
 * The colleagues named to conduct a round, checked against this organisation.
 *
 * Every id has to resolve, and resolve inside the tenant. A silently dropped id
 * would leave a round whose record nobody can be held to — the failure the
 * certificate's "Interviewed by" line exists to prevent — and would do it
 * without telling the person who booked it.
 */
async function resolvePanel(tenantId: string, userIds: readonly string[]) {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return [];
  const users = await prisma.user.findMany({ where: { id: { in: unique }, tenantId }, select: { id: true, role: true } });
  const found = new Map(users.map((u) => [u.id, u.role]));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new HttpError(400, `${missing.length === 1 ? 'One of the people' : 'Some of the people'} named to conduct this round is not a colleague in your organisation.`);
  }
  // The first person named leads, and the lead is the name a certificate
  // prints. Order is the booker's stated intent, so it is kept rather than
  // re-derived from a seniority the system does not know about.
  return unique.map((userId, index) => ({
    userId,
    seat: index === 0 ? 'lead' : 'panel',
    // Whether a candidate assignment would mean anything to them. An expert
    // holds no capability that a candidate-scoped route is gated on, so a row
    // minted for them grants nothing today and becomes a real grant the day
    // their account is re-roled — see loadPipelineForPanel.
    scoped: capabilitiesOf(found.get(userId) ?? '').includes('candidate:read'),
  }));
}

const roundSchema = z.object({
  stageKey: z.string().min(1),
  // A date, time and zone, or the older offset-aware instant (see
  // scheduleTime.ts). Deliberately NOT limited to the future: a round that
  // already happened is recorded here too, notes and all.
  ...scheduleTimeFields,
  sessionId: z.string().min(1).optional(),
  interviewers: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
  // The colleagues conducting it, as Questor users. Separate from the typed
  // names above so an external panellist can still be named without an account,
  // and so the certificate has an id rather than a string to attribute to.
  interviewerUserIds: z.array(z.string().trim().min(1).max(64)).max(10).optional(),
  // Which conductor the team wants. Omitted, the stage's own kind decides, so
  // every caller written before Silver could hold a human round keeps booking
  // exactly what it booked before.
  conductedBy: z.enum(ROUND_CONDUCTORS).optional(),
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
  if (!stage) throw new HttpError(409, 'This stage is not an interview stage.');
  // The conductor the caller asked for, else whoever the stage implies.
  const conductor: RoundConductor = body.conductedBy ?? roundRolesFor(stage.kind)?.conductedBy ?? 'HUMAN';
  const roles = roundRolesForConductor(stage.kind, conductor);
  if (!roles) {
    throw new HttpError(409, conductor === 'AI'
      ? `${stage.label} is conducted by a person; the AI does not run it.`
      : `${stage.label} is not an interview stage.`);
  }
  const humanRound = roles.conductedBy === 'HUMAN';
  if (body.meetingUrl && !humanRound) throw new HttpError(400, 'The AI interview runs in the Questor room; it takes no meeting link.');
  const meetingFields = humanRound ? initialMeetingFields(await tenantMeetingProvider(tenantId), body.meetingUrl) : {};

  // Resolved before anything is written: a round booked with an interviewer who
  // turns out not to exist would otherwise sit in the pipeline attributed to
  // nobody, and the person who booked it would have been told it was fine.
  const panel = await resolvePanel(tenantId, body.interviewerUserIds ?? []);

  if (body.sessionId) {
    const session = await prisma.interviewSession.findFirst({
      where: { id: body.sessionId, tenantId, candidateId: pipeline.candidateId }, select: { id: true },
    });
    if (!session) throw new HttpError(404, 'Interview session not found for this candidate.');
  }

  // Re-check the pipeline inside the same transaction as the insert. Checking
  // it only on load left a gap in which a concurrent decision or advance could
  // land, producing a round after a decision or for a stage already left.
  const { round, noticeAdded, rebookedFrom } = await prisma.$transaction(async (tx) => {
    let noticeAdded = false;
    let rebookedFrom: string | null = null;
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
    // leaves a held interview's record alone. The move follows the interview's
    // own schedule route: a no-show is rebooked, and an interview that can no
    // longer be scheduled refuses the round, rather than leaving a round (and
    // an email to the candidate) at a time the interview does not hold.
    if (!humanRound && body.sessionId && booked.at.getTime() > Date.now()) {
      const session = await tx.interviewSession.findFirstOrThrow({ where: { id: body.sessionId, tenantId }, select: { id: true, state: true } });
      const { saved, rebooking } = await writeSessionSchedule(tx, session, booked.at, booked.timeZone);
      if (!saved) {
        throw new HttpError(409, `This interview is ${session.state}, so it can no longer be scheduled. Create a new interview for this candidate, then book the round with it.`);
      }
      if (rebooking) rebookedFrom = session.state;
    }

    const created = await tx.interviewRound.create({
      data: {
        tenantId, pipelineId: pipeline.id, stageKey: stage.key,
        conductedBy: roles.conductedBy, aiObserver: roles.aiObserver, hrMayObserve: roles.hrMayObserve,
        sessionId: body.sessionId ?? null, interviewersJson: JSON.stringify(body.interviewers ?? []),
        scheduledAt: booked.at, scheduledTimeZone: booked.timeZone, createdById: req.auth!.userId,
        // Where the candidate was when this time was chosen, which is not the
        // zone it was booked in: a Bengaluru recruiter booking a Berlin
        // candidate produces two, and only this one answers "their time".
        // Pinned here rather than read later, because Candidate.timeZone is
        // what HR believes today and a past round must keep meaning the
        // instant it always meant.
        candidateTimeZone: await candidateOwnZone(tenantId, pipeline.candidateId),
        ...(body.durationMinutes ? { durationMinutes: body.durationMinutes } : {}),
        ...meetingFields,
      },
    });
    // Seated in the same transaction as the round: a round that exists with
    // nobody on it, because the second insert failed, is a round that quietly
    // lost its interviewer.
    if (panel.length > 0) {
      await tx.roundInterviewer.createMany({
        data: panel.map((seat) => ({ tenantId, roundId: created.id, userId: seat.userId, seat: seat.seat })),
      });
      // Booking a colleague who works in candidate scope gives them the
      // candidate, so they can find the round on the candidate's page.
      //
      // An expert gets no such row. Their seat already reaches everything this
      // lane offers them (loadPipelineForPanel), the row would grant nothing
      // they can currently use, and it would outlive a later role change as a
      // silent claim on a named person. What they see of the candidate arrives
      // through /api/sme, which has its own assignment and its own capability.
      for (const seat of panel.filter((s) => s.scoped)) {
        await assignCandidate(pipeline.candidateId, seat.userId, 'interviewer', tx);
      }
    }
    // Every human round is observed, so the observation is booked with the
    // round rather than started by a press later. In the same transaction for
    // the same reason the seats are: a human round without one is a round
    // whose people have nothing to agree to and which therefore cannot run.
    //
    // It starts at AWAITING_CONSENT with a row per person and no consent on
    // any of them, so creating it captures nothing — it only opens the gate
    // for everybody to pass.
    if (roles.conductedBy === 'HUMAN' && roles.aiObserver) {
      const entry = mintInvitationToken();
      const secrets = invitationSecretColumns(entry);
      await tx.roundObservation.create({
        data: {
          tenantId, roundId: created.id, candidateId: pipeline.candidateId, noticeVersion: ENTRY_NOTICE_VERSION,
          interviewerId: panel[0]?.userId ?? '',
          candidateTokenHash: secrets.tokenHash, candidateTokenSealed: secrets.tokenSealed,
          participants: {
            create: [
              { tenantId, party: 'candidate', personId: pipeline.candidateId, noticeVersion: ENTRY_NOTICE_VERSION },
              ...panel.map((seat) => ({ tenantId, party: 'interviewer', personId: seat.userId, noticeVersion: ENTRY_NOTICE_VERSION })),
            ],
          },
        },
      });
    }
    return { round: created, noticeAdded, rebookedFrom };
  });

  // Rebooking changed the interview's state as well as its time; recorded as
  // the interview's schedule route records it.
  if (rebookedFrom && body.sessionId) {
    await logAudit({
      tenantId, actorType: 'user', actorId: req.auth!.userId,
      action: 'interview.scheduled', entityType: 'InterviewSession', entityId: body.sessionId,
      after: { scheduledAt: booked.at.toISOString(), scheduledTimeZone: booked.timeZone, from: rebookedFrom, to: 'RESCHEDULE_REQUIRED', pipelineId: pipeline.id },
    });
  }

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
    after: {
      roundId: round.id, stage: stage.key, conductedBy: roles.conductedBy,
      scheduledAt: booked.at.toISOString(), scheduledTimeZone: booked.timeZone,
      // Who was seated, and separately who the booking granted the candidate
      // to. An access grant that leaves no trace is not one anybody can review,
      // and the two lists differ whenever an expert is in the room.
      interviewerUserIds: panel.map((seat) => seat.userId),
      grantedCandidateTo: panel.filter((seat) => seat.scoped).map((seat) => seat.userId),
    },
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
  // A booker who seated themselves gets ONE letter, and it is the
  // interviewer's. Both are true and they answer different questions, but the
  // booker's is a receipt for a button they just pressed and watched respond,
  // while the interviewer's is the one they will go looking for on the morning
  // of the round — it carries the time, the zone and the meeting link. Two
  // emails for one click reads as a bug, so the receipt is the one that yields.
  const bookerIsSeated = panel.some((seat) => seat.userId === req.auth!.userId);
  const notification = bookerIsSeated
    ? { delivered: false, link, deliveryNote: 'You are conducting this round, so you have the interviewer\'s email instead.' }
    : await notifyScheduler({
      to: req.auth!.email, stageLabel: stage.label, scheduledAt: round.scheduledAt,
      timeZone: round.scheduledTimeZone ?? await tenantTimeZone(tenantId),
      link, aiRound, meetingUrl: meeting?.url ?? null,
    });
  // After the meeting, so the letter carries the link when there is one.
  const interviewerNotices = await notifyRoundInterviewers({
    roundId: round.id, tenantId, candidateId: pipeline.candidateId, stageLabel: stage.label,
    kind: 'seated', expectScheduledAt: round.scheduledAt,
  });

  const saved = await prisma.interviewRound.findUniqueOrThrow({ where: { id: round.id }, include: roundInclude });
  const candidateNotice = await noticeForNewRound(req, saved, { pipeline, stageLabel: stage.label, aiRound });
  // Re-read the pipeline rather than reusing the one loaded above: the round
  // just booked is part of what decides who may read what, and a viewer built
  // without it would answer the quarantine question about the wrong pipeline.
  const after = await reload(pipeline.id);
  res.status(201).json({ round: presentRound(saved, await roundViewer(req, after)), notification, interviewerNotices, meeting, candidateNotice });
}));

const completeSchema = z.object({
  notes: z.string().trim().min(20, 'Record what the round showed — this is the evidence for the stage.').max(10000),
  // The structured record: one entry per competency the interviewer is speaking
  // to, each claim carrying the words it rests on. Optional, because a role
  // with no approved scorecard has no competencies to file under and a round
  // must still be closeable — but it is what makes the round comparable with
  // the AI's reading of the same scorecard, so the UI asks for it first.
  evidence: z.array(z.object({
    competencyId: z.string().trim().min(1).max(64),
    claim: z.string().trim().max(MAX_ENTRY_CHARS),
    quote: z.string().trim().max(MAX_ENTRY_CHARS),
  })).max(MAX_EVIDENCE_ENTRIES).optional(),
});

/** The competencies a round's evidence may be filed under: the role's approved scorecard. */
async function roleCompetencies(roleId: string): Promise<{ id: string; name: string }[]> {
  const scorecard = await scorecardForFit(roleId);
  if (!scorecard) return [];
  const profile = parseJsonOptional<{ competencies?: unknown }>(
    scorecard.profileJson, {}, { model: 'RoleScorecardVersion', id: scorecard.id, field: 'profileJson' },
  );
  const list = Array.isArray(profile.competencies) ? profile.competencies : [];
  return list.flatMap((c) => (typeof c === 'object' && c !== null
    && typeof (c as { id?: unknown }).id === 'string' && typeof (c as { name?: unknown }).name === 'string'
    ? [{ id: (c as { id: string }).id, name: (c as { name: string }).name }]
    : []));
}

// The scorecard a round's evidence is filed against. Read-only, and scoped
// through the pipeline's candidate, which is how an SME reaches the approved
// scorecard for the role they are interviewing for without reaching the role.
pipelinesRouter.get('/:id/competencies', MAY_REACH_A_ROUND, asyncHandler(async (req, res) => {
  const pipeline = await loadPipelineForPanel(req, req.params.id);
  res.json({ competencies: await roleCompetencies(pipeline.roleId) });
}));

// Closing a round with what it showed. The interviewers' notes are the
// assessment; an AI observer, where both parties agreed, only adds a transcript
// and verbatim quotes beside them.
//
// Held to candidate:read at the door and narrowed below, rather than to
// interview:schedule. An SME is given a candidate so they can conduct one
// round; scheduling is not theirs, and a round nobody but a scheduler may close
// would leave the person who actually ran it unable to record what they saw —
// which is the whole reason the round exists. Whoever closes it is named on the
// record either way (recordedByUserId).
pipelinesRouter.post('/:id/rounds/:roundId/complete', MAY_REACH_A_ROUND, asyncHandler(async (req, res) => {
  const { notes, evidence } = completeSchema.parse(req.body);
  const pipeline = await loadPipelineForPanel(req, req.params.id);
  const round = pipeline.rounds.find((r) => r.id === req.params.roundId);
  if (!round) throw new HttpError(404, 'Round not found');

  // Either someone who runs the process, or the person who was in the room.
  // Not "anyone entitled to the candidate": a colleague who did not conduct
  // this round has nothing first-hand to record, and a record they wrote would
  // be attributed to them as though they had.
  const seated = round.panel.some((seat) => seat.userId === req.auth!.userId);
  if (!seated && !hasCapability(req.auth!, 'interview:schedule')) {
    throw new HttpError(403, 'Only someone who conducted this round, or who schedules rounds, can record what it showed.');
  }

  // Checked against the role's own scorecard, and the competency NAMES stored
  // here come from it rather than from the request: a name the client chose
  // would let the record claim a competency the role is not assessed on while
  // passing the id check.
  const checked = evidence && evidence.length > 0
    ? checkEvidenceEntries(evidence, await roleCompetencies(pipeline.roleId))
    : ({ ok: true, entries: [] } as const);
  if (!checked.ok) throw new HttpError(400, checked.problem);

  // Whether this writer could already read a peer round's record, measured now,
  // against the rules and the pipeline position in force as they wrote. Stored
  // rather than recomputed later: both move on, and a record of independence
  // that can be re-derived under tomorrow's rules is a record of tomorrow's
  // rules. Same reasoning as HumanReview.aiVisibleBefore.
  const viewer = await roundViewer(req, pipeline);
  const peerNotesSeenBefore = peerNotesWereVisible({
    round: { id: round.id, stageKey: round.stageKey, conductedBy: round.conductedBy },
    viewerUserId: viewer.userId, viewerDecides: viewer.decides, rounds: viewer.rounds, pipeline: viewer.pipeline,
  });

  const completed = await prisma.interviewRound.updateMany({
    where: { id: round.id, pipelineId: pipeline.id, status: 'SCHEDULED' },
    data: {
      status: 'COMPLETED', notes, completedAt: new Date(),
      recordedByUserId: req.auth!.userId, peerNotesSeenBefore,
      evidenceJson: JSON.stringify(checked.entries),
    },
  });
  if (completed.count !== 1) throw new HttpError(409, 'This round has already been completed or cancelled.');

  // The round is over, so its AI observer is too: capture closes and the
  // transcript becomes read-only. Quotes are extracted in the background; the
  // round's own completion does not wait on a model.
  const ended = await endObservation(round.id, req.auth!.userId);
  if (ended?.mayExtractQuotes) {
    const { observationId } = ended;
    void extractEvidenceQuotes(observationId).catch((err: unknown) => {
      logger.error({ err: err instanceof Error ? err.message : String(err), observationId }, 'Observer quote extraction crashed');
    });
  }

  await logAudit({
    tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'pipeline.round_completed', entityType: 'CandidatePipeline', entityId: pipeline.id,
    after: {
      roundId: round.id, stage: round.stageKey, recordedBy: req.auth!.userId, peerNotesSeenBefore,
      // Counts and headings only. The claims and the quotes are candidate
      // personal data under a retention window; the audit log has neither.
      competencies: checked.entries.map((entry) => entry.competencyId),
    },
  });
  const saved = await prisma.interviewRound.findUniqueOrThrow({ where: { id: round.id }, include: roundInclude });
  res.json({ round: presentRound(saved, await roundViewer(req, await reload(pipeline.id))) });
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

  // Finalising writes no outcome, so the rule in decidePipeline does not reach
  // it — but it is the one move that carries a candidate past every remaining
  // stage, the AI round's review among them, and leaving it open would make it
  // the way around the promise rather than an exception to it. Same check, same
  // refusal; a candidate with no AI interview is untouched, as everywhere else.
  const review = await humanReviewCheck({ tenantId: req.auth!.tenantId, candidateId: pipeline.candidateId, roleId: pipeline.roleId });
  if (review.missing) {
    await logAudit({
      tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
      action: 'pipeline.finalize_refused', entityType: 'CandidatePipeline', entityId: pipeline.id,
      after: { stage: pipeline.currentStageKey, because: HUMAN_REVIEW_REQUIRED, assessmentId: review.missing.assessmentId },
    });
    throw new HttpError(409, humanReviewRefusal(review.missing), HUMAN_REVIEW_REQUIRED);
  }

  // Finalising earns Diamond, and the tier it leaves where that tier is Gold —
  // one move, two badges, one transaction. A finalisation from Silver skips
  // Gold: nobody interviewed them at Gold, so no Gold certificate may claim it.
  const awards = await moveAndAward(async (tx) => {
    const moved = await tx.candidatePipeline.updateMany({
      where: { id: pipeline.id, status: 'ACTIVE', currentStageKey: transition.from },
      data: { currentStageKey: transition.to },
    });
    if (moved.count !== 1) throw new HttpError(409, MOVED_UNDER_YOU);
    return awardOnPromotion(tx, {
      tenantId: req.auth!.tenantId, candidateId: pipeline.candidateId, roleId: pipeline.roleId,
      stages, fromStageKey: transition.from, toStageKey: transition.to, actorId: req.auth!.userId,
    });
  });

  await logAudit({
    tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
    action: 'pipeline.finalized', entityType: 'CandidatePipeline', entityId: pipeline.id,
    before: { stage: transition.from }, after: { stage: transition.to, humanReview: review.record },
  });
  await noteAwards({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, candidateId: pipeline.candidateId, awards });
  const fresh = await reload(pipeline.id);
  res.json({ pipeline: presentPipeline(fresh, await roundViewer(req, fresh)), awards: awards.map(presentAward) });
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
    if (result.because === 'human_review_required') {
      // Recorded as well as refused. An attempt to decide an interview nobody
      // read is exactly the event an Art. 14 oversight audit asks about, and a
      // refusal that leaves no trace answers it with silence.
      await logAudit({
        tenantId: req.auth!.tenantId, actorType: 'user', actorId: req.auth!.userId,
        action: 'pipeline.decision_refused', entityType: 'CandidatePipeline', entityId: pipeline.id,
        after: { decision: body.decision, stage: pipeline.currentStageKey, because: HUMAN_REVIEW_REQUIRED, assessmentId: result.missing.assessmentId },
      });
      throw new HttpError(409, humanReviewRefusal(result.missing), HUMAN_REVIEW_REQUIRED);
    }
    // "Nothing to do" here means a concurrent move carried the candidate past
    // the stage this decision was about: the same answer as a contended write.
    throw new HttpError(409, 'This pipeline changed while you were working on it. Reload and try again.');
  }
  const fresh = await reload(pipeline.id);
  res.json({ pipeline: presentPipeline(fresh, await roundViewer(req, fresh)), effect: result.effect, awards: result.awards.map(presentAward) });
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
    where: { candidateId: pipeline.candidateId }, orderBy: LATEST_PROFILE, select: { id: true, fitScoreJson: true },
  });
  const fit = profile
    ? parseJsonStrict<{ overall?: unknown; provisional?: boolean }>(profile.fitScoreJson, { model: 'CandidateProfileVersion', id: profile.id, field: 'fitScoreJson' })
    : {};
  const aiSessionIds = pipeline.rounds.filter((r) => r.conductedBy === 'AI' && r.sessionId).map((r) => r.sessionId as string);
  const assessments = aiSessionIds.length > 0
    ? await prisma.assessmentVersion.findMany({ where: { sessionId: { in: aiSessionIds } }, orderBy: { version: 'desc' }, select: { id: true, sessionId: true, recommendation: true } })
    : [];
  // The AI's call is named only to someone the blind-review policy lets see it.
  const visible = await aiConclusionVisible({
    assessmentIds: assessments.map((a) => a.id),
    userId: req.auth!.userId, canReview: hasCapability(req.auth!, 'assessment:review'), tenantId: req.auth!.tenantId,
  });

  // Completed human rounds with something written, at any stage. Silver holds
  // these as well as the AI interview once a team books an SME alongside it.
  const humanEvidence = (stageKey: string) => pipeline.rounds.filter((r) =>
    r.stageKey === stageKey && r.conductedBy === 'HUMAN' && r.status === 'COMPLETED' && r.notes.trim().length > 0);

  const summarise = (stage: PipelineStage): StageSummary => {
    const rounds = pipeline.rounds.filter((r) => r.stageKey === stage.key);
    const human = humanEvidence(stage.key);
    const alsoHuman = human.length > 0 ? ` ${human.length} completed human round(s) beside it.` : '';
    switch (stage.kind) {
      case 'intake':
        return { ...stage, hasEvidence: true, detail: 'Candidate profile onboarded.' };
      case 'profile_review':
        // A provisional reading still says what it says, and still says that
        // nobody has checked the scorecard behind it. A stage summary is read
        // as a record of progress, so an unlabelled number here would become
        // the justification for a move it is not allowed to justify.
        return typeof fit.overall === 'number'
          ? {
              ...stage,
              hasEvidence: true,
              detail: `AI profile review: job fit ${Math.round(fit.overall)}/100.${fit.provisional === true ? ` ${FIT_PROVISIONAL_SHORT}` : ''}`,
            }
          : { ...stage, hasEvidence: false, detail: 'No AI profile review yet.' };
      case 'ai_interview': {
        const assessed = assessments.find((a) => rounds.some((r) => r.sessionId === a.sessionId));
        if (assessed && !visible.has(assessed.id)) {
          return { ...stage, hasEvidence: true, detail: `AI interview assessed. Record your own verdict to see its recommendation.${alsoHuman}` };
        }
        if (assessed) return { ...stage, hasEvidence: true, detail: `AI interview assessed: ${assessed.recommendation}.${alsoHuman}` };
        // A team that books an SME at Silver has evidence for Silver even
        // before the AI interview is assessed. Reporting "no evidence" here
        // would tell them the round they ran and wrote up does not count.
        return human.length > 0
          ? { ...stage, hasEvidence: true, detail: `No assessed AI interview yet. ${human.length} completed human round(s) with recorded evidence.` }
          : { ...stage, hasEvidence: false, detail: 'No assessed AI interview yet.' };
      }
      case 'human_interview': {
        return human.length > 0
          ? { ...stage, hasEvidence: true, detail: `${human.length} completed round(s) with recorded evidence.` }
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

