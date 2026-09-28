import type { InterviewRound, ObservationParticipant, ObservationSegment, RoundObservation } from '@prisma/client';
import { prisma, parseJson } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../middleware/index.js';
import { logAudit } from './audit.js';
import { assertCanAccessCandidate, hasCapability } from './access.js';
import { peerQuarantine } from '../domain/roundEvidence.js';
import {
  ENTRY_CONSEQUENCE, ENTRY_NOTICE, ENTRY_NOTICE_VERSION, REQUIRED_PARTIES, blockingDecline, captureConsented,
  captureLiveness, captureReport, consentOutstanding, hearingCheck, mayEnterRoom, roundBlock, staffPartyFor,
  toParticipantRef,
  type CaptureAlarm, type HearingCheck, type ObservationStatus, type ObservedParty, type ParticipantRef,
  type RoomRoster, type Withdrawal,
} from '../domain/observedRound.js';
import type { AuthClaims } from './auth.js';
import { findInvitationByToken, invitationSecretColumns, mintInvitationToken, openInvitationToken } from './invitations.js';

/**
 * The AI observer on a human interview round (task #10).
 *
 * A person conducts the round, usually in a meeting Questor does not host. Each
 * person in the call opens the round's observer room in Questor alongside it;
 * what their device hears is transcribed and, after the round, filed as
 * verbatim quotes under the scorecard competencies (services/observerQuotes.ts).
 * It never scores or characterises anyone.
 *
 * EVERY HUMAN ROUND IS OBSERVED, AUTOMATICALLY. Nobody presses record: the
 * observation is created with the round and capture begins when the room is
 * entered. The reasoning, and the reason that is not the same as recording
 * people without asking, is in domain/observedRound.ts — consent is a gate on
 * entering the room, so there is nobody in the room who has not agreed.
 *
 * Read that file before changing anything here. In particular there is
 * deliberately NO path in this module that begins capture from a status alone:
 * `assertCapturing` re-derives consent from the participant rows on every
 * request, and `appendSegment` does it again inside the write transaction, so
 * a decline that lands mid-round cannot be overtaken by a request already in
 * flight.
 */

export const OBSERVER_NOTICE_VERSION = ENTRY_NOTICE_VERSION;

export const OBSERVER_CAPTURE_NOTICE = ENTRY_NOTICE;

const ONE_SIDED_QUOTES_NOTE =
  'No quotes were kept for this round. The recording heard only one side of the conversation, so anything taken '
  + 'from it would be the interviewer\'s own words filed under the candidate\'s competencies.';

export const QUOTES_FRAMING =
  'Verbatim quotes from the transcript, filed by competency. Quotes only, no AI judgement: the observer does not score, '
  + 'rate or recommend. The interviewers\' own notes and a person\'s decision are the assessment.';

export type { ObservationStatus };

/** States the round's end moves to ENDED. A declined observer stays declined. */
const ENDABLE: ObservationStatus[] = ['AWAITING_CONSENT', 'CONSENTED', 'LISTENING', 'STOPPED'];
/** States from which capture may still be stopped part-way. */
const STOPPABLE: ObservationStatus[] = ['AWAITING_CONSENT', 'CONSENTED', 'LISTENING'];

const CONFLICT = 'The observer changed while you were working. Reload and try again.';

export type RoundWithPipeline = InterviewRound & {
  pipeline: { candidateId: string; roleId: string; stagesJson: string };
  panel: { userId: string }[];
};

/**
 * An observation with everything the consent rules need to be answered from
 * it: the rows, AND the round's seats.
 *
 * Loaded together on purpose. The rules need both (domain/observedRound.ts,
 * `RoomRoster`), and a shape that carried only the rows would let a caller
 * answer "has everyone agreed?" without the seats — which is exactly the miss
 * that let a late-seated panellist be captured with nothing on record.
 */
export type ObservationWithParticipants = RoundObservation & {
  participants: ObservationParticipant[];
  round: { status: string; panel: { userId: string }[] };
};

/** What a load of an observation must always fetch. See the type above. */
const ROSTER_INCLUDE = {
  participants: true,
  round: { select: { status: true, panel: { select: { userId: true } } } },
} as const;

/** The participant rows in the shape the pure rules want. */
export function refsOf(participants: readonly ObservationParticipant[]): ParticipantRef[] {
  return participants.map(toParticipantRef);
}

/** The rows and the seats, which is what every gate in this file is decided on. */
export function rosterOf(observation: ObservationWithParticipants): RoomRoster {
  return { participants: refsOf(observation.participants), seats: observation.round.panel.map((seat) => seat.userId) };
}

/** Who withdrew and what they said, for the sentence HR reads. */
function withdrawalOf(observation: RoundObservation): Withdrawal {
  return {
    by: (observation.stoppedBy ?? observation.declinedBy ?? null) as ObservedParty | null,
    reason: observation.withdrawnReason,
  };
}

