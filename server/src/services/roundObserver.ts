import type { InterviewRound, ObservationSegment, RoundObservation } from '@prisma/client';
import { prisma, parseJson } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../middleware/index.js';
import { logAudit } from './audit.js';
import { assertCanAccessCandidate } from './access.js';
import type { AuthClaims } from './auth.js';
import { findInvitationByToken, invitationSecretColumns, mintInvitationToken, openInvitationToken } from './invitations.js';

/**
 * The AI observer on a human interview round (task #10).
 *
 * A person conducts the round, usually in a meeting Questor does not host. The
 * interviewer opens an observer room in Questor during the call; with both
 * parties' agreement it transcribes what the interviewer's device hears and,
 * after the round, files verbatim quotes under the scorecard competencies
 * (services/observerQuotes.ts). It never scores or characterises anyone.
 *
 * Every transition is a conditional update on the status that was read, so a
 * stop, a decline and an incoming segment cannot interleave into a state where
 * audio is stored after someone said no.
 */

export const OBSERVER_NOTICE_VERSION = 'observer-v1';

export const OBSERVER_CAPTURE_NOTICE =
  'With your agreement, Questor will transcribe this interview from the interviewer\'s device and, afterwards, pick out '
  + 'word-for-word quotes for the hiring team. It will not score you, rate you, summarise you or recommend a decision; '
  + 'the people interviewing you do that. Nothing is captured unless both you and the interviewer agree, and either of '
  + 'you can stop it at any time.';

export const QUOTES_FRAMING =
  'Verbatim quotes from the transcript, filed by competency. Quotes only, no AI judgement: the observer does not score, '
  + 'rate or recommend. The interviewers\' own notes and a person\'s decision are the assessment.';

export type ObservationStatus = 'AWAITING_CANDIDATE' | 'CONSENTED' | 'LISTENING' | 'STOPPED' | 'DECLINED' | 'ENDED';

/** States from which the observer may still be stopped. */
const STOPPABLE: ObservationStatus[] = ['AWAITING_CANDIDATE', 'CONSENTED', 'LISTENING'];
/** States the round's end moves to ENDED. A declined observer stays declined. */
const ENDABLE: ObservationStatus[] = ['AWAITING_CANDIDATE', 'CONSENTED', 'LISTENING', 'STOPPED'];

const CONFLICT = 'The observer changed while you were working. Reload and try again.';

export type RoundWithPipeline = InterviewRound & { pipeline: { candidateId: string; roleId: string; stagesJson: string } };

/** A round in the caller's organisation and candidate scope; 404 otherwise. */
export async function loadRoundForStaff(auth: AuthClaims, roundId: string): Promise<RoundWithPipeline> {
  const round = await prisma.interviewRound.findFirst({
    where: { id: roundId, tenantId: auth.tenantId },
    include: { pipeline: { select: { candidateId: true, roleId: true, stagesJson: true } } },
  });
  if (!round) throw new HttpError(404, 'Round not found');
  await assertCanAccessCandidate(auth, round.pipeline.candidateId);
  return round;
}

export function observerApplies(round: InterviewRound): boolean {
  return round.conductedBy === 'HUMAN' && round.aiObserver;
}

export function candidateLinkFor(observation: Pick<RoundObservation, 'status' | 'candidateTokenSealed'>): string | null {
  if (!['AWAITING_CANDIDATE', 'CONSENTED', 'LISTENING'].includes(observation.status)) return null;
  const token = observation.candidateTokenSealed ? openInvitationToken(observation.candidateTokenSealed) : null;
  return token ? `${config.webOrigin}/observer-consent/${token}` : null;
}

