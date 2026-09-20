import { Router } from 'express';
import { invitationLink } from '../services/invitations.js';
import { z } from 'zod';
import { prisma, parseJson, parseJsonOptional } from '../db.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import type { AssessmentResult } from '../domain/types.js';
import { renderReportMarkdown } from '../engines/reportWriter.js';
import { logAudit } from '../services/audit.js';
import { emitEvent } from '../services/webhooks.js';
import { notePipelineEvent } from '../services/pipelineAutonomy.js';
import { atsFailure, requireTenantAts } from '../services/atsConnections.js';
import { findCandidateLink } from '../services/atsRecords.js';
import { getEmail } from '../providers/email/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { candidateFeedbackEnabledForTenant } from '../services/candidateFeedbackPolicy.js';
import { candidateFeedbackState, getOptIn, issueHumanRequestToken } from '../services/candidateFeedback.js';
import { feedbackConsentStatus, feedbackSendBlockReason } from '../services/candidateFeedbackPolicy.js';
import { feedbackConsentView, requestFeedbackOptIn } from '../services/candidateFeedbackOptInRequest.js';
import { renderCandidateFeedbackEmail } from '../providers/email/candidateFeedbackEmail.js';
import { assertCanAccessAssessment, hasCapability, ranTheInterview } from '../services/access.js';
import { demoRecipientBlocked } from '../services/demoPolicy.js';
import { feedbackEmailState, gateReviewCompletion, previewFeedbackEmail, sendFeedbackNow } from '../services/autoFeedback.js';
import { completedReviewFor, recordReviewDifference, reviewDifferenceView } from '../services/assessmentReview.js';
import { applyReviewOverrides, reviewedOutcome } from '../domain/reviewedAssessment.js';
import {
  assertBlindVerdictRecorded, assertUnblindedReadAllowed, getAgreementReport, getBlindView,
  recordBlindVerdict, BLIND_BYPASS_ACTION, DISPOSITIONS, SELF_REVIEW_NOTE,
} from '../services/shadowMode.js';

export const assessmentsRouter = Router();
assessmentsRouter.use(authenticate);

/**
 * Every route below loads its assessment through object scope, not a tenant
 * match. The previous tenant-only loader meant any authenticated user could
 * read, override and export any candidate's assessment in the org.
 */
const getAssessment = assertCanAccessAssessment;

/**
 * Read a stored assessment result, or refuse to serve the assessment at all.
 *
 * `parseJson(a.resultJson, {})` turned a truncated, half-written or
 * older-shaped row into an empty object and served it with a 200. The web
 * rendered "NaN/100" from it, and a reviewer could file a disposition against a
 * screen showing no evidence whatsoever — a signed-off hiring decision based on
 * nothing. A damaged row is an incident for us to fix, not a page to render.
 *
 * `overallScore` is the probe because it is the one field every result shape
 * has carried, and null is a legitimate value for it (see SCORING_UNAVAILABLE).
 */
function readAssessmentResult(assessment: { id: string; resultJson: string }): AssessmentResult {
  const parsed = parseJson<unknown>(assessment.resultJson, null);
  const score = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as { overallScore?: unknown }).overallScore
    : undefined;
  if (!(score === null || typeof score === 'number' && Number.isFinite(score))) {
    logger.error({ assessmentId: assessment.id }, 'Stored assessment result is unreadable; refusing to serve it');
    throw new HttpError(500, 'This assessment could not be read.');
  }
  return parsed as AssessmentResult;
}

// ---------------------------------------------------------------------------
// Shadow mode (see services/shadowMode.ts and docs/VALIDATION.md)
//
// Route order matters: these literal paths MUST be declared before '/:id',
// otherwise Express matches '/shadow-metrics' as an assessment id and the
// metrics endpoint 404s.
// ---------------------------------------------------------------------------

// Scoring-validity metrics across the tenant. Deliberately readable by any
// authenticated user: a reviewer being asked to trust the AI's score is
// entitled to see whether that score has ever been shown to agree with anyone.
assessmentsRouter.get('/shadow-metrics', asyncHandler(async (req, res) => {
  const report = await getAgreementReport(req.auth!.tenantId);
  res.json(report);
}));

