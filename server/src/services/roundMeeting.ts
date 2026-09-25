import { randomUUID } from 'node:crypto';
import type { InterviewRound, Prisma } from '@prisma/client';
import { prisma, parseJsonOptional } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { isProviderReady, resolveRoundMeetingProvider, vendorFor } from '../providers/meeting/roundMeetings.js';
import { MeetingProviderError } from '../providers/meeting/vendorHttp.js';
import { tenantTimeZone } from './tenantTimeZone.js';
import {
  isRoundMeetingProviderId, PROVIDER_LABEL,
  type MeetingDetails, type MeetingVendor, type RoundMeetingProviderId,
} from '../providers/meeting/types.js';

// The online meeting behind a human interview round.
//
// The booking always comes first: a round is saved before any vendor is
// called, and no vendor failure can undo it. What a failure changes is the
// round's meetingStatus and a sentence telling the recruiter what to do —
// usually "try again, or paste a link".
//
// Vendor calls never run inside a database transaction, and every write after
// one is conditional on the state the call started from, so a round cancelled
// mid-call does not get a meeting attached (the new meeting is removed).

export const MEETING_STATUS = {
  LINKED: 'LINKED',             // a vendor meeting exists and matches the round
  MANUAL: 'MANUAL',             // a recruiter supplied the link
  NEEDS_LINK: 'NEEDS_LINK',     // no link yet (manual provider, or creation failed)
  CREATING: 'CREATING',         // a vendor call is in flight
  OUT_OF_SYNC: 'OUT_OF_SYNC',   // the round moved but the vendor meeting did not
  CANCELLED: 'CANCELLED',       // the vendor meeting was removed with the round
  // The round is cancelled and its vendor meeting is being removed. Written in
  // the same update that cancels the round, so a crash before the vendor call
  // still leaves a row that erasure, retention and retry treat as live.
  CANCEL_PENDING: 'CANCEL_PENDING',
  CANCEL_FAILED: 'CANCEL_FAILED', // the round is cancelled; the vendor meeting may remain
} as const;
export type MeetingStatus = (typeof MEETING_STATUS)[keyof typeof MEETING_STATUS];

/**
 * Rows whose vendor meeting may still exist and must not lose its id: any row
 * holding an id that has not been confirmed removed. Completed rounds are
 * excluded — their meeting has taken place and nothing further is due.
 */
export const VENDOR_MEETING_OUTSTANDING: Prisma.InterviewRoundWhereInput = {
  meetingExternalId: { not: null },
  status: { not: 'COMPLETED' },
  OR: [{ meetingStatus: null }, { meetingStatus: { not: MEETING_STATUS.CANCELLED } }],
};

/**
 * The first step of cancelling a round: one conditional write that marks the
 * round cancelled and, when a vendor meeting exists, its removal as pending.
 * Retried once if a creation attaches a meeting between the read and the write.
 */
export async function markRoundCancelled(roundId: string, pipelineId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await prisma.interviewRound.findFirst({ where: { id: roundId, pipelineId }, select: { status: true, meetingExternalId: true } });
    if (!current || current.status !== 'SCHEDULED') return false;
    const { count } = await prisma.interviewRound.updateMany({
      where: { id: roundId, pipelineId, status: 'SCHEDULED', meetingExternalId: current.meetingExternalId },
      data: current.meetingExternalId
        ? { status: 'CANCELLED', meetingStatus: MEETING_STATUS.CANCEL_PENDING, meetingUpdatedAt: new Date() }
        : { status: 'CANCELLED' },
    });
    if (count === 1) return true;
  }
  return false;
}

// A creation that has been "in flight" this long is assumed dead (process
// restart mid-call) and may be claimed again. Well above the worst case of a
// live attempt (retried token call, create, read-back, clean-up: about 2.5
// minutes), and every write after the vendor call also names the attempt's
// claim time, so even a slower attempt cannot overwrite a newer one.
export const STALE_CREATION_MS = 10 * 60_000;

export function isStaleCreation(round: Pick<InterviewRound, 'meetingStatus' | 'meetingUpdatedAt'>, now = Date.now()): boolean {
  return round.meetingStatus === 'CREATING'
    && (round.meetingUpdatedAt === null || round.meetingUpdatedAt.getTime() < now - STALE_CREATION_MS);
}
const GENERIC_FAILURE = 'The meeting could not be set up. Try again, or add a meeting link manually.';