/**
 * A round in the caller's organisation, and the seat they hold in it.
 *
 * TWO WAYS IN, and keeping them apart is the point of the narrow capability.
 * A colleague who runs the hiring process reaches the round through the
 * candidate, exactly as they always did — `assertCanAccessCandidate` and the
 * peer quarantine both apply to them. Somebody here ONLY because they were
 * seated on this round, which is the subject-matter expert, reaches this round
 * and no other: their seat IS the object scope. They are deliberately not put
 * through `candidateScope`, because an expert's assignment is excluded from it
 * (services/access.ts, and for a good reason) — widening that to admit them
 * would hand every `candidateScope` route a new way in, which is the opposite
 * of what `observer:attend` is for.
 *
 * The peer quarantine is applied here rather than in the routes, so it covers
 * the whole observer — reading a transcript, but equally consenting to or
 * entering a colleague's round, which would put a second SME in the room for
 * the interview they are meant to be a second opinion on.
 */
export interface StaffSeat {
  readonly round: RoundWithPipeline;
  /** Which of the room's parties this person is. */
  readonly party: Extract<ObservedParty, 'interviewer' | 'hr'>;
}

export async function loadSeat(auth: AuthClaims, roundId: string): Promise<StaffSeat> {
  const round = await prisma.interviewRound.findFirst({
    where: { id: roundId, tenantId: auth.tenantId },
    include: {
      panel: { select: { userId: true } },
      pipeline: {
        select: {
          candidateId: true, roleId: true, stagesJson: true, status: true, currentStageKey: true,
          rounds: { select: { id: true, stageKey: true, conductedBy: true, notes: true, panel: { select: { userId: true } } } },
        },
      },
    },
  });
  if (!round) throw new HttpError(404, 'Round not found');

  const seated = round.panel.some((seat) => seat.userId === auth.userId);
  const party = staffPartyFor({
    seated,
    runsTheProcess: hasCapability(auth, 'interview:read'),
    roundHasSeats: round.panel.length > 0,
  });
  // 404, matching services/access.ts: telling a caller a round exists but is
  // not theirs confirms that a named person is being interviewed.
  if (!party) throw new HttpError(404, 'Round not found');
  // THE SEAT IS THE OBJECT SCOPE, and skipping `assertCanAccessCandidate` for a
  // seated person is deliberate rather than an oversight. It has been raised by
  // a reviewer twice and confirmed both times, so it is written down here
  // rather than re-argued: a `RoundInterviewer` row IS an object-scope grant —
  // the hiring team put this named person in the room with this named
  // candidate, which is a narrower and more explicit claim than
  // `candidateScope` makes for anybody else. Routing an expert through
  // `candidateScope` instead would mean widening it to admit the `sme`
  // relation, which services/access.ts excludes on purpose, and that would hand
  // every `candidateScope` route in the product a new way in.
  //
  // Scoped on the SEAT, never on the party. A round booked with typed names has
  // nobody seated, so `staffPartyFor` calls whoever runs the process its
  // interviewer — and if that answer were allowed to skip the candidate scope,
  // any colleague in the tenant would reach any such round. The bypass belongs
  // to a real RoundInterviewer row and to nothing else.
  if (!seated) await assertCanAccessCandidate(auth, round.pipeline.candidateId);

  const quarantine = peerQuarantine({
    round: { id: round.id, stageKey: round.stageKey, conductedBy: round.conductedBy },
    viewerUserId: auth.userId,
    // The same helper the pipeline route uses, not an equivalent expression.
    // The two answer the same question today; the moment one of them learns
    // about a grant that is not the role string, a reviewer would be
    // quarantined from the transcript on one route and not the other.
    viewerDecides: hasCapability(auth, 'assessment:review'),
    rounds: round.pipeline.rounds.map((r) => ({
      id: r.id, stageKey: r.stageKey, conductedBy: r.conductedBy,
      panelUserIds: r.panel.map((p) => p.userId), hasNotes: r.notes.trim().length > 0,
    })),
    pipeline: { status: round.pipeline.status, currentStageKey: round.pipeline.currentStageKey },
  });
  // 403 rather than the usual 404: this reader is entitled to the candidate and
  // knows the round exists — they can see it on the pipeline. Pretending it is
  // missing would send them to look for a bug instead of reading the reason.
  if (quarantine.withheld) throw new HttpError(403, quarantine.reason);
  return { round, party };
}

export function observerApplies(round: InterviewRound): boolean {
  return round.conductedBy === 'HUMAN' && round.aiObserver;
}

export function candidateLinkFor(observation: Pick<RoundObservation, 'status' | 'candidateTokenSealed'>): string | null {
  if (!['AWAITING_CONSENT', 'CONSENTED', 'LISTENING'].includes(observation.status)) return null;
  const token = observation.candidateTokenSealed ? openInvitationToken(observation.candidateTokenSealed) : null;
  return token ? `${config.webOrigin}/observer-consent/${token}` : null;
}

// ---------------------------------------------------------------------------
// The observation, and the people in it

/**
 * The round's observation, created if it does not exist yet.
 *
 * Creation is not a decision anybody takes, which is why it happens here and in
 * the round-booking transaction rather than behind a button. A round booked
 * before this shipped has no observation and its people have agreed to nothing;
 * making one on first sight is what lets them agree, and it starts at
 * AWAITING_CONSENT, so nothing is captured by the act of creating it.
 */