// The blinded assessment: evidence, transcript and competency definitions, with
// every AI conclusion withheld so the reviewer forms an independent judgement.
assessmentsRouter.get('/:id/blind', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  // Gated on assessment:review rather than assessment:read: the blind view is
  // the reviewer's working surface, and its whole purpose is to be seen only by
  // someone who is about to file an independent verdict.
  const view = await getBlindView(req.auth!, req.params.id);
  res.json(view);
}));

/**
 * Ceilings on the free text and the arrays these routes accept.
 *
 * Everything posted here is stored, re-read on every later request, and
 * rendered into the compliance record a regulator reads. A type check alone let
 * an authenticated caller file a hundred-thousand-character reason or ten
 * thousand competency overrides. 20k characters is far above any real reviewer
 * note, and no scorecard carries 40 competencies.
 */
const MAX_TEXT_CHARS = 20_000;
const MAX_COMPETENCY_ENTRIES = 40;

// .strict() throughout: these body shapes are closed, and a typo'd field name
// must fail loudly rather than be dropped. A reviewer whose "commments" went
// nowhere still believes they filed them.
const blindVerdictSchema = z.object({
  disposition: z.enum(DISPOSITIONS),
  reason: z.string().min(3).max(MAX_TEXT_CHARS),
  comments: z.string().max(MAX_TEXT_CHARS).optional(),
  competencyLevels: z.array(z.object({
    competencyId: z.string().min(1).max(200),
    level: z.number().int().min(1).max(5),
    reason: z.string().max(MAX_TEXT_CHARS).optional(),
  }).strict()).max(MAX_COMPETENCY_ENTRIES).default([]),
}).strict();

assessmentsRouter.post('/:id/blind-verdict', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  const body = blindVerdictSchema.parse(req.body);
  // recordBlindVerdict resolves the reviewer from the caller's own claims and
  // records — without blocking — whether they drove this interview themselves.
  const { reviewId, recordedAt, selfReview } = await recordBlindVerdict(req.auth!, req.params.id, body);
  // Audited because the ORDER of these events is the compliance artefact: it is
  // what shows the human judgement preceded, rather than echoed, the machine's.
  // selfReview rides along so a later audit can find non-independent reviews
  // without reparsing every comments field.
  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'review.blind_verdict',
    entityType: 'AssessmentVersion', entityId: req.params.id,
    after: { reviewId, disposition: body.disposition, competencyCount: body.competencyLevels.length, recordedAt, selfReview },
  });
  res.status(201).json({ reviewId, recordedAt, selfReview, revealUrl: `/api/assessments/${req.params.id}/reveal` });
}));

// Reveal — refuses until this reviewer has recorded their own verdict.
assessmentsRouter.get('/:id/reveal', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!, req.params.id);
  await assertBlindVerdictRecorded(a.id, req.auth!.userId);
  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'review.ai_revealed',
    entityType: 'AssessmentVersion', entityId: a.id, after: { recommendation: a.recommendation },
  });
  res.json({
    id: a.id,
    result: readAssessmentResult(a),
    note: 'Advisory only. Agreement between this output and blind human review has not been established — '
      + 'see GET /api/assessments/shadow-metrics and docs/VALIDATION.md.',
  });
}));


// Capped as well as floored. `approvedText` is emailed verbatim to the
// candidate, so an unbounded field is an unbounded message going out over our
// domain with our branding on it — and 20k characters is already far more than
// any real piece of interview feedback.
const feedbackTextSchema = z.object({ draftText: z.string().min(10).max(MAX_TEXT_CHARS) }).strict();
const feedbackApprovalSchema = z.object({ approvedText: z.string().min(10).max(MAX_TEXT_CHARS) }).strict();

