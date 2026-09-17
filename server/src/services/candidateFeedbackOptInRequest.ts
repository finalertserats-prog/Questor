import { prisma } from '../db.js';
import { config } from '../config.js';
import { HttpError } from '../middleware/index.js';
import { logger } from '../logger.js';
import { getEmail } from '../providers/email/index.js';
import { renderFeedbackOptInRequestEmail } from '../providers/email/feedbackOptInRequestEmail.js';
import { logAudit } from './audit.js';
import { getOptIn, recordFeedbackOptIn } from './candidateFeedback.js';
import {
  candidateFeedbackEnabledForTenant, feedbackConsentStatus, feedbackSendBlockReason, type FeedbackConsentStatus,
} from './candidateFeedbackPolicy.js';
import { DAY_MS, hashCandidateLinkToken, mintCandidateLinkToken, resolveCandidateLink } from './candidateLinkToken.js';

/**
 * Asking a candidate who was never asked whether they want written feedback.
 *
 * Feedback goes only to an explicit yes, so this is the hiring team's one way
 * forward for an interview with no answer on file. It sends a question and
 * nothing else. The answer is recorded by recordFeedbackOptIn — the same
 * once-only path as the end-of-interview question — so a decline given here is
 * as final as one given there.
 *
 * Only a candidate who has not answered can be asked. Asking someone who said
 * no until they say yes is not consent.
 */

export const OPT_IN_REQUEST_TTL_DAYS = 30;
/** A recruiter double-clicking, or re-asking in a loop, must not fill a candidate's inbox. */
export const OPT_IN_REQUEST_COOLDOWN_MS = 60 * 60_000;

export interface FeedbackConsentView {
  status: FeedbackConsentStatus;
  canSend: boolean;
  /** Why sending is refused, in words the recruiter can act on. */
  blockReason: string | null;
  canRequest: boolean;
  /** Why asking is refused, when it is. */
  requestBlockReason: string | null;
  /** The latest request still on file, if any. */
  request: { issuedAt: Date; expiresAt: Date } | null;
}

interface ConsentSession {
  id: string;
  tenantId: string;
  completedAt: Date | null;
}

async function requestBlockReason(session: ConsentSession, status: FeedbackConsentStatus): Promise<string | null> {
  if (status === 'DECLINED') return 'Candidate declined written feedback, and is not asked again.';
  if (status === 'OPTED_IN') return 'Candidate has already opted in.';
  if (!await candidateFeedbackEnabledForTenant(session.tenantId)) {
    return 'Candidate feedback is switched off for this organisation.';
  }
  if (!session.completedAt) return 'The interview has not finished yet.';
  return null;
}

/** Everything the recruiter's feedback panel needs to say about consent. */
export async function feedbackConsentView(session: ConsentSession): Promise<FeedbackConsentView> {
  const [optIn, request] = await Promise.all([
    getOptIn(session.id),
    prisma.candidateFeedbackOptInRequest.findUnique({
      where: { sessionId: session.id },
      select: { issuedAt: true, expiresAt: true },
    }),
  ]);
  const status = feedbackConsentStatus(optIn);
  const blockReason = feedbackSendBlockReason(status);
  const cannotRequest = await requestBlockReason(session, status);
  return {
    status,
    canSend: blockReason === null,
    blockReason,
    canRequest: cannotRequest === null,
    requestBlockReason: cannotRequest,
    request,
  };
}

/**
 * Email the candidate a link to answer. Refuses — before any link exists —
 * when the candidate may not be asked or email cannot reach them: a link
 * nobody receives is a request the recruiter believes was made.
 */
export async function requestFeedbackOptIn(opts: {
  sessionId: string;
  tenantId: string;
  requestedByUserId: string;
  now?: Date;
}): Promise<{ issuedAt: Date; expiresAt: Date }> {
  const session = await prisma.interviewSession.findFirst({
    where: { id: opts.sessionId, tenantId: opts.tenantId },
    select: {
      id: true, tenantId: true, candidateId: true, completedAt: true,
      candidate: { select: { email: true } }, role: { select: { title: true } },
    },
  });
  if (!session) throw new HttpError(404, 'Interview not found');

  const refusal = await requestBlockReason(session, feedbackConsentStatus(await getOptIn(session.id)));
  if (refusal) throw new HttpError(409, refusal);

  const issuedAt = opts.now ?? new Date();
  const previous = await prisma.candidateFeedbackOptInRequest.findUnique({
    where: { sessionId: session.id }, select: { issuedAt: true },
  });
  if (previous && issuedAt.getTime() - previous.issuedAt.getTime() < OPT_IN_REQUEST_COOLDOWN_MS) {
    throw new HttpError(429, 'A request was sent to this candidate less than an hour ago. Please give them time to answer.');
  }

  const email = getEmail();
  if (!email.delivers) {
    throw new HttpError(409, `Email is not configured to deliver (provider "${email.name}"), so the request could not reach the candidate.`);
  }

  const expiresAt = new Date(issuedAt.getTime() + OPT_IN_REQUEST_TTL_DAYS * DAY_MS);
  const token = mintCandidateLinkToken();
  // Replacing the hash retires any earlier link: only the newest email works.
  await prisma.candidateFeedbackOptInRequest.upsert({
    where: { sessionId: session.id },
    create: {
      sessionId: session.id, candidateId: session.candidateId, tenantId: session.tenantId,
      tokenHash: hashCandidateLinkToken(token), requestedByUserId: opts.requestedByUserId, issuedAt, expiresAt,
    },
    update: { tokenHash: hashCandidateLinkToken(token), requestedByUserId: opts.requestedByUserId, issuedAt, expiresAt },
  });

  try {
    await email.send(renderFeedbackOptInRequestEmail({
      to: session.candidate.email,
      roleTitle: session.role.title,
      consentUrl: `${config.webOrigin.replace(/\/+$/, '')}/feedback-consent/${token}`,
      ttlDays: OPT_IN_REQUEST_TTL_DAYS,
    }));
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), sessionId: session.id }, 'Feedback opt-in request email failed');
    throw new HttpError(502, 'The request email could not be sent. Please try again.');
  }

  await logAudit({
    tenantId: session.tenantId,
    actorType: 'user',
    actorId: opts.requestedByUserId,
    action: 'feedback.optin.requested',
    entityType: 'InterviewSession',
    entityId: session.id,
    after: { issuedAt, expiresAt },
  });
  return { issuedAt, expiresAt };
}

async function resolveOptInRequest(token: string, now?: Date) {
  return resolveCandidateLink({
    token,
    now,
    findByHash: (tokenHash) => prisma.candidateFeedbackOptInRequest.findUnique({ where: { tokenHash } }),
    expiredMessage: 'This link has expired. If you would still like feedback, please reply to the email it came in.',
  });
}

/** Open or already answered — and nothing else, not even which answer. */
export async function optInLinkState(token: string): Promise<'open' | 'answered'> {
  const row = await resolveOptInRequest(token);
  return await getOptIn(row.sessionId) ? 'answered' : 'open';
}

export async function answerOptInRequest(token: string, wantsFeedback: boolean): Promise<{ created: boolean }> {
  const row = await resolveOptInRequest(token);
  const { created } = await recordFeedbackOptIn({ sessionId: row.sessionId, wantsFeedback, via: 'emailed-request' });
  return { created };
}