export async function ensureObservation(round: RoundWithPipeline): Promise<ObservationWithParticipants> {
  const existing = await prisma.roundObservation.findUnique({ where: { roundId: round.id }, include: ROSTER_INCLUDE });
  // Seats can change after the observation was made — HR swaps an expert who
  // cannot make it, or adds a second panellist as the round comes together —
  // so a row is made for anybody seated since. The rules do not depend on this
  // having run (they read the seats directly), but without it a newly seated
  // person would have nothing to agree against when they opened the room.
  if (existing) return syncSeats(existing);
  if (!observerApplies(round)) throw new HttpError(409, 'This round does not have an AI observer.');

  const token = mintInvitationToken();
  const { tokenHash, tokenSealed } = invitationSecretColumns(token);
  try {
    return await prisma.roundObservation.create({
      data: {
        tenantId: round.tenantId, roundId: round.id, candidateId: round.pipeline.candidateId,
        noticeVersion: ENTRY_NOTICE_VERSION, interviewerId: round.panel[0]?.userId ?? '',
        candidateTokenHash: tokenHash, candidateTokenSealed: tokenSealed,
        participants: {
          create: [
            // The candidate always has a row, because they are always in the
            // room. Their consent arrives through the link rather than a login.
            { tenantId: round.tenantId, party: 'candidate', personId: round.pipeline.candidateId, noticeVersion: ENTRY_NOTICE_VERSION },
            // A row for everyone booked to conduct it, so "who has still to
            // agree" is answerable before any of them has opened anything.
            ...round.panel.map((seat) => ({
              tenantId: round.tenantId, party: 'interviewer' as const, personId: seat.userId, noticeVersion: ENTRY_NOTICE_VERSION,
            })),
          ],
        },
      },
      include: ROSTER_INCLUDE,
    });
  } catch (err) {
    // Two people opening the round at the same moment is ordinary, not an
    // error: whichever insert lost the race reads the winner's row.
    if ((err as { code?: string }).code === 'P2002') {
      return prisma.roundObservation.findUniqueOrThrow({ where: { roundId: round.id }, include: ROSTER_INCLUDE });
    }
    throw err;
  }
}

/**
 * This person's row, created empty if they have not been in this round before.
 *
 * An empty row is not consent and grants nothing — `consentAt` is null until
 * they say so. It exists so the room can show them the notice, and so an HR
 * colleague who joins is a person the round knows about rather than an
 * untracked voice.
 */
export async function participantRow(
  observation: ObservationWithParticipants, party: ObservedParty, personId: string,
): Promise<ObservationParticipant> {
  const existing = observation.participants.find((p) => p.personId === personId);
  if (existing) return existing;
  return prisma.observationParticipant.upsert({
    where: { observationId_personId: { observationId: observation.id, personId } },
    create: { tenantId: observation.tenantId, observationId: observation.id, party, personId, noticeVersion: ENTRY_NOTICE_VERSION },
    update: {},
  });
}

async function reload(observationId: string): Promise<ObservationWithParticipants> {
  return prisma.roundObservation.findUniqueOrThrow({ where: { id: observationId }, include: ROSTER_INCLUDE });
}

/**
 * A row for everybody seated on the round who has not got one.
 *
 * Only ever adds. A seat taken away leaves its row behind, because the row is
 * the record that the person was asked and what they said — and if they had
 * already been let into the room, `requiredOf` still counts them
 * (domain/observedRound.ts explains why that door only opens one way).
 */
async function syncSeats(observation: ObservationWithParticipants): Promise<ObservationWithParticipants> {
  const known = new Set(observation.participants.map((p) => p.personId));
  const unasked = observation.round.panel.filter((seat) => !known.has(seat.userId));
  if (unasked.length === 0) return observation;
  // Upserts rather than a bulk insert: two people opening the round at the same
  // moment would otherwise race each other into a unique-constraint failure on
  // a read path, which is a 500 in front of somebody who did nothing wrong.
  await Promise.all(unasked.map((seat) => prisma.observationParticipant.upsert({
    where: { observationId_personId: { observationId: observation.id, personId: seat.userId } },
    create: {
      tenantId: observation.tenantId, observationId: observation.id,
      party: 'interviewer', personId: seat.userId, noticeVersion: ENTRY_NOTICE_VERSION,
    },
    update: {},
  })));
  return reload(observation.id);
}

/**
 * Move the observation's status to match what the rows now say.
 *
 * The status is a cache of the participant rows and never the authority for
 * them — every gate in this file re-reads the rows. It is kept in step so the
 * room, the pipeline and the "needs you" queue can all be answered without
 * loading everybody, and so the candidate's link stops working the moment the
 * round is settled.
 */