function presentFeedback(feedback: {
  id: string;
  assessmentId: string;
  draftText: string;
  approvedText: string | null;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  sentAt: Date | null;
  status: string;
  candidateRequested: boolean;
  createdAt: Date;
}) {
  return {
    id: feedback.id,
    assessmentId: feedback.assessmentId,
    draftText: feedback.draftText,
    approvedText: feedback.approvedText,
    approvedByUserId: feedback.approvedByUserId,
    approvedAt: feedback.approvedAt,
    sentAt: feedback.sentAt,
    status: feedback.status,
    // Tells the reviewer that a real person is waiting on this one, rather than
    // it being a draft somebody on the team started.
    candidateRequested: feedback.candidateRequested,
    createdAt: feedback.createdAt,
  };
}

async function assertCompletedHumanReview(assessmentId: string): Promise<void> {
  const completed = await prisma.humanReview.findFirst({ where: { assessmentId, status: 'COMPLETED' }, select: { id: true } });
  if (!completed) throw new HttpError(409, 'Candidate feedback can only be drafted after a completed human review.');
}

assessmentsRouter.post('/:id/feedback/draft', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  const body = feedbackTextSchema.parse(req.body);
  const a = await getAssessment(req.auth!, req.params.id);
  await assertCompletedHumanReview(a.id);

  const existing = await prisma.candidateFeedbackDelivery.findUnique({ where: { assessmentId: a.id } });
  // What a candidate has been sent is a record, not a draft: rewriting it would
  // erase the delivered text and could replace what they already read.
  if (existing?.status === 'SENT') {
    throw new HttpError(409, 'This feedback has already been sent to the candidate and can no longer be changed.');
  }
  // Mid-send: rewriting now would clear the approved text the email is carrying.
  if (existing?.status === 'SENDING') {
    throw new HttpError(409, 'This feedback is being sent right now. Refresh in a moment.');
  }
  const feedback = await prisma.candidateFeedbackDelivery.upsert({
    where: { assessmentId: a.id },
    create: { assessmentId: a.id, draftText: body.draftText, status: 'DRAFT' },
    update: {
      draftText: body.draftText,
      approvedText: null,
      approvedByUserId: null,
      approvedAt: null,
      sentAt: null,
      status: 'DRAFT',
    },
  });
  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'feedback.drafted',
    entityType: 'AssessmentVersion', entityId: a.id,
    before: existing ? { status: existing.status, approvedAt: existing.approvedAt, sentAt: existing.sentAt } : undefined,
    after: { feedbackId: feedback.id, status: feedback.status },
  });
  res.status(existing ? 200 : 201).json({ feedback: presentFeedback(feedback) });
}));

assessmentsRouter.post('/:id/feedback/approve', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  const body = feedbackApprovalSchema.parse(req.body);
  const a = await getAssessment(req.auth!, req.params.id);
  // Asserted here as well as on the draft route. A draft can now also arrive by
  // the candidate asking for feedback at the end of their interview, and that
  // path must not become a way round the human-review gate: without this, a
  // candidate-requested draft could be approved and sent by someone who had
  // never read the transcript.
  await assertCompletedHumanReview(a.id);
  const existing = await prisma.candidateFeedbackDelivery.findUnique({ where: { assessmentId: a.id } });
  if (!existing || existing.status !== 'DRAFT') throw new HttpError(409, 'Candidate feedback must be in DRAFT status before approval.');

  const feedback = await prisma.candidateFeedbackDelivery.update({
    where: { assessmentId: a.id },
    data: { approvedText: body.approvedText, approvedByUserId: req.auth!.userId, approvedAt: new Date(), status: 'APPROVED' },
  });
  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'feedback.approved',
    entityType: 'AssessmentVersion', entityId: a.id,
    before: { feedbackId: existing.id, status: existing.status },
    after: { feedbackId: feedback.id, status: feedback.status, approvedByUserId: req.auth!.userId, approvedAt: feedback.approvedAt },
  });
  res.json({ feedback: presentFeedback(feedback) });
}));

/**
 * How long a send may hold its claim before another attempt may take it over.
 * A claim that outlives this belongs to a request that died mid-send (process
 * restart, crash); without a ceiling that feedback could never be sent.
 */