export function presentObservation(observation: RoundObservation & { segments: ObservationSegment[] }, viewerId: string) {
  return {
    id: observation.id,
    status: observation.status,
    noticeVersion: observation.noticeVersion,
    isInterviewer: observation.interviewerId === viewerId,
    interviewerConsentAt: observation.interviewerConsentAt,
    candidateConsentAt: observation.candidateConsentAt,
    declinedBy: observation.declinedBy,
    declinedAt: observation.declinedAt,
    startedAt: observation.startedAt,
    stoppedBy: observation.stoppedBy,
    stoppedAt: observation.stoppedAt,
    endedAt: observation.endedAt,
    readOnly: observation.status === 'ENDED' || observation.status === 'DECLINED',
    captureStatus: observation.captureStatus,
    legalHold: observation.legalHold,
    candidateLink: observation.interviewerId === viewerId ? candidateLinkFor(observation) : null,
    transcript: [...observation.segments]
      .sort((a, b) => a.index - b.index)
      .map((s) => ({ index: s.index, kind: s.kind, offsetMs: s.offsetMs, durationMs: s.durationMs, text: s.text })),
    quotes: {
      status: observation.quotesStatus,
      note: observation.quotesNote,
      framing: QUOTES_FRAMING,
      items: parseJson<unknown[]>(observation.quotesJson, []),
    },
  };
}

export async function observationForRound(roundId: string) {
  return prisma.roundObservation.findUnique({ where: { roundId }, include: { segments: true } });
}

async function audit(tenantId: string, actorId: string, action: string, observationId: string, after?: unknown) {
  await logAudit({
    tenantId, actorType: 'user', actorId, action, entityType: 'RoundObservation', entityId: observationId,
    after: { noticeVersion: OBSERVER_NOTICE_VERSION, at: new Date().toISOString(), ...(after as object | undefined) },
  });
}