async function settleStatus(observation: ObservationWithParticipants): Promise<ObservationWithParticipants> {
  const fresh = await reload(observation.id);
  const roster = rosterOf(fresh);
  // Asked of a live round deliberately: this only ever moves an observation out
  // of AWAITING_CONSENT, and a round that is over is left exactly as it was
  // rather than being rewritten by somebody's late answer.
  const blocked = roundBlock({ status: fresh.status as ObservationStatus, roster, roundStatus: 'SCHEDULED' });
  const want: ObservationStatus | null =
    blocked && fresh.status === 'AWAITING_CONSENT' ? 'DECLINED'
      : captureConsented(roster) && fresh.status === 'AWAITING_CONSENT' ? 'CONSENTED'
        : null;
  if (!want) return fresh;
  const moved = await prisma.roundObservation.updateMany({
    where: { id: fresh.id, status: 'AWAITING_CONSENT' },
    data: want === 'DECLINED'
      ? { status: 'DECLINED', declinedAt: new Date(), declinedBy: declinerOf(roster) }
      : { status: 'CONSENTED' },
  });
  return moved.count === 1 ? reload(fresh.id) : fresh;
}

/**
 * Whose decline stopped the round, for the record on the observation.
 *
 * The BLOCKING decline, not merely the first one found. An HR colleague who
 * would rather not be recorded simply does not join; naming them here would
 * record a round as stopped by somebody who had no say in whether it ran.
 */
function declinerOf(roster: RoomRoster): string {
  return blockingDecline(roster)?.party ?? 'candidate';
}

async function audit(tenantId: string, actorId: string, action: string, observationId: string, after?: unknown) {
  await logAudit({
    tenantId, actorType: 'user', actorId, action, entityType: 'RoundObservation', entityId: observationId,
    after: { noticeVersion: ENTRY_NOTICE_VERSION, at: new Date().toISOString(), ...(after as object | undefined) },
  });
}

// ---------------------------------------------------------------------------
// The gate

/** What the entry gate shows a person before they decide, and after. */
export function entryGateFor(
  observation: ObservationWithParticipants, round: { status: string }, personId: string, hasPartialRecord = false,
) {
  const roster = rosterOf(observation);
  const me = roster.participants.find((p) => p.personId === personId) ?? null;
  const decision = mayEnterRoom({
    status: observation.status as ObservationStatus, roster, roundStatus: round.status, me,
    withdrawal: withdrawalOf(observation), hasPartialRecord,
  });
  return {
    notice: ENTRY_NOTICE,
    noticeVersion: ENTRY_NOTICE_VERSION,
    consequence: ENTRY_CONSEQUENCE,
    decided: me ? (me.declinedAt ? 'declined' : me.consentAt ? 'consented' : 'pending') : 'pending',
    awaiting: consentOutstanding(roster),
    mayEnter: decision.allowed,
    refusal: decision.allowed ? null : { reason: decision.reason, nextSteps: decision.nextSteps },
  };
}

/** This person agrees to be recorded, which is how — and the only way — they join. */
export async function consentToEntry(
  observation: ObservationWithParticipants, party: ObservedParty, personId: string, actorId: string,
): Promise<ObservationWithParticipants> {
  const row = await participantRow(observation, party, personId);
  // Conditional on nothing being decided yet, so a decline that landed while
  // this request was in flight is not overwritten by a stale agreement.
  const moved = await prisma.observationParticipant.updateMany({
    where: { id: row.id, consentAt: null, declinedAt: null },
    data: { consentAt: new Date(), noticeVersion: ENTRY_NOTICE_VERSION },
  });
  if (moved.count !== 1 && !row.consentAt) throw new HttpError(409, 'This can no longer be agreed to.');
  if (moved.count === 1) await audit(observation.tenantId, actorId, `observer.${party}_consented`, observation.id, { roundId: observation.roundId });
  return settleStatus(observation);
}

/**
 * This person says no. The round cannot go ahead if they were required.
 *
 * A "no" that arrives after capture has begun is a WITHDRAWAL, and it stops
 * capture for the whole room rather than only for the person who sent it. The
 * observer hears the room through the devices in it, so one person's voice
 * cannot be subtracted from what the others are recording — the only way to
 * stop capturing somebody who has withdrawn is to stop capturing. Without this
 * an HR colleague could decline mid-round and go on being transcribed by the
 * interviewer's device, and a candidate could decline through their link while
 * the observation sat at LISTENING. (Both found by a Codex review of this
 * change, 2026-09-25.)
 */