const FEEDBACK_SEND_CLAIM_STALE_MS = 10 * 60_000;

assessmentsRouter.post('/:id/feedback/send', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!, req.params.id);
  const existing = await prisma.candidateFeedbackDelivery.findUnique({ where: { assessmentId: a.id } });
  if (!existing || (existing.status !== 'APPROVED' && existing.status !== 'SENDING')) {
    throw new HttpError(409, 'Candidate feedback must be approved before it can be sent.');
  }
  if (!await candidateFeedbackEnabledForTenant(req.auth!.tenantId)) {
    throw new HttpError(409, 'Candidate feedback delivery is disabled for this tenant.');
  }

  // Only a candidate who said yes is emailed. Checked at the last gate before
  // anything leaves rather than only at draft time: the answer can be recorded
  // after a draft was written, and this is the only place that actually sends.
  //
  // No answer on file blocks as firmly as a no. It covers recruiter-driven
  // interviews and everything from before the question existed; the recruiter
  // is told which of the two it is, and can ask (POST .../opt-in-request).
  const blockReason = feedbackSendBlockReason(feedbackConsentStatus(await getOptIn(a.sessionId)));
  if (blockReason) throw new HttpError(409, blockReason);

  // Claim before sending. Two reviewers pressing Send together both passed the
  // APPROVED check above and both emailed the candidate; the conditional
  // update lets exactly one through. SENDING is transient: `sentAt` holds the
  // claim time so an abandoned claim can be taken over (see the stale window).
  const claimedAt = new Date();
  const claim = await prisma.candidateFeedbackDelivery.updateMany({
    where: {
      assessmentId: a.id,
      OR: [
        { status: 'APPROVED' },
        { status: 'SENDING', sentAt: { lt: new Date(claimedAt.getTime() - FEEDBACK_SEND_CLAIM_STALE_MS) } },
      ],
    },
    data: { status: 'SENDING', sentAt: claimedAt },
  });
  if (claim.count !== 1) throw new HttpError(409, 'This feedback is already being sent. Refresh to see whether it went.');

  const session = await prisma.interviewSession.findUnique({
    where: { id: a.sessionId },
    include: { candidate: { select: { email: true } }, role: { select: { title: true } }, invitation: { select: { tokenSealed: true } } },
  });
  const portalUrl = session?.invitation ? invitationLink(session.invitation) : null;

  let outcome: { delivered: boolean; deliveryNote: string };
  try {
    outcome = await notifyCandidateOfFeedback(req.auth!.tenantId, a.id, session, existing.approvedText ?? '');
  } catch (err) {
    // Hand the claim back so the send can be retried. SENT used to be written
    // before the email went, so one failed send released the feedback to the
    // portal, told nobody, and could never be attempted again.
    await prisma.candidateFeedbackDelivery.updateMany({
      where: { assessmentId: a.id, status: 'SENDING', sentAt: claimedAt },
      data: { status: 'APPROVED', sentAt: null },
    });
    throw err;
  }

  // SENT means released to the candidate's portal. Whether the candidate was
  // actually TOLD is a separate fact, reported honestly in `delivery` — a
  // non-delivering provider or the demo sandbox still releases it, and HR is
  // handed the link to share.
  const feedback = await prisma.candidateFeedbackDelivery.update({
    where: { assessmentId: a.id },
    data: { sentAt: new Date(), status: 'SENT' },
  });

  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'feedback.sent',
    entityType: 'AssessmentVersion', entityId: a.id,
    before: { feedbackId: existing.id, status: existing.status },
    after: { feedbackId: feedback.id, status: feedback.status, sentAt: feedback.sentAt, candidateNotified: outcome.delivered },
  });
  await emitEvent(req.auth!.tenantId, 'feedback.sent', { assessmentId: a.id, feedbackId: feedback.id, candidateNotified: outcome.delivered });
  res.json({ feedback: presentFeedback(feedback), delivery: { delivered: outcome.delivered, portalUrl, deliveryNote: outcome.deliveryNote } });
}));