export interface MeetingOutcome {
  readonly ok: boolean;
  readonly provider: RoundMeetingProviderId;
  readonly status: MeetingStatus | null;
  readonly url: string | null;
  readonly message: string;
}

export interface RoundContext {
  readonly stageLabel: string;
  readonly candidateId: string;
}

export async function tenantMeetingProvider(tenantId: string): Promise<RoundMeetingProviderId> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { policyJson: true, isDemo: true } });
  // Anyone can request a demo; a sandbox round must never book a real meeting
  // on the deployment's Zoom / Teams / Meet account, whatever is configured.
  if (tenant?.isDemo) return 'manual';
  return resolveRoundMeetingProvider(parseJsonOptional<Record<string, unknown>>(tenant?.policyJson, {}, { model: 'Tenant', id: tenantId, field: 'policyJson' })).provider;
}

export function storedProvider(round: Pick<InterviewRound, 'meetingProvider'>): RoundMeetingProviderId {
  return isRoundMeetingProviderId(round.meetingProvider) ? round.meetingProvider : 'manual';
}

/** No candidate name or contact detail: the event lives outside Questor's erasure reach. */
async function detailsFor(
  round: Pick<InterviewRound, 'scheduledAt' | 'scheduledTimeZone' | 'durationMinutes' | 'tenantId'>,
  ctx: RoundContext,
): Promise<MeetingDetails> {
  const label = ctx.stageLabel.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 120);
  return {
    title: `${label} interview (Questor)`,
    description: `Interview round scheduled in Questor. Candidate and pipeline: ${config.webOrigin}/candidates/${ctx.candidateId}`,
    startsAt: round.scheduledAt,
    durationMinutes: round.durationMinutes,
    // The zone the round was booked in, else the organisation's: the same rule as Questor's own emails.
    timeZone: round.scheduledTimeZone ?? await tenantTimeZone(round.tenantId),
    requestId: randomUUID(),
  };
}

function failureMessage(err: unknown, provider: RoundMeetingProviderId): string {
  if (err instanceof MeetingProviderError) return err.userMessage;
  logger.error({ provider, errorName: (err as { name?: string } | null)?.name ?? 'Error' }, 'Meeting provider failed unexpectedly');
  return GENERIC_FAILURE;
}

function notReadyMessage(provider: RoundMeetingProviderId): string {
  return `${PROVIDER_LABEL[provider]} is selected for meetings but is not fully set up on the server. Add a meeting link manually, and ask an admin to finish the setup in Admin → Connectors.`;
}

const outcome = (o: MeetingOutcome) => o;

async function setMeeting(where: Prisma.InterviewRoundWhereInput, data: Prisma.InterviewRoundUpdateManyMutationInput): Promise<boolean> {
  const { count } = await prisma.interviewRound.updateMany({ where, data: { ...data, meetingUpdatedAt: new Date() } });
  return count === 1;
}

/** Fields for a round that is about to be created: what to store before any vendor is called. */
export function initialMeetingFields(provider: RoundMeetingProviderId, manualUrl: string | undefined) {
  if (manualUrl) return { meetingProvider: 'manual', meetingStatus: MEETING_STATUS.MANUAL, meetingUrl: manualUrl, meetingUpdatedAt: new Date() };
  if (provider === 'manual') return { meetingProvider: 'manual', meetingStatus: MEETING_STATUS.NEEDS_LINK, meetingUpdatedAt: new Date() };
  return { meetingProvider: provider, meetingStatus: MEETING_STATUS.CREATING, meetingUpdatedAt: new Date() };
}

