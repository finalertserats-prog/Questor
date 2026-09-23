import { CorruptRecordError, prisma, parseJsonStrict } from '../db.js';
import { HttpError } from '../middleware/index.js';
import { logger } from '../logger.js';
import { logAudit } from './audit.js';
import { candidateFeedbackEnabledForTenant } from './candidateFeedbackPolicy.js';
import { buildFeedbackDraft } from './candidateFeedbackDraft.js';
import type { AssessmentResult } from '../domain/types.js';
import { DAY_MS, hashCandidateLinkToken, mintCandidateLinkToken, resolveCandidateLink } from './candidateLinkToken.js';

/**
 * The candidate's own decision about written feedback, and the single-purpose
 * link that lets them ask to speak to a person.
 *
 * Two rules run through this file and are worth stating once:
 *
 *   NOTHING IS SENT HERE. Opting in prepares a CandidateFeedbackDelivery row in
 *   DRAFT. Approval and sending stay exactly where they were, behind
 *   `assessment:review` in routes/assessments.ts. This module has no email path
 *   at all, which is the structural version of the promise.
 *
 *   FEEDBACK GOES ONLY TO A "YES". No answer on file is not consent: the send
 *   route refuses it (candidateFeedbackPolicy.ts), and the hiring team can ask
 *   by email (candidateFeedbackOptInRequest.ts), which records the answer here.
 *
 *   A RECORDED "NO" IS FINAL. The first answer is the record; replays return it
 *   rather than overwrite it. A double submit, a back button or a forged repeat
 *   therefore cannot turn a decline into consent to be emailed. Someone who
 *   changes their mind talks to a person — which is the safe direction for this
 *   to fail in.
 */

export const OPT_IN_YES = 'YES';
export const OPT_IN_NO = 'NO';

/** Long enough that the link is worth something for a real job search, short enough to age out. */
export const HUMAN_REQUEST_TTL_DAYS = 30;

/** Shape a caller may safely hand to the candidate's browser. */
export interface OptInView {
  choice: string;
  decidedAt: string;
}

/** Where an answer came from, recorded with it for the audit trail. */
export type OptInSource = 'end-of-interview' | 'emailed-request';

// ---------------------------------------------------------------------------
// Opt-in
// ---------------------------------------------------------------------------

/**
 * Whether this session is at the point where the question makes sense.
 *
 * Gated on the tenant switch as well as completion: asking a candidate whether
 * they want feedback that the tenant has switched off would be a promise we
 * cannot keep, and it is the sort of thing candidates remember.
 */
export async function feedbackOptInOffered(session: {
  tenantId: string;
  completedAt: Date | null;
}): Promise<boolean> {
  if (!session.completedAt) return false;
  return candidateFeedbackEnabledForTenant(session.tenantId);
}

export async function getOptIn(sessionId: string) {
  return prisma.candidateFeedbackOptIn.findUnique({ where: { sessionId } });
}

/**
 * Record the candidate's answer, once.
 *
 * Returns `created: false` when an answer was already on file, in which case
 * the stored answer is returned untouched — including when the replay disagrees
 * with it.
 */