type FeedbackSession = {
  readonly id: string;
  readonly candidateId: string;
  readonly candidate: { readonly email: string };
  readonly role: { readonly title: string };
} | null;

/**
 * Email the candidate their approved feedback, when there is a way to.
 *
 * Returns a delivery report for the cases where nothing could be emailed but
 * the feedback is still released (no delivering provider, the demo sandbox).
 * Throws 502 when an email was attempted and failed, so the caller can hand
 * back its claim and the reviewer can try again.
 */
async function notifyCandidateOfFeedback(
  tenantId: string, assessmentId: string, session: FeedbackSession, approvedText: string,
): Promise<{ delivered: boolean; deliveryNote: string }> {
  if (!session) {
    return { delivered: false, deliveryNote: 'This interview no longer exists, so nothing could be sent. Contact the candidate directly.' };
  }
  if (await demoRecipientBlocked(tenantId, session.candidate.email)) {
    return { delivered: false, deliveryNote: 'In the demo, email goes only to you, so this feedback was not sent to the candidate address.' };
  }
  const email = getEmail();
  if (!email.delivers) {
    return { delivered: false, deliveryNote: `Email is not configured to deliver (provider "${email.name}"). Share the candidate's link yourself.` };
  }
  // The offer to speak to a person rides in this email and nowhere else, so
  // the link is minted here — once, for the single message that carries it.
  // Failing to mint costs the offer, never the feedback.
  let talkUrl: string | null = null;
  try {
    const requestToken = await issueHumanRequestToken({ sessionId: session.id, candidateId: session.candidateId, tenantId });
    talkUrl = `${config.webOrigin.replace(/\/+$/, '')}/talk-to-a-person/${requestToken}`;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), assessmentId },
      'Could not issue a talk-to-a-person link; the feedback email will go without the offer',
    );
  }
  try {
    // What the reviewer approved, verbatim. The draft is never what goes out.
    await email.send(renderCandidateFeedbackEmail({ to: session.candidate.email, roleTitle: session.role.title, approvedText, talkUrl }));
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), assessmentId }, 'Feedback email failed');
    throw new HttpError(502, 'The feedback email could not be sent, so it has not been released to the candidate. Try again.');
  }
  return { delivered: true, deliveryNote: `Sent to ${session.candidate.email}.` };
}

assessmentsRouter.get('/:id/feedback', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!, req.params.id);
  const feedback = await prisma.candidateFeedbackDelivery.findUnique({ where: { assessmentId: a.id } });
  const session = await prisma.interviewSession.findUniqueOrThrow({
    where: { id: a.sessionId },
    select: { id: true, tenantId: true, completedAt: true },
  });
  const [state, consent] = await Promise.all([candidateFeedbackState([a.sessionId]), feedbackConsentView(session)]);
  res.json({
    feedback: feedback ? presentFeedback(feedback) : null,
    optIn: state.optIn,
    humanRequest: state.humanRequest,
    // Whether this can be sent and, if not, why — so the send button can say so
    // before anyone presses it.
    consent,
  });
}));

// Ask a candidate with no answer on file whether they want written feedback.
// Same capability as sending: it is the step that makes sending possible.
assessmentsRouter.post('/:id/feedback/opt-in-request', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  const a = await getAssessment(req.auth!, req.params.id);
  const request = await requestFeedbackOptIn({
    sessionId: a.sessionId, tenantId: req.auth!.tenantId, requestedByUserId: req.auth!.userId,
  });
  res.json({ request });
}));

// ---------------------------------------------------------------------------
// The automatic feedback email (services/autoFeedback.ts)
//
// Read with assessment:read: a recruiter following the candidate should see
// "Feedback sent on <date>" and what it said. Preview and send need
// assessment:review, the same capability as the reviewed feedback flow above.
// The bodies are empty and closed: nothing about the message — recipient,
// wording — is taken from the request.
// ---------------------------------------------------------------------------

assessmentsRouter.get('/:id/feedback-email', requireCapability('assessment:read'), asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!, req.params.id);
  res.json(await feedbackEmailState(a.sessionId));
}));