/** Create the vendor meeting for a round already marked CREATING. Never throws for vendor trouble. */
export async function createMeeting(round: InterviewRound, ctx: RoundContext): Promise<MeetingOutcome> {
  const provider = storedProvider(round);
  const vendor = vendorFor(provider);
  // The claim time identifies this attempt; a later claim changes it.
  const creating = { id: round.id, meetingStatus: MEETING_STATUS.CREATING, meetingUpdatedAt: round.meetingUpdatedAt };
  if (!vendor || !vendor.isConfigured()) {
    const message = vendor ? notReadyMessage(provider) : 'Add a meeting link for this round.';
    await setMeeting(creating, { meetingStatus: MEETING_STATUS.NEEDS_LINK, meetingError: vendor ? message : null });
    return outcome({ ok: false, provider, status: MEETING_STATUS.NEEDS_LINK, url: null, message });
  }

  let created: { externalId: string; joinUrl: string };
  try {
    created = await vendor.create(await detailsFor(round, ctx));
  } catch (err) {
    const message = failureMessage(err, provider);
    await setMeeting(creating, { meetingStatus: MEETING_STATUS.NEEDS_LINK, meetingError: message });
    return outcome({ ok: false, provider, status: MEETING_STATUS.NEEDS_LINK, url: null, message });
  }

  const stored = await setMeeting(
    { ...creating, status: 'SCHEDULED' },
    { meetingStatus: MEETING_STATUS.LINKED, meetingExternalId: created.externalId, meetingUrl: created.joinUrl, meetingError: null },
  );
  if (!stored) {
    // The round was cancelled (or changed) while the vendor was booking. A
    // meeting nobody can see from Questor must not be left behind.
    return removeOrphanedMeeting(round, vendor, created);
  }
  logger.info({ roundId: round.id, provider }, 'Round meeting created');
  return outcome({ ok: true, provider, status: MEETING_STATUS.LINKED, url: created.joinUrl, message: `${PROVIDER_LABEL[provider]} meeting created.` });
}

/**
 * A meeting booked for a round that changed meanwhile. When the vendor will
 * not remove it, the recruiter is told so, and a round that is no longer
 * scheduled keeps its id as CANCEL_FAILED so "Try again" can remove it. A
 * round another attempt has claimed is left alone: its own meeting wins, and
 * the log names the one to delete by hand.
 */
async function removeOrphanedMeeting(round: InterviewRound, vendor: MeetingVendor, created: { externalId: string; joinUrl: string }): Promise<MeetingOutcome> {
  const provider = vendor.id;
  let failure: string | null = null;
  try {
    await vendor.cancel(created.externalId);
  } catch (err) {
    failure = failureMessage(err, provider);
  }
  if (failure === null) {
    return outcome({ ok: false, provider, status: null, url: null, message: 'The round changed while the meeting was being created, so the meeting was removed.' });
  }
  logger.error({ roundId: round.id, provider, externalId: created.externalId }, 'A meeting booked for a changed round could not be removed');
  const message = `The round changed while the ${PROVIDER_LABEL[provider]} meeting was being created, and that meeting could not be removed. Try again, or delete it in ${PROVIDER_LABEL[provider]}. ${failure}`;
  const kept = await setMeeting(
    { id: round.id, meetingExternalId: null, status: { not: 'SCHEDULED' } },
    { meetingStatus: MEETING_STATUS.CANCEL_FAILED, meetingExternalId: created.externalId, meetingUrl: created.joinUrl, meetingError: message },
  );
  return outcome({ ok: false, provider, status: kept ? MEETING_STATUS.CANCEL_FAILED : null, url: null, message });
}

async function syncTime(round: InterviewRound, vendor: MeetingVendor, ctx: RoundContext): Promise<MeetingOutcome> {
  const provider = vendor.id;
  const externalId = round.meetingExternalId ?? '';
  let message: string | null = null;
  if (!vendor.isConfigured()) {
    message = notReadyMessage(provider);
  } else {
    try {
      await vendor.update(externalId, await detailsFor(round, ctx));
    } catch (err) {
      message = failureMessage(err, provider);
    }
  }
  // Conditional on the time this call pushed: if another reschedule landed
  // meanwhile, its own call decides the final state, not this one.
  const where = { id: round.id, meetingExternalId: externalId, status: 'SCHEDULED', scheduledAt: round.scheduledAt };
  if (message === null) {
    if (await setMeeting(where, { meetingStatus: MEETING_STATUS.LINKED, meetingError: null })) {
      return outcome({ ok: true, provider, status: MEETING_STATUS.LINKED, url: round.meetingUrl, message: `${PROVIDER_LABEL[provider]} meeting moved to the new time.` });
    }
    message = 'The round was changed again while the meeting was being moved. Use "Try again" to line them up.';
  }
  const full = `The round moved, but the ${PROVIDER_LABEL[provider]} meeting still has the old time. ${message}`;
  await setMeeting(where, { meetingStatus: MEETING_STATUS.OUT_OF_SYNC, meetingError: full });
  return outcome({ ok: false, provider, status: MEETING_STATUS.OUT_OF_SYNC, url: round.meetingUrl, message: full });
}