export async function declineEntry(
  observation: ObservationWithParticipants, party: ObservedParty, personId: string, actorId: string, reason = '',
): Promise<ObservationWithParticipants> {
  const row = await participantRow(observation, party, personId);
  // CLOSING THE ROOM COMES FIRST, and the order is the whole of the fix.
  //
  // This statement updates the observation ROW, and so does the first statement
  // of `appendSegment`'s transaction — so the database serialises the two on
  // that row rather than leaving them to interleave. Either this lands first,
  // and the capture in flight finds the observation no longer LISTENING and
  // stores nothing; or the capture holds the row, finishes writing the words it
  // had already heard, and this applies the moment it commits. With the
  // participant row cleared first instead, a capture that had passed its checks
  // could still write under a withdrawal that had already committed, because
  // read-committed makes its earlier count a stale snapshot rather than a lock.
  // (Codex review, second pass, 2026-09-25.)
  //
  // Conditional on the room actually being open, so a decline before anybody
  // joined falls through to `settleStatus` and reads as a round that never
  // started rather than one that was stopped.
  const stopped = await prisma.roundObservation.updateMany({
    where: { id: observation.id, status: { in: ['CONSENTED', 'LISTENING'] } },
    data: { status: 'STOPPED', stoppedBy: party, stoppedAt: new Date(), withdrawnReason: trimReason(reason) },
  });
  const moved = await prisma.observationParticipant.updateMany({
    where: { id: row.id, declinedAt: null },
    // The consent is cleared as well as the decline recorded. A row holding
    // both would read as agreed to `hasConsented`, and that is the one mistake
    // in this file that would start capture on somebody who said no.
    //
    // `admittedAt` is deliberately NOT cleared. It is the record that this
    // person was once in the room and so may be in the recording, and
    // `requiredOf` reads it to keep them in the consent set even if their seat
    // is taken away afterwards. Wiping it would let a round that a withdrawal
    // correctly blocked be unblocked by removing them from the panel.
    data: { declinedAt: new Date(), consentAt: null },
  });
  // The reason is recorded on the DECLINE too, for a round nobody had entered:
  // the status move above only fires once the room was open.
  if (moved.count === 1 && stopped.count === 0) {
    await prisma.roundObservation.updateMany({
      where: { id: observation.id, withdrawnReason: '' }, data: { withdrawnReason: trimReason(reason) },
    });
  }
  if (moved.count === 1) {
    await audit(observation.tenantId, actorId, `observer.${party}_declined`, observation.id, {
      roundId: observation.roundId, gaveReason: trimReason(reason).length > 0,
    });
  }
  if (stopped.count === 1) await audit(observation.tenantId, actorId, 'observer.stopped', observation.id, { stoppedBy: party, withdrawn: true });
  return settleStatus(observation);
}

/**
 * Enter the room. Capture starts here, and only here.
 *
 * The status move is conditional on CONSENTED, and `mayEnterRoom` has already
 * re-derived that from the rows, so there is no ordering of requests in which
 * LISTENING is reached without every required party's affirmative row.
 */
export async function enterRoom(
  observation: ObservationWithParticipants, round: RoundWithPipeline, party: ObservedParty, personId: string, actorId: string,
): Promise<ObservationWithParticipants> {
  const roster = rosterOf(observation);
  const me = roster.participants.find((p) => p.personId === personId) ?? null;
  const decision = mayEnterRoom({
    status: observation.status as ObservationStatus, roster, roundStatus: round.status, me,
    withdrawal: withdrawalOf(observation),
  });
  if (!decision.allowed) throw new HttpError(409, decision.reason);

  const row = await participantRow(observation, party, personId);
  await prisma.observationParticipant.updateMany({
    where: { id: row.id, consentAt: { not: null }, declinedAt: null },
    data: { admittedAt: new Date() },
  });
  const started = await prisma.roundObservation.updateMany({
    where: { id: observation.id, status: 'CONSENTED', round: { id: round.id, status: 'SCHEDULED' } },
    data: { status: 'LISTENING', startedAt: new Date() },
  });
  if (started.count === 1) await audit(observation.tenantId, actorId, 'observer.started', observation.id, { roundId: round.id });
  await audit(observation.tenantId, actorId, 'observer.entered', observation.id, { party });
  return reload(observation.id);
}

/**
 * What somebody wrote when they stopped it, bounded and trimmed.
 *
 * Optional, always. Asking is right — the reason is what tells HR how to
 * proceed and is a large part of what makes a withdrawn round fair rather than
 * merely blocked — but requiring it would make a person justify themselves in
 * order to exercise a right, which is not a right.
 */
export const MAX_WITHDRAWAL_REASON = 500;

function trimReason(reason: string): string {
  return reason.trim().slice(0, MAX_WITHDRAWAL_REASON);
}

async function stop(observation: RoundObservation, by: ObservedParty, actorId: string, reason: string) {
  const moved = await prisma.roundObservation.updateMany({
    where: { id: observation.id, status: { in: STOPPABLE } },
    data: { status: 'STOPPED', stoppedBy: by, stoppedAt: new Date(), withdrawnReason: trimReason(reason) },
  });
  if (moved.count !== 1) throw new HttpError(409, 'The observer is not running.');
  await audit(observation.tenantId, actorId, 'observer.stopped', observation.id, {
    stoppedBy: by, gaveReason: trimReason(reason).length > 0,
  });
}

/**
 * Someone withdraws part-way.
 *
 * Kept, although consent is otherwise an entry gate, because withdrawal is not
 * a button that makes the round unrecorded — it ends the round's capture, and
 * `roundBlock` then reports the round as one that cannot produce the evidence
 * an assessment rests on. Removing it altogether would leave a person captured
 * with no way to stop, which is the thing GDPR is least willing to overlook.
 */
export async function participantStops(
  observation: RoundObservation, by: ObservedParty, actorId: string, reason = '',
) {
  await stop(observation, by, actorId, reason);
}

export interface EndedObservation {
  readonly observationId: string;
  /**
   * Whether quotes may be extracted from what was captured.
   *
   * False for a round whose capture was WITHDRAWN part-way. What was stored
   * before the withdrawal stays — it was captured with everyone's agreement and
   * deleting it would rewrite what happened — but taking fresh quotes out of it
   * afterwards is new processing of a conversation somebody has since said no
   * to, and it would put fragments of a withdrawn interview in front of the
   * hiring team. The round is blocked in any case, so those quotes would be
   * evidence for an assessment that is not going to be written.
   * (Codex review, third pass, 2026-09-25.)
   */
  readonly mayExtractQuotes: boolean;
}