export async function recordFeedbackOptIn(opts: {
  sessionId: string;
  wantsFeedback: boolean;
  via: OptInSource;
}): Promise<{ optIn: { choice: string; decidedAt: Date }; created: boolean }> {
  const session = await prisma.interviewSession.findUnique({
    where: { id: opts.sessionId },
    select: { id: true, tenantId: true, candidateId: true, completedAt: true },
  });
  if (!session) throw new HttpError(404, 'Interview not found');

  if (!await candidateFeedbackEnabledForTenant(session.tenantId)) {
    throw new HttpError(409, 'Written feedback is not offered for this interview.');
  }
  if (!session.completedAt) {
    throw new HttpError(409, 'This question is only asked once the interview has finished.');
  }

  const existing = await prisma.candidateFeedbackOptIn.findUnique({ where: { sessionId: session.id } });
  if (existing) return { optIn: existing, created: false };

  const choice = opts.wantsFeedback ? OPT_IN_YES : OPT_IN_NO;
  let optIn;
  try {
    optIn = await prisma.candidateFeedbackOptIn.create({
      data: {
        sessionId: session.id,
        candidateId: session.candidateId,
        tenantId: session.tenantId,
        choice,
        // Recorded rather than assumed: this is consent evidence, and "who chose
        // this" is the part a regulator would ask about.
        decidedBy: 'candidate',
      },
    });
  } catch (err) {
    // A double-click races itself: both requests find no row, one insert wins
    // and the other breaks the unique constraint on sessionId. Their answer is
    // already recorded, so hand it back rather than failing the request and
    // leaving the candidate unsure whether their choice was heard.
    if ((err as { code?: string }).code !== 'P2002') throw err;
    const raced = await prisma.candidateFeedbackOptIn.findUnique({ where: { sessionId: session.id } });
    if (!raced) throw err;
    return { optIn: raced, created: false };
  }

  await logAudit({
    tenantId: session.tenantId,
    actorType: 'system',
    actorId: 'candidate-portal',
    // Two actions rather than one with a field, so "who opted out" is a filter
    // on the audit log and not a JSON search.
    action: choice === OPT_IN_YES ? 'feedback.opted_in' : 'feedback.opted_out',
    entityType: 'InterviewSession',
    entityId: session.id,
    after: { choice, decidedAt: optIn.decidedAt, decidedBy: 'candidate', via: opts.via },
  });

  if (choice === OPT_IN_YES) {
    // Never allowed to fail the candidate's request. The answer is already
    // committed above; a draft that could not be built is a job for the hiring
    // team, not an error page for someone who has just finished an interview.
    await prepareDraftForOptIn(session.id).catch((err: unknown) => {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), sessionId: session.id },
        'Could not prepare the candidate feedback draft',
      );
    });
  }

  return { optIn, created: true };
}

/**
 * Build the draft the hiring team will edit.
 *
 * Deterministic and local (see candidateFeedbackDraft.ts), so this works in the
 * zero-key build and adds no vendor call to the path a candidate is waiting on.
 * Every outcome is recorded on the opt-in row, so "they asked and nothing
 * happened" is visible rather than silent.
 */
export async function prepareDraftForOptIn(sessionId: string): Promise<string> {
  const record = async (draftStatus: string, draftNote = '') => {
    await prisma.candidateFeedbackOptIn.update({
      where: { sessionId },
      data: { draftStatus, draftNote, draftPreparedAt: draftStatus === 'PREPARED' ? new Date() : null },
    });
    return draftStatus;
  };

  const session = await prisma.interviewSession.findUnique({
    where: { id: sessionId },
    select: { id: true, tenantId: true, candidate: { select: { fullName: true } }, role: { select: { title: true } } },
  });
  if (!session) return record('FAILED', 'The interview could not be loaded.');

  const assessment = await prisma.assessmentVersion.findFirst({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    include: { candidateFeedback: { select: { id: true } } },
  });
  if (!assessment) {
    return record('NO_ASSESSMENT', 'No assessment exists for this interview yet, so there is nothing to draft from.');
  }
  // A human's own draft outranks a generated one. Overwriting it would discard
  // someone's work, and if it had already been sent it would rewrite history.
  if (assessment.candidateFeedback) {
    return record('ALREADY_DRAFTED', 'A draft already existed for this assessment and was left as it was.');
  }

  // A draft built from {} would tell the candidate nothing was covered. Record
  // the failure on the opt-in, where the hiring team sees it, and stop.
  let result: AssessmentResult;
  try {
    result = parseJsonStrict<AssessmentResult>(assessment.resultJson, { model: 'AssessmentVersion', id: assessment.id, field: 'resultJson' });
  } catch (err) {
    if (!(err instanceof CorruptRecordError)) throw err;
    logger.error(err.record, 'Stored assessment is unreadable; feedback draft not prepared');
    return record('FAILED', 'The assessment record could not be read, so no draft was prepared.');
  }
  const draft = buildFeedbackDraft({
    candidateName: session.candidate.fullName,
    roleTitle: session.role.title,
    assessment: result,
  });

  await prisma.candidateFeedbackDelivery.create({
    data: {
      assessmentId: assessment.id,
      draftText: draft.text,
      status: 'DRAFT',
      // So the hiring team can tell a draft the candidate asked for from one
      // somebody started themselves.
      candidateRequested: true,
    },
  });

  await logAudit({
    tenantId: session.tenantId,
    actorType: 'system',
    actorId: 'candidate-feedback-draft',
    action: 'feedback.draft.prepared_for_candidate',
    entityType: 'AssessmentVersion',
    entityId: assessment.id,
    after: {
      strengths: draft.strengths.length,
      develop: draft.develop.length,
      notCovered: draft.notCovered.length,
      enoughEvidence: draft.hasContent,
    },
  });

  return record(
    'PREPARED',
    draft.hasContent ? '' : 'There was too little evidence for useful feedback, and the draft says so.',
  );
}