/** After the round's time changed: move the vendor meeting with it. */
export async function rescheduleMeeting(round: InterviewRound, ctx: RoundContext): Promise<MeetingOutcome> {
  const provider = storedProvider(round);
  const vendor = vendorFor(provider);
  if (vendor && round.meetingExternalId) return syncTime(round, vendor, ctx);
  if (round.meetingStatus === MEETING_STATUS.MANUAL) {
    return outcome({ ok: true, provider, status: MEETING_STATUS.MANUAL, url: round.meetingUrl, message: 'Update the time in the meeting tool you linked; Questor cannot change it there.' });
  }
  return outcome({ ok: true, provider, status: (round.meetingStatus as MeetingStatus | null), url: round.meetingUrl, message: 'Round moved.' });
}

/** After the round was cancelled: remove the vendor meeting. */
export async function cancelMeeting(round: InterviewRound): Promise<MeetingOutcome> {
  const provider = storedProvider(round);
  const vendor = vendorFor(provider);
  if (!vendor || !round.meetingExternalId) {
    if (round.meetingStatus === MEETING_STATUS.MANUAL) {
      return outcome({ ok: true, provider, status: MEETING_STATUS.MANUAL, url: round.meetingUrl, message: 'Round cancelled. Remove the meeting you linked from your own calendar.' });
    }
    // A creation still in flight sees CANCELLED and removes its own meeting.
    await setMeeting(
      { id: round.id, meetingExternalId: null, OR: [{ meetingStatus: null }, { meetingStatus: { in: [MEETING_STATUS.CREATING, MEETING_STATUS.NEEDS_LINK] } }] },
      { meetingStatus: MEETING_STATUS.CANCELLED },
    );
    return outcome({ ok: true, provider, status: MEETING_STATUS.CANCELLED, url: null, message: 'Round cancelled.' });
  }

  let message: string | null = null;
  try {
    await vendor.cancel(round.meetingExternalId);
  } catch (err) {
    message = failureMessage(err, provider);
  }
  const where = { id: round.id, meetingExternalId: round.meetingExternalId };
  if (message === null) {
    await setMeeting(where, { meetingStatus: MEETING_STATUS.CANCELLED, meetingError: null });
    return outcome({ ok: true, provider, status: MEETING_STATUS.CANCELLED, url: null, message: `Round cancelled and the ${PROVIDER_LABEL[provider]} meeting removed.` });
  }
  const full = `The round is cancelled, but the ${PROVIDER_LABEL[provider]} meeting could not be removed. Try again, or delete it in ${PROVIDER_LABEL[provider]}. ${message}`;
  await setMeeting(where, { meetingStatus: MEETING_STATUS.CANCEL_FAILED, meetingError: full });
  return outcome({ ok: false, provider, status: MEETING_STATUS.CANCEL_FAILED, url: round.meetingUrl, message: full });
}

export type RetryResult = { readonly kind: 'done'; readonly outcome: MeetingOutcome } | { readonly kind: 'conflict'; readonly message: string };

/**
 * "Try again" on whatever last failed: create a missing meeting, move an
 * out-of-date one, or remove one left behind by a cancellation.
 */