assessmentsRouter.post('/:id/feedback-email/preview', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  const a = await getAssessment(req.auth!, req.params.id);
  res.json({ preview: await previewFeedbackEmail({ sessionId: a.sessionId, assessmentId: a.id }) });
}));

// The only field here is the one refusal a person may override: a send that
// reached the mail provider but could not be confirmed. It is opt-in per
// request and recorded, so "who chose to risk a second copy" has an answer.
const sendFeedbackEmailSchema = z.object({ confirmPossibleDuplicate: z.boolean().optional() }).strict();

assessmentsRouter.post('/:id/feedback-email/send', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  const body = sendFeedbackEmailSchema.parse(req.body ?? {});
  const a = await getAssessment(req.auth!, req.params.id);
  res.json(await sendFeedbackNow({
    sessionId: a.sessionId, assessmentId: a.id, userId: req.auth!.userId, tenantId: req.auth!.tenantId,
    confirmPossibleDuplicate: body.confirmPossibleDuplicate,
  }));
}));

assessmentsRouter.get('/:id', requireCapability('assessment:read'), asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!, req.params.id);
  // Where the organisation requires blind-first review, it is enforced here and
  // not just offered in the UI. Otherwise a reviewer reaches the score by
  // typing the URL, and the independence that keeps this advisory rather than
  // automated is lost without anyone noticing.
  await assertUnblindedReadAllowed({
    assessmentId: a.id, userId: req.auth!.userId, canReview: hasCapability(req.auth!, 'assessment:review'),
    tenantId: req.auth!.tenantId,
  });
  const reviews = await prisma.humanReview.findMany({ where: { assessmentId: a.id }, orderBy: { createdAt: 'desc' } });
  const result = readAssessmentResult(a);
  // The three readings the page shows side by side: what the AI produced, what
  // the reviewer left, and where the two differ. All of it derived from the
  // review already stored (services/assessmentReview.ts), so the comparison
  // can be analysed later without a second copy of the truth.
  const completed = await completedReviewFor(a.id);
  res.json({
    id: a.id,
    sessionId: a.sessionId,
    candidate: { id: a.session.candidateId, name: a.session.candidate.fullName },
    role: { id: a.session.roleId, title: a.session.role.title },
    result,
    reviews: reviews.map((r) => ({ id: r.id, status: r.status, disposition: r.disposition, reason: r.reason, overrides: parseJsonOptional(r.overridesJson, [], { model: 'HumanReview', id: r.id, field: 'overridesJson' }), completedAt: r.completedAt })),
    reviewed: completed
      ? {
        result: applyReviewOverrides(result, completed),
        review: {
          id: completed.id, reviewerId: completed.reviewerId, disposition: completed.disposition,
          reason: completed.reason, comments: completed.comments, completedAt: completed.completedAt,
        },
      }
      : null,
    differences: await reviewDifferenceView(req.auth!.tenantId, a.id, completed),
    // What the rest of the product should report: the human verdict once there
    // is one, the AI's until then.
    outcome: reviewedOutcome(result, completed),
  });
}));

assessmentsRouter.get('/:id/report', requireCapability('assessment:read'), asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!, req.params.id);
  // The report is the same conclusions in prose — gating /:id but not this would
  // leave the front door locked and the back door open.
  await assertUnblindedReadAllowed({
    assessmentId: a.id, userId: req.auth!.userId, canReview: hasCapability(req.auth!, 'assessment:review'),
    tenantId: req.auth!.tenantId,
  });
  const result = readAssessmentResult(a);
  const md = renderReportMarkdown({ candidateName: a.session.candidate.fullName, roleTitle: a.session.role.title, assessment: result });
  if (req.query.format === 'json') return res.json({ report: md, result });
  res.type('text/markdown').send(md);
}));