// ---------------------------------------------------------------------------
// "Would you like to speak to a person?"
// ---------------------------------------------------------------------------

/**
 * Issue the link that goes in the feedback email, returning the raw token to
 * the caller exactly once — it is never readable again from storage.
 *
 * Uses the shared scheme in candidateLinkToken.ts, which says why this is not
 * the interview token.
 */
export async function issueHumanRequestToken(opts: {
  sessionId: string;
  candidateId: string;
  tenantId: string;
  now?: Date;
}): Promise<string> {
  const now = opts.now ?? new Date();
  const token = mintCandidateLinkToken();
  const tokenHash = hashCandidateLinkToken(token);
  const expiresAt = new Date(now.getTime() + HUMAN_REQUEST_TTL_DAYS * DAY_MS);

  await prisma.candidateHumanRequest.upsert({
    where: { sessionId: opts.sessionId },
    create: {
      sessionId: opts.sessionId,
      candidateId: opts.candidateId,
      tenantId: opts.tenantId,
      tokenHash,
      issuedAt: now,
      expiresAt,
    },
    // Re-issuing replaces the credential and the clock, but never the fact that
    // someone already asked.
    update: { tokenHash, issuedAt: now, expiresAt },
  });

  await logAudit({
    tenantId: opts.tenantId,
    actorType: 'system',
    actorId: 'candidate-feedback',
    action: 'feedback.human_request.issued',
    entityType: 'InterviewSession',
    entityId: opts.sessionId,
    after: { expiresAt },
  });

  return token;
}

export interface ResolvedHumanRequest {
  id: string;
  sessionId: string;
  candidateId: string;
  tenantId: string;
  status: string;
  requestedAt: Date | null;
  expiresAt: Date;
}

/**
 * Look a link up. 404 for anything we did not issue, 410 once it has aged out —
 * and nothing else is ever returned to the caller, because this token is not
 * allowed to be a way of reading about a person.
 */
export async function resolveHumanRequest(token: string, now = new Date()): Promise<ResolvedHumanRequest> {
  return resolveCandidateLink({
    token,
    now,
    findByHash: (tokenHash) => prisma.candidateHumanRequest.findUnique({ where: { tokenHash } }),
    expiredMessage: 'This link has expired. Please reply to your feedback email instead.',
  });
}

/**
 * Record that the candidate asked to speak to someone. Safe to call twice: the
 * first request is the one kept, so a double-click or a mail client that
 * follows the link twice cannot rewrite when they asked.
 */
export async function recordHumanRequest(token: string, now = new Date()): Promise<ResolvedHumanRequest | null> {
  const row = await resolveHumanRequest(token, now);
  if (row.status === 'REQUESTED') return null;

  // Conditional on the status just read. Two simultaneous clicks both see
  // ISSUED, and an unconditional update would let the second one move the
  // timestamp off the first click — and tell the hiring team twice that one
  // person asked to talk.
  // expiresAt is re-checked here and not only in the read above: the link can
  // expire in the gap between the two, and an expired link must not be able to
  // put a candidate in front of the hiring team.
  const { count } = await prisma.candidateHumanRequest.updateMany({
    where: { id: row.id, status: 'ISSUED', expiresAt: { gt: now } },
    data: { status: 'REQUESTED', requestedAt: now },
  });
  if (count === 0) return null;

  await logAudit({
    tenantId: row.tenantId,
    actorType: 'system',
    actorId: 'candidate-portal',
    action: 'feedback.human_request.recorded',
    entityType: 'Candidate',
    entityId: row.candidateId,
    after: { sessionId: row.sessionId, requestedAt: now },
  });
  // The caller gets the claimed row from the write itself, so it never has to
  // re-resolve the token after mutating it.
  return { ...row, status: 'REQUESTED', requestedAt: now };
}

/**
 * The same request, made from the candidate's own status page rather than from
 * the link in a feedback email.
 *
 * There is no emailed token in this path — the candidate is already holding
 * their invitation token, which the portal route has resolved to this session,
 * so minting a second bearer credential would only create another thing to
 * steal. It writes the SAME row the emailed link writes, which is what keeps
 * "have they asked to speak to someone?" a single fact for the hiring team
 * rather than two half-answers.
 *
 * Returns null when the request was already on file: the first ask is the
 * record, and a second press must not move the timestamp or notify twice.
 */