export async function retryMeeting(round: InterviewRound, ctx: RoundContext, tenantId: string): Promise<RetryResult> {
  if (round.meetingStatus === MEETING_STATUS.CANCEL_FAILED || round.meetingStatus === MEETING_STATUS.CANCEL_PENDING) {
    return { kind: 'done', outcome: await cancelMeeting(round) };
  }
  if (round.status !== 'SCHEDULED') return { kind: 'conflict', message: 'This round is no longer scheduled.' };
  if (round.meetingStatus === MEETING_STATUS.OUT_OF_SYNC) return { kind: 'done', outcome: await rescheduleMeeting(round, ctx) };

  // Creation uses the provider selected now: the earlier attempt may have failed
  // precisely because the tenant had not chosen one yet.
  const provider = await tenantMeetingProvider(tenantId);
  if (provider === 'manual') return { kind: 'conflict', message: 'No meeting provider is selected, so add a meeting link manually.' };
  if (!isProviderReady(provider)) return { kind: 'conflict', message: notReadyMessage(provider) };

  const staleBefore = new Date(Date.now() - STALE_CREATION_MS);
  const claimed = await setMeeting(
    {
      id: round.id,
      status: 'SCHEDULED',
      meetingExternalId: null,
      OR: [
        { meetingStatus: null },
        { meetingStatus: MEETING_STATUS.NEEDS_LINK },
        { meetingStatus: MEETING_STATUS.CREATING, meetingUpdatedAt: { lt: staleBefore } },
      ],
    },
    { meetingStatus: MEETING_STATUS.CREATING, meetingProvider: provider, meetingError: null },
  );
  if (!claimed) return { kind: 'conflict', message: 'This round already has a meeting, or one is being created right now.' };
  // Re-read so the attempt carries the claim time just written.
  const fresh = await prisma.interviewRound.findUniqueOrThrow({ where: { id: round.id } });
  return { kind: 'done', outcome: await createMeeting(fresh, ctx) };
}

/** A recruiter-supplied link. Refused while a vendor meeting exists, which would be orphaned. */
export async function setManualLink(round: InterviewRound, url: string): Promise<boolean> {
  return setMeeting(
    {
      id: round.id,
      status: 'SCHEDULED',
      meetingExternalId: null,
      OR: [
        { meetingStatus: null },
        { meetingStatus: { not: MEETING_STATUS.CREATING } },
        { meetingStatus: MEETING_STATUS.CREATING, meetingUpdatedAt: { lt: new Date(Date.now() - STALE_CREATION_MS) } },
      ],
    },
    { meetingProvider: 'manual', meetingStatus: MEETING_STATUS.MANUAL, meetingUrl: url, meetingError: null },
  );
}

/**
 * Erasure: vendor meetings still booked for this candidate's rounds are removed
 * before the rows (and with them the only record of the meeting ids) go.
 * Best effort — erasure must not fail because a vendor is down — and the
 * number removed is reported.
 */
export async function collectVendorMeetings(candidateId: string, tenantId: string, db: Prisma.TransactionClient = prisma): Promise<InterviewRound[]> {
  return db.interviewRound.findMany({
    where: {
      tenantId,
      pipeline: { candidateId },
      AND: [VENDOR_MEETING_OUTSTANDING],
    },
  });
}

export async function removeVendorMeetings(rounds: readonly InterviewRound[]): Promise<number> {
  const results = await Promise.all(rounds.map(async (round) => {
    const vendor = vendorFor(storedProvider(round));
    if (!vendor || !round.meetingExternalId || !vendor.isConfigured()) return false;
    try {
      await vendor.cancel(round.meetingExternalId);
      return true;
    } catch (err) {
      failureMessage(err, vendor.id);
      logger.warn({ roundId: round.id, provider: vendor.id }, 'Erasure could not remove a vendor meeting');
      return false;
    }
  }));
  return results.filter(Boolean).length;
}

/**
 * Retention: a finished round past the window keeps no meeting link or vendor
 * id, just as it keeps no notes. Legal holds on the candidate spare them.
 */
export async function clearExpiredMeetingLinks(cutoff: Date): Promise<number> {
  const { count } = await prisma.interviewRound.updateMany({
    where: {
      status: { in: ['COMPLETED', 'CANCELLED'] },
      // Still the only record of a vendor meeting that has to be removed.
      NOT: VENDOR_MEETING_OUTSTANDING,
      OR: [{ meetingUrl: { not: null } }, { meetingExternalId: { not: null } }, { meetingError: { not: null } }],
      AND: [{
        OR: [
          { completedAt: { lte: cutoff } },
          { completedAt: null, scheduledAt: { lte: cutoff } },
        ],
      }],
      pipeline: { candidate: { interviews: { none: { legalHold: true } }, artifacts: { none: { legalHold: true } } } },
    },
    data: { meetingUrl: null, meetingExternalId: null, meetingError: null },
  });
  return count;
}