/**
 * Break glass: open the assessment without recording a blind verdict first.
 *
 * A lock with no escape does not produce blind reviews — it produces a shared
 * admin login, which costs the audit trail as well as the independence. There
 * are legitimate reasons to skip (re-reading a candidate you already decided on
 * elsewhere, a compliance check, debugging a bad report), so the escape exists.
 *
 * What it does NOT do is happen quietly: it demands a reason, records it against
 * the user, and surfaces in shadow-metrics as a review that skipped blinding, so
 * a team that bypasses habitually is visible rather than assumed compliant.
 */
assessmentsRouter.post('/:id/skip-blind-review', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  const { reason } = z.object({
    reason: z.string().min(10, 'Give a real reason (at least 10 characters).').max(MAX_TEXT_CHARS),
  }).strict().parse(req.body);
  const a = await getAssessment(req.auth!, req.params.id);
  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user',
    action: BLIND_BYPASS_ACTION, entityType: 'AssessmentVersion', entityId: a.id,
    after: { reason },
  });
  res.status(201).json({ ok: true, bypassed: true });
}));

// Human review / override (FR-033)
const reviewSchema = z.object({
  disposition: z.enum(['PROCEED', 'CONSIDER', 'DO_NOT_PROGRESS']),
  reason: z.string().min(3).max(MAX_TEXT_CHARS),
  comments: z.string().max(MAX_TEXT_CHARS).optional(),
  // `from`/`to` stay open because an override may restate a level, a null, or a
  // future scale — but `unknown` rather than `any`, so nothing downstream can
  // treat them as a known shape without narrowing first.
  overrides: z.array(z.object({
    competencyId: z.string().min(1).max(200),
    from: z.unknown(),
    to: z.unknown(),
    reason: z.string().max(MAX_TEXT_CHARS),
  }).strict()).max(MAX_COMPETENCY_ENTRIES).default([]),
  // Replacing a completed review is deliberate: it needs saying, and a reason,
  // because the candidate may already have been written to on the strength of
  // the first one.
  supersede: z.object({ reason: z.string().min(10, 'Give a real reason (at least 10 characters).').max(MAX_TEXT_CHARS) }).strict().optional(),
}).strict();
assessmentsRouter.post('/:id/review', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!, req.params.id);
  const body = reviewSchema.parse(req.body);

  // "Final" has to mean something. Once a review is completed it is the
  // version the team acts on and the version the candidate's feedback is
  // written from, so a second one does not quietly replace it.
  const previous = await completedReviewFor(a.id);
  if (previous && !body.supersede) {
    throw new HttpError(409, 'This assessment has already been reviewed. To replace that review, say that you mean to and give a reason.');
  }

  // Separation of duties, recorded rather than enforced.
  //
  // A reviewer signing off the interview they personally drove is the weakest
  // form of the "meaningful human review" that keeps this pipeline advisory
  // under GDPR Art. 22 and NYC LL144. It is NOT hard-blocked: a small recruiting
  // team may genuinely have nobody else available, and a 403 here does not
  // conjure an independent reviewer — it pushes the work onto a shared admin
  // login, which costs us the audit trail as well as the independence. Stamping
  // it on the review row and the audit event makes the missing independence
  // visible in the compliance record instead of absent from it.
  const selfReview = await ranTheInterview(req.auth!.userId, a.sessionId);
  const comments = body.comments ?? '';
  // The review and the release of the candidate's letter are one transaction:
  // the gate refuses (409 feedback_sending) while a send holds the row, and
  // the review then does not exist — the email cannot be unsent, so the
  // review is what waits. When the gate opens, the review becomes visible in
  // the same commit that releases the letter, so no send can read one
  // without the other (services/autoFeedback.ts).
  const { review, feedbackReleased } = await prisma.$transaction(async (tx) => {
    const released = await gateReviewCompletion(tx, a.id);
    const created = await tx.humanReview.create({
      data: {
        assessmentId: a.id, reviewerId: req.auth!.userId, status: 'COMPLETED', disposition: body.disposition,
        reason: body.reason,
        comments: selfReview ? (comments ? `${comments}\n\n${SELF_REVIEW_NOTE}` : SELF_REVIEW_NOTE) : comments,
        overridesJson: JSON.stringify(body.overrides), completedAt: new Date(),
      },
    });
    return { review: created, feedbackReleased: released };
  });
  // Session -> HUMAN_REVIEWED -> CLOSED
  if (a.session.state === 'REVIEW_READY') {
    await prisma.interviewSession.update({ where: { id: a.sessionId }, data: { state: 'HUMAN_REVIEWED' } });
  }
  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'review.completed',
    entityType: 'AssessmentVersion', entityId: a.id,
    before: { recommendation: a.recommendation },
    after: { disposition: body.disposition, reason: body.reason, selfReview },
  });
  await emitEvent(req.auth!.tenantId, 'review.completed', { assessmentId: a.id, disposition: body.disposition });
  // A reviewed interview is an assessed one: Gold, if the finalisation had not already got there.
  await notePipelineEvent({ tenantId: req.auth!.tenantId, candidateId: a.session.candidateId, roleId: a.session.roleId, event: 'interview.assessed', trigger: 'review.completed' });
  if (previous && body.supersede) {
    await prisma.humanReview.update({ where: { id: previous.id }, data: { supersededAt: new Date(), supersededReason: body.supersede.reason } });
    await logAudit({
      tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'review.superseded',
      entityType: 'AssessmentVersion', entityId: a.id,
      before: { reviewId: previous.id, disposition: previous.disposition },
      after: { reviewId: review.id, supersededReviewId: previous.id, disposition: body.disposition, reason: body.supersede.reason },
    });
  }
  // Where this reviewer parted company with the AI, kept for later analysis
  // (services/assessmentReview.ts). Written now, at the moment the fact exists.
  await recordReviewDifference(req.auth!.tenantId, a.id, review.id);
  res.status(201).json({ review: { id: review.id, disposition: review.disposition, selfReview }, feedbackReleased });
}));