/** The interviewer agrees. Creates the observation and the candidate's consent link. */
export async function interviewerConsents(auth: AuthClaims, round: RoundWithPipeline) {
  if (!observerApplies(round)) throw new HttpError(409, 'This round does not have an AI observer.');
  if (round.status !== 'SCHEDULED') throw new HttpError(409, 'This round has already ended.');
  const existing = await prisma.roundObservation.findUnique({ where: { roundId: round.id } });
  if (existing) {
    const same = existing.interviewerId === auth.userId && ['AWAITING_CANDIDATE', 'CONSENTED'].includes(existing.status);
    if (same) return existing;
    throw new HttpError(409, 'The observer for this round has already been decided.');
  }
  const token = mintInvitationToken();
  const { tokenHash, tokenSealed } = invitationSecretColumns(token);
  let created: RoundObservation;
  try {
    created = await prisma.roundObservation.create({
      data: {
        tenantId: round.tenantId, roundId: round.id, candidateId: round.pipeline.candidateId,
        noticeVersion: OBSERVER_NOTICE_VERSION, interviewerId: auth.userId, interviewerConsentAt: new Date(),
        candidateTokenHash: tokenHash, candidateTokenSealed: tokenSealed,
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') throw new HttpError(409, 'The observer for this round has already been decided.');
    throw err;
  }
  await audit(round.tenantId, auth.userId, 'observer.interviewer_consented', created.id, { roundId: round.id });
  return created;
}

/** The interviewer says no. Recorded, so the round visibly ran without an observer. */
export async function interviewerDeclines(auth: AuthClaims, round: RoundWithPipeline) {
  if (!observerApplies(round)) throw new HttpError(409, 'This round does not have an AI observer.');
  const existing = await prisma.roundObservation.findUnique({ where: { roundId: round.id } });
  const now = new Date();
  let id: string;
  if (!existing) {
    if (round.status !== 'SCHEDULED') throw new HttpError(409, 'This round has already ended.');
    const created = await prisma.roundObservation.create({
      data: {
        tenantId: round.tenantId, roundId: round.id, candidateId: round.pipeline.candidateId,
        noticeVersion: OBSERVER_NOTICE_VERSION, interviewerId: auth.userId,
        status: 'DECLINED', declinedBy: 'interviewer', declinedAt: now,
      },
    });
    id = created.id;
  } else {
    const moved = await prisma.roundObservation.updateMany({
      where: { id: existing.id, status: { in: ['AWAITING_CANDIDATE', 'CONSENTED'] } },
      data: { status: 'DECLINED', declinedBy: 'interviewer', declinedAt: now },
    });
    if (moved.count !== 1) throw new HttpError(409, 'The observer can no longer be declined; stop it instead.');
    id = existing.id;
  }
  await audit(round.tenantId, auth.userId, 'observer.interviewer_declined', id, { roundId: round.id });
}

async function requireObservation(roundId: string): Promise<RoundObservation> {
  const observation = await prisma.roundObservation.findUnique({ where: { roundId } });
  if (!observation) throw new HttpError(409, 'Nobody has agreed to an observer for this round.');
  return observation;
}

export async function startListening(auth: AuthClaims, round: RoundWithPipeline) {
  const observation = await requireObservation(round.id);
  if (observation.interviewerId !== auth.userId) throw new HttpError(403, 'Only the interviewer who agreed can start the observer.');
  if (round.status !== 'SCHEDULED') throw new HttpError(409, 'This round has already ended.');
  const moved = await prisma.roundObservation.updateMany({
    where: { id: observation.id, status: 'CONSENTED', candidateConsentAt: { not: null }, interviewerConsentAt: { not: null } },
    data: { status: 'LISTENING', startedAt: new Date() },
  });
  if (moved.count !== 1) {
    throw new HttpError(409, observation.status === 'AWAITING_CANDIDATE'
      ? 'The candidate has not agreed to the observer yet.'
      : 'The observer cannot be started now.');
  }
  await audit(round.tenantId, auth.userId, 'observer.started', observation.id);
}

async function stop(observation: RoundObservation, by: 'interviewer' | 'candidate', actorId: string) {
  const moved = await prisma.roundObservation.updateMany({
    where: { id: observation.id, status: { in: STOPPABLE } },
    data: { status: 'STOPPED', stoppedBy: by, stoppedAt: new Date() },
  });
  if (moved.count !== 1) throw new HttpError(409, 'The observer is not running.');
  await audit(observation.tenantId, actorId, 'observer.stopped', observation.id, { stoppedBy: by });
}

export async function interviewerStops(auth: AuthClaims, round: RoundWithPipeline) {
  await stop(await requireObservation(round.id), 'interviewer', auth.userId);
}

/**
 * The round is over: capture closes for good and the record becomes read-only.
 * Returns the observation id when there is something to extract quotes from.
 */
export async function endObservation(roundId: string, actorId: string): Promise<string | null> {
  const observation = await prisma.roundObservation.findUnique({ where: { roundId } });
  if (!observation) return null;
  const moved = await prisma.roundObservation.updateMany({
    where: { id: observation.id, status: { in: ENDABLE } },
    data: { status: 'ENDED', endedAt: new Date() },
  });
  if (moved.count !== 1) return observation.status === 'ENDED' ? observation.id : null;
  await audit(observation.tenantId, actorId, 'observer.ended', observation.id);
  return observation.id;
}

// ---------------------------------------------------------------------------
// Capture

export interface SegmentInput {
  readonly kind: 'SPEECH' | 'GAP';
  readonly offsetMs: number;
  readonly durationMs: number;
  readonly text: string;
  readonly source: string;
}

/**
 * The checks every capture request passes before anything is spent or stored.
 * Run again, atomically, at write time by appendSegment.
 */
export async function assertCapturing(auth: AuthClaims, round: RoundWithPipeline): Promise<RoundObservation> {
  const observation = await requireObservation(round.id);
  if (observation.interviewerId !== auth.userId) throw new HttpError(403, 'Only the interviewer who agreed can send audio.');
  if (observation.status !== 'LISTENING' || round.status !== 'SCHEDULED') {
    throw new HttpError(409, 'The observer is not listening, so nothing was captured.');
  }
  return observation;
}

const MAX_INDEX_RETRIES = 3;

export async function appendSegment(observation: RoundObservation, roundId: string, input: SegmentInput): Promise<ObservationSegment> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        // The consent gate, at the moment of writing: a stop or an end that
        // landed while this request was transcribing wins.
        const live = await tx.roundObservation.updateMany({
          where: { id: observation.id, status: 'LISTENING', round: { status: 'SCHEDULED', id: roundId } },
          data: input.kind === 'GAP' ? { captureStatus: 'DEGRADED' } : { updatedAt: new Date() },
        });
        if (live.count !== 1) throw new HttpError(409, 'The observer is not listening, so nothing was captured.');
        const last = await tx.observationSegment.findFirst({
          where: { observationId: observation.id }, orderBy: { index: 'desc' }, select: { index: true },
        });
        return tx.observationSegment.create({
          data: { tenantId: observation.tenantId, observationId: observation.id, index: (last?.index ?? -1) + 1, ...input },
        });
      });
    } catch (err) {
      const clash = (err as { code?: string }).code === 'P2002';
      if (!clash || attempt >= MAX_INDEX_RETRIES) {
        if (clash) throw new HttpError(409, CONFLICT);
        throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The candidate's side, reached by the link the interviewer shares

export async function findByCandidateToken(token: string) {
  const observation = await findInvitationByToken(token, (tokenHash) =>
    prisma.roundObservation.findUnique({ where: { candidateTokenHash: tokenHash } })
      .then((row) => (row ? { ...row, tokenHash: row.candidateTokenHash } : null)));
  if (!observation) throw new HttpError(404, 'This link does not work.');
  return observation;
}

export async function candidateView(observation: RoundObservation) {
  const round = await prisma.interviewRound.findUniqueOrThrow({
    where: { id: observation.roundId },
    select: { stageKey: true, pipeline: { select: { stagesJson: true } }, tenantId: true },
  });
  const tenant = await prisma.tenant.findUnique({ where: { id: round.tenantId }, select: { name: true } });
  const stages = parseJson<Array<{ key?: unknown; label?: unknown }>>(round.pipeline.stagesJson, []);
  const label = stages.find((s) => s.key === round.stageKey)?.label;
  const status = observation.status as ObservationStatus;
  return {
    status,
    organisation: tenant?.name ?? '',
    stage: typeof label === 'string' ? label : round.stageKey,
    notice: OBSERVER_CAPTURE_NOTICE,
    decision: observation.candidateConsentAt ? 'consented' : observation.declinedBy === 'candidate' ? 'declined' : 'pending',
    canConsent: status === 'AWAITING_CANDIDATE',
    canDecline: status === 'AWAITING_CANDIDATE',
    canStop: status === 'CONSENTED' || status === 'LISTENING',
    listening: status === 'LISTENING',
  };
}

export async function candidateConsents(observation: RoundObservation) {
  const moved = await prisma.roundObservation.updateMany({
    where: { id: observation.id, status: 'AWAITING_CANDIDATE' },
    data: { status: 'CONSENTED', candidateConsentAt: new Date() },
  });
  if (moved.count !== 1) throw new HttpError(409, 'This can no longer be agreed to.');
  await audit(observation.tenantId, 'candidate', 'observer.candidate_consented', observation.id);
}

export async function candidateDeclines(observation: RoundObservation) {
  const moved = await prisma.roundObservation.updateMany({
    where: { id: observation.id, status: 'AWAITING_CANDIDATE' },
    data: { status: 'DECLINED', declinedBy: 'candidate', declinedAt: new Date() },
  });
  if (moved.count !== 1) throw new HttpError(409, 'This can no longer be declined. If the observer is running, stop it.');
  await audit(observation.tenantId, 'candidate', 'observer.candidate_declined', observation.id);
}

export async function candidateStops(observation: RoundObservation) {
  await stop(observation, 'candidate', 'candidate');
}