export async function recordHumanRequestForSession(opts: {
  sessionId: string;
  candidateId: string;
  tenantId: string;
  now?: Date;
}): Promise<{ requestedAt: Date } | null> {
  const now = opts.now ?? new Date();
  // Two attempts, because the row this writes can be created underneath it by
  // the emailed-link path (issueHumanRequestToken) between the read and the
  // insert. Losing that race used to return null — "already asked" — while the
  // row it lost to was only ISSUED, so the candidate was told a person had
  // their request and nobody had been told anything. The second pass finds the
  // row that won and claims it properly.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await prisma.candidateHumanRequest.findUnique({ where: { sessionId: opts.sessionId } });
    if (existing?.status === 'REQUESTED') return null;

    if (existing) {
      // Conditional on the status just read, so two simultaneous presses cannot
      // both claim it. The expiry is NOT re-checked: unlike the emailed link,
      // this request is authorised by the invitation token the portal route has
      // already resolved, and an aged-out email link must not silence the button
      // on the candidate's own page.
      const { count } = await prisma.candidateHumanRequest.updateMany({
        where: { id: existing.id, status: 'ISSUED' },
        data: { status: 'REQUESTED', requestedAt: now },
      });
      if (count === 0) return null;
      break;
    }

    // No emailed link was ever issued for this session, so there is no row and
    // no token hash to reuse. A hash of fresh random bytes keeps the unique
    // column honest without minting anything that could be used as a link.
    try {
      await prisma.candidateHumanRequest.create({
        data: {
          sessionId: opts.sessionId,
          candidateId: opts.candidateId,
          tenantId: opts.tenantId,
          tokenHash: hashCandidateLinkToken(mintCandidateLinkToken()),
          issuedAt: now,
          expiresAt: new Date(now.getTime() + HUMAN_REQUEST_TTL_DAYS * DAY_MS),
          status: 'REQUESTED',
          requestedAt: now,
        },
      });
      break;
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
      if (attempt === 1) return null;
    }
  }

  await logAudit({
    tenantId: opts.tenantId,
    actorType: 'system',
    actorId: 'candidate-status-page',
    action: 'feedback.human_request.recorded',
    entityType: 'Candidate',
    entityId: opts.candidateId,
    after: { sessionId: opts.sessionId, requestedAt: now, via: 'status-page' },
  });
  return { requestedAt: now };
}

// ---------------------------------------------------------------------------
// What the hiring team is shown
// ---------------------------------------------------------------------------

export interface CandidateFeedbackState {
  optIn: { choice: string; decidedAt: Date; draftStatus: string; draftNote: string } | null;
  draft: { status: string | null; candidateRequested: boolean; assessmentId: string | null; sentAt: Date | null };
  humanRequest: { requested: boolean; requestedAt: Date | null };
}

/**
 * The three facts an owner of this candidate needs: did they ask for feedback,
 * is a draft waiting, and have they asked to speak to someone.
 *
 * Caller-scoped by construction — every route that uses this has already
 * resolved the session or candidate through access.ts, so this never widens
 * what the caller may see.
 */
export async function candidateFeedbackState(sessionIds: string[]): Promise<CandidateFeedbackState> {
  const empty: CandidateFeedbackState = {
    optIn: null,
    draft: { status: null, candidateRequested: false, assessmentId: null, sentAt: null },
    humanRequest: { requested: false, requestedAt: null },
  };
  if (!sessionIds.length) return empty;

  const [optIn, humanRequest, delivery] = await Promise.all([
    prisma.candidateFeedbackOptIn.findFirst({
      where: { sessionId: { in: sessionIds } },
      orderBy: { decidedAt: 'desc' },
    }),
    prisma.candidateHumanRequest.findFirst({
      where: { sessionId: { in: sessionIds }, status: 'REQUESTED' },
      orderBy: { requestedAt: 'desc' },
    }),
    prisma.candidateFeedbackDelivery.findFirst({
      where: { assessment: { sessionId: { in: sessionIds } } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  return {
    optIn: optIn
      ? { choice: optIn.choice, decidedAt: optIn.decidedAt, draftStatus: optIn.draftStatus, draftNote: optIn.draftNote }
      : null,
    draft: {
      status: delivery?.status ?? null,
      candidateRequested: delivery?.candidateRequested ?? false,
      assessmentId: delivery?.assessmentId ?? null,
      sentAt: delivery?.sentAt ?? null,
    },
    humanRequest: {
      requested: Boolean(humanRequest),
      requestedAt: humanRequest?.requestedAt ?? null,
    },
  };
}