// Export to ATS (FR-040)
//
// The ATS candidate is the one stored against this candidate for the caller's
// own ATS (services/atsRecords.ts), never one named in the request. A caller-
// supplied id let anyone with export rights write an assessment onto whichever
// ATS record they typed.
const exportSchema = z.object({}).strict();

export const ATS_LINK_MISSING = 'ATS_LINK_MISSING';

assessmentsRouter.post('/:id/export', requireCapability('assessment:export'), asyncHandler(async (req, res) => {
  const raw: unknown = req.body ?? {};
  if (typeof raw === 'object' && raw !== null && 'externalCandidateId' in raw) {
    throw new HttpError(400, "The ATS candidate comes from the candidate's stored ATS link; it cannot be given with the export. An administrator can set the link on the candidate page.");
  }
  exportSchema.parse(raw);
  const a = await getAssessment(req.auth!, req.params.id);
  const result = readAssessmentResult(a);
  // An assessment with no score must not reach the system of record. The ATS
  // has no way to render "unavailable": it stores whatever number arrives, and
  // a 0 born of a grading outage becomes a permanent hiring signal that nobody
  // can trace back to our vendor being down.
  if (result.overallScore === null) {
    throw new HttpError(409, 'This assessment could not be scored, so there is nothing to export. It needs a human assessment first.');
  }
  const { connection, client } = await requireTenantAts(req.auth!.tenantId);
  const link = await findCandidateLink(req.auth!.tenantId, a.session.candidateId, connection.id);
  if (!link) {
    throw new HttpError(409, 'This candidate is not linked to a candidate in your ATS yet. An administrator can link them from the candidate page.', ATS_LINK_MISSING);
  }
  const out = await client.pushAssessment(link.externalCandidateId, {
    candidate: a.session.candidate.fullName, role: a.session.role.title,
    recommendation: result.recommendation, confidence: result.confidence, overallScore: result.overallScore,
    competencies: result.competencies.map((c) => ({ name: c.name, level: c.level })),
  }).catch((err: unknown) => atsFailure(err, 'candidate'));
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'assessment.exported', entityType: 'AssessmentVersion', entityId: a.id, after: out });
  res.json(out);
}));