/**
 * The round is over: capture closes for good and the record becomes read-only.
 * Returns null when there is no observer on this round to end.
 */
export async function endObservation(roundId: string, actorId: string): Promise<EndedObservation | null> {
  const observation = await prisma.roundObservation.findUnique({ where: { roundId }, include: { segments: true } });
  if (!observation) return null;
  const withdrawn = observation.status === 'STOPPED' || observation.status === 'DECLINED';
  // Settled once, here, rather than recomputed whenever somebody opens the
  // round: the threshold will move, and a round must not change its account of
  // what it heard because the rule changed afterwards. Same reasoning as
  // `peerNotesSeenBefore` on the round itself.
  const { oneSided } = hearingCheck(capturedSoFar(observation, new Date()));
  const speechCount = observation.segments.filter((segment) => segment.kind === 'SPEECH').length;
  const moved = await prisma.roundObservation.updateMany({
    where: { id: observation.id, status: { in: ENDABLE } },
    data: {
      status: 'ENDED', endedAt: new Date(), oneSided,
      // Marked degraded as well, so every surface that already knows how to say
      // "this recording is incomplete" says it without being taught a new word.
      ...(oneSided ? { captureStatus: 'DEGRADED' } : {}),
      // And any quotes already taken out are dropped. Extraction can run
      // mid-round, so a round can hold quotes from before we decided the
      // recording was one-sided — and those quotes are lines of the
      // interviewer's own speech filed under the candidate's competencies,
      // which is the worst thing this observer could leave behind. Refusing to
      // extract any more would not remove them. (Codex review, 2026-09-25.)
      ...(oneSided ? { quotesJson: '[]', quotesStatus: 'NONE', quotesNote: ONE_SIDED_QUOTES_NOTE } : {}),
    },
  });
  if (moved.count !== 1) {
    // An observation already ended is asked the same three questions, not waved
    // through. Answering `true` here let a second press on End — or the quotes
    // retry — run extraction over a withdrawn or one-sided round that the first
    // press had correctly refused. (Codex review, final pass, 2026-09-25.)
    return observation.status === 'ENDED'
      ? { observationId: observation.id, mayExtractQuotes: mayExtract(observation, speechCount) }
      : null;
  }
  await audit(observation.tenantId, actorId, 'observer.ended', observation.id, { withdrawn, oneSided });
  return {
    observationId: observation.id,
    mayExtractQuotes: !withdrawn && mayExtract({ ...observation, oneSided }, speechCount),
  };
}

/**
 * Whether quotes may be taken out of what this round captured.
 *
 * Quotes come out of a TRANSCRIPT. A recording of one person is not one, and
 * filing its lines under the candidate's competencies would attribute the
 * interviewer's own words to the candidate — the single worst thing this
 * observer could produce. A round that captured nothing has nothing to file.
 */
export function mayExtract(
  observation: Pick<RoundObservation, 'oneSided' | 'stoppedAt'>, speechCount: number,
): boolean {
  return !observation.oneSided && observation.stoppedAt === null && speechCount > 0;
}

// ---------------------------------------------------------------------------
// Presenting it

export function presentObservation(
  observation: ObservationWithParticipants & { segments: ObservationSegment[] },
  viewerId: string,
  round: { status: string },
) {
  const roster = rosterOf(observation);
  const speech = observation.segments.filter((segment) => segment.kind === 'SPEECH');
  const blocked = roundBlock({
    status: observation.status as ObservationStatus, roster, roundStatus: round.status,
    withdrawal: withdrawalOf(observation),
    // So the sentence HR reads says the partial record exists rather than
    // leaving them to guess whether stopping left anything behind.
    hasPartialRecord: speech.length > 0,
  });
  const byId = new Map(observation.participants.map((p) => [p.id, p.party]));
  return {
    id: observation.id,
    status: observation.status,
    noticeVersion: observation.noticeVersion,
    isInterviewer: observation.participants.some((p) => p.personId === viewerId && p.party === 'interviewer'),
    interviewerConsentAt: observation.participants.find((p) => p.party === 'interviewer' && p.consentAt)?.consentAt ?? null,
    candidateConsentAt: observation.participants.find((p) => p.party === 'candidate')?.consentAt ?? null,
    // Who is in the room, by party. No name and no id for anyone but the
    // reader: the room's job is to say who can hear this, not to publish a
    // directory of the hiring team to a transcript reader.
    participants: observation.participants.map((p) => ({
      party: p.party, isYou: p.personId === viewerId,
      consentedAt: p.consentAt, declinedAt: p.declinedAt, admittedAt: p.admittedAt,
    })),
    awaiting: consentOutstanding(roster),
    blocked,
    /** Who stopped it and what they said, '' when they gave no reason. */
    withdrawal: observation.stoppedAt || observation.declinedAt
      ? { by: observation.stoppedBy ?? observation.declinedBy, reason: observation.withdrawnReason }
      : null,
    declinedBy: observation.declinedBy,
    declinedAt: observation.declinedAt,
    startedAt: observation.startedAt,
    stoppedBy: observation.stoppedBy,
    stoppedAt: observation.stoppedAt,
    endedAt: observation.endedAt,
    readOnly: observation.status === 'ENDED' || observation.status === 'DECLINED',
    captureStatus: observation.captureStatus,
    // What the recording actually got, said plainly once the round is over.
    captureReport: captureReport({
      status: observation.status as ObservationStatus,
      speechCount: speech.length,
      captureStatus: observation.captureStatus,
      oneSided: observation.oneSided,
    }),
    oneSided: observation.oneSided,
    legalHold: observation.legalHold,
    candidateLink: observation.participants.some((p) => p.personId === viewerId && p.party !== 'candidate')
      ? candidateLinkFor(observation) : null,
    // Ordered by when it was said, not by when it arrived. With more than one
    // device uploading, the insert order is the order the network happened to
    // deliver in, and a transcript in that order reads as a conversation
    // nobody had.
    transcript: [...observation.segments]
      .sort((a, b) => a.offsetMs - b.offsetMs || a.index - b.index)
      .map((s) => ({
        index: s.index, kind: s.kind, offsetMs: s.offsetMs, durationMs: s.durationMs, text: s.text,
        heardBy: s.participantId ? byId.get(s.participantId) ?? null : null,
      })),
    quotes: {
      status: observation.quotesStatus,
      note: observation.quotesNote,
      framing: QUOTES_FRAMING,
      items: parseJson<unknown[]>(observation.quotesJson, []),
    },
  };
}

export async function observationForRound(roundId: string) {
  return prisma.roundObservation.findUnique({ where: { roundId }, include: { ...ROSTER_INCLUDE, segments: true } });
}

/** Speech captured so far, and how long the round has been running. */
function capturedSoFar(observation: RoundObservation & { segments: ObservationSegment[] }, now: Date) {
  return {
    elapsedMs: observation.startedAt ? now.getTime() - observation.startedAt.getTime() : 0,
    stretches: observation.segments
      .filter((segment) => segment.kind === 'SPEECH')
      .map((segment) => ({ durationMs: segment.durationMs, chars: segment.text.length })),
  };
}

/**
 * Whether the round is actually being heard, and by how many voices.
 *
 * Both answers come from the stored segments and the clock, so neither needs a
 * microphone to test and neither is a new way to capture anything — they are
 * detection, which is the whole of what the owner has approved before video.
 */
export function captureWatch(
  observation: RoundObservation & { segments: ObservationSegment[] }, now: Date = new Date(),
): { readonly alarm: CaptureAlarm; readonly hearing: HearingCheck } {
  const alarm = captureLiveness({
    status: observation.status as ObservationStatus,
    lastHeardAt: observation.lastHeardAt, startedAt: observation.startedAt, now,
  });
  return {
    alarm,
    // Only asked while capture is live. A device that has gone quiet altogether
    // would read as one-sided too, and putting both remedies in front of one
    // person at once is how neither gets acted on.
    hearing: alarm.liveness === 'live' ? hearingCheck(capturedSoFar(observation, now)) : { oneSided: false, warning: '' },
  };
}

/** A device proving it is still capturing, between one stretch of speech and the next. */
export async function heardFrom(observationId: string): Promise<void> {
  await prisma.roundObservation.updateMany({
    where: { id: observationId, status: 'LISTENING' },
    data: { lastHeardAt: new Date() },
  });
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

export interface CapturingSeat {
  readonly observation: ObservationWithParticipants;
  readonly participant: ObservationParticipant;
}

/**
 * The checks every capture request passes before anything is spent or stored.
 * Run again, atomically, at write time by appendSegment.
 *
 * Consent is re-derived from the rows here rather than trusted from the status,
 * so an observation left LISTENING by any means — a bug, a stale row, a future
 * migration — still captures nothing once somebody's row says no.
 */
export async function assertCapturing(auth: AuthClaims, round: RoundWithPipeline, party: ObservedParty): Promise<CapturingSeat> {
  const observation = await prisma.roundObservation.findUnique({ where: { roundId: round.id }, include: ROSTER_INCLUDE });
  if (!observation) throw new HttpError(409, 'The observer is not listening, so nothing was captured.');
  const participant = observation.participants.find((p) => p.personId === auth.userId);
  if (!participant || !participant.consentAt || participant.declinedAt || !participant.admittedAt) {
    throw new HttpError(403, 'You have not joined this round, so nothing you send is captured.');
  }
  if (participant.party !== party) throw new HttpError(403, 'You are not in this round in that capacity.');
  if (!captureConsented(rosterOf(observation))) {
    throw new HttpError(409, 'Not everyone in this round has agreed to be recorded, so nothing was captured.');
  }
  if (observation.status !== 'LISTENING' || round.status !== 'SCHEDULED') {
    throw new HttpError(409, 'The observer is not listening, so nothing was captured.');
  }
  return { observation, participant };
}

const MAX_INDEX_RETRIES = 3;

export async function appendSegment(seat: CapturingSeat, roundId: string, input: SegmentInput): Promise<ObservationSegment> {
  const { observation, participant } = seat;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        // The consent gate, at the moment of writing: a stop, a decline or an
        // end that landed while this request was transcribing wins.
        const live = await tx.roundObservation.updateMany({
          where: { id: observation.id, status: 'LISTENING', round: { status: 'SCHEDULED', id: roundId } },
          // `lastHeardAt` on every write, gap included: a reported gap is a
          // device that is still there and still trying, which is exactly what
          // this field is for — proof the room is being listened to, as opposed
          // to permission for it to be.
          data: input.kind === 'GAP'
            ? { captureStatus: 'DEGRADED', lastHeardAt: new Date() }
            : { updatedAt: new Date(), lastHeardAt: new Date() },
        });
        if (live.count !== 1) throw new HttpError(409, 'The observer is not listening, so nothing was captured.');
        // And the writer's own row, in the same transaction. Withdrawal is a
        // participant-level act, so the observation being LISTENING does not
        // answer whether THIS person may still be heard.
        const stillIn = await tx.observationParticipant.count({
          where: { id: participant.id, consentAt: { not: null }, declinedAt: null },
        });
        if (stillIn !== 1) throw new HttpError(409, 'You are no longer part of this round, so nothing was captured.');
        // And EVERYBODY else's, in the same transaction. This chunk was
        // transcribed over several seconds, and a withdrawal that landed while
        // it was in flight must win: what this device heard is the room, not
        // only the person holding it. Checked here as well as in
        // `assertCapturing` because that check is necessarily stale by the time
        // the vendor answers. (Codex review, 2026-09-25.)
        // Defence in depth rather than the race guard: the guard is the
        // conditional update above, which `declineEntry` contends with on the
        // observation row. This catches a state that is simply wrong — a row
        // left un-consented by a bug, a migration, or a future caller.
        const outstanding = await tx.observationParticipant.count({
          where: {
            observationId: observation.id,
            party: { in: [...REQUIRED_PARTIES] },
            OR: [{ consentAt: null }, { declinedAt: { not: null } }],
          },
        });
        if (outstanding !== 0) {
          throw new HttpError(409, 'Not everyone in this round has agreed to be recorded, so nothing was captured.');
        }
        const last = await tx.observationSegment.findFirst({
          where: { observationId: observation.id }, orderBy: { index: 'desc' }, select: { index: true },
        });
        return tx.observationSegment.create({
          data: {
            tenantId: observation.tenantId, observationId: observation.id, participantId: participant.id,
            index: (last?.index ?? -1) + 1, ...input,
          },
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
// The candidate's side, reached by the link they are sent before the round

export async function findByCandidateToken(token: string): Promise<ObservationWithParticipants> {
  const observation = await findInvitationByToken(token, (tokenHash) =>
    prisma.roundObservation.findUnique({ where: { candidateTokenHash: tokenHash }, include: ROSTER_INCLUDE })
      .then((row) => (row ? { ...row, tokenHash: row.candidateTokenHash } : null)));
  if (!observation) throw new HttpError(404, 'This link does not work.');
  return observation;
}

export async function candidateView(observation: ObservationWithParticipants) {
  const round = await prisma.interviewRound.findUniqueOrThrow({
    where: { id: observation.roundId },
    select: { stageKey: true, status: true, pipeline: { select: { stagesJson: true } }, tenantId: true },
  });
  const tenant = await prisma.tenant.findUnique({ where: { id: round.tenantId }, select: { name: true } });
  const stages = parseJson<Array<{ key?: unknown; label?: unknown }>>(round.pipeline.stagesJson, []);
  const label = stages.find((s) => s.key === round.stageKey)?.label;
  const status = observation.status as ObservationStatus;
  const speech = await prisma.observationSegment.count({ where: { observationId: observation.id, kind: 'SPEECH' } });
  const gate = entryGateFor(observation, round, observation.candidateId, speech > 0);
  return {
    status,
    organisation: tenant?.name ?? '',
    stage: typeof label === 'string' ? label : round.stageKey,
    notice: ENTRY_NOTICE,
    consequence: ENTRY_CONSEQUENCE,
    decision: gate.decided,
    canConsent: gate.decided === 'pending' && status === 'AWAITING_CONSENT' && round.status === 'SCHEDULED',
    canDecline: gate.decided === 'pending' && status === 'AWAITING_CONSENT' && round.status === 'SCHEDULED',
    canStop: status === 'CONSENTED' || status === 'LISTENING',
    listening: status === 'LISTENING',
    // What is waiting on whom, so the candidate is not left looking at a page
    // that says nothing while the interviewer has yet to open theirs.
    awaiting: gate.awaiting,
    refusal: gate.refusal,
  };
}

export async function candidateConsents(observation: ObservationWithParticipants) {
  await consentToEntry(observation, 'candidate', observation.candidateId, 'candidate');
}

export async function candidateDeclines(observation: ObservationWithParticipants, reason = '') {
  await declineEntry(observation, 'candidate', observation.candidateId, 'candidate', reason);
}

export async function candidateStops(observation: ObservationWithParticipants, reason = '') {
  await participantStops(observation, 'candidate', 'candidate', reason);
}
