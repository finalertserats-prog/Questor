import { Router } from 'express';
import { invitationLink } from '../services/invitations.js';
import { z } from 'zod';
import { prisma, parseJson, parseJsonOptional } from '../db.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import type { AssessmentResult } from '../domain/types.js';
import { renderReportMarkdown } from '../engines/reportWriter.js';
import { logAudit } from '../services/audit.js';
import { emitEvent } from '../services/webhooks.js';
import { notePipelineEvent, noteReviewDecision } from '../services/pipelineAutonomy.js';
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
import { keepFeedbackHeld } from '../services/feedbackHold.js';
import { completedReviewFor, recordReviewDifference, reviewDifferenceView } from '../services/assessmentReview.js';
import { recordCalibrationObservations } from '../services/calibrationCapture.js';
import { recordLibraryReviewerDelta } from '../services/calibrationAnchors.js';
import { assessmentCalibration } from '../domain/calibrationView.js';
import { applyReviewOverrides, reviewedOutcome } from '../domain/reviewedAssessment.js';
import { questionsAskedFor, type AskedQuestion } from '../library/questionsAsked.js';
import { identityPanelFor } from '../services/identityPanel.js';
import {
  assertBlindVerdictRecorded, assertUnblindedReadAllowed, getAgreementReport, getBlindView,
  recordBlindVerdict, BLIND_BYPASS_ACTION, DISPOSITIONS, SELF_REVIEW_NOTE,
} from '../services/shadowMode.js';
import { servingModeForSession } from '../services/interviewServing.js';
import { recordAssessmentOpened } from '../services/assessmentViews.js';
import { VERDICTS, decisionOfVerdict } from '../domain/verdict.js';
import { journeyFor, journeyMove, journeyStanding, type JourneyMove } from '../services/verdictJourney.js';
import { DEFAULT_STAGES, parseStages } from '../domain/pipelineStages.js';
import { assessmentReviewRequirement } from '../services/humanReviewGate.js';
import { humanReviewRefusal, HUMAN_REVIEW_REQUIRED } from '../domain/humanReviewRule.js';
import { assertTranscriptRead, recordTranscriptRead, transcriptReadBy } from '../services/transcriptReadGate.js';
import { ATTESTATION_MAX, ATTESTATION_MIN, READ_METHODS } from '../domain/transcriptRead.js';

export const assessmentsRouter = Router();
assessmentsRouter.use(authenticate);

/**
 * Every route below loads its assessment through object scope, not a tenant
 * match. The previous tenant-only loader meant any authenticated user could
 * read, override and export any candidate's assessment in the org.
 */
const getAssessment = assertCanAccessAssessment;

async function questionsAskedField(sessionId: string): Promise<{ questionsAsked?: AskedQuestion[] }> {
  const asked = await questionsAskedFor(sessionId);
  return asked ? { questionsAsked: asked } : {};
}

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
  // After the access check: HR-Box tells colleagues this has been opened.
  await recordAssessmentOpened(req.auth!, req.params.id);
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
  // One vocabulary (domain/verdict.ts): the field is the verdict here too, so
  // the blind read and the open one are recorded in the same words.
  verdict: z.enum(VERDICTS),
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
  const { reviewId, recordedAt, selfReview } = await recordBlindVerdict(req.auth!, req.params.id, { ...body, disposition: body.verdict });
  // Audited because the ORDER of these events is the compliance artefact: it is
  // what shows the human judgement preceded, rather than echoed, the machine's.
  // selfReview rides along so a later audit can find non-independent reviews
  // without reparsing every comments field.
  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'review.blind_verdict',
    entityType: 'AssessmentVersion', entityId: req.params.id,
    after: { reviewId, verdict: body.verdict, competencyCount: body.competencyLevels.length, recordedAt, selfReview },
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

// A held letter (services/feedbackHold.ts) is shown to everyone who can read
// the assessment, but only someone who may send feedback — assessment:review —
// is offered the decision; the page needs to know which of the two it is.
assessmentsRouter.get('/:id/feedback-email', requireCapability('assessment:read'), asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!, req.params.id);
  res.json({ ...await feedbackEmailState(a.sessionId), canDecideHold: hasCapability(req.auth!, 'assessment:review') });
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
  res.json({
    ...await sendFeedbackNow({
      sessionId: a.sessionId, assessmentId: a.id, userId: req.auth!.userId, tenantId: req.auth!.tenantId,
      confirmPossibleDuplicate: body.confirmPossibleDuplicate,
    }),
    canDecideHold: true,
  });
}));

// "Keep holding": the letter stays unsent and stops asking for attention.
// Releasing it is /send above. Closed body, like send: who decided comes from
// the session, never the request.
assessmentsRouter.post('/:id/feedback-email/hold', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  const a = await getAssessment(req.auth!, req.params.id);
  await keepFeedbackHeld({ sessionId: a.sessionId, userId: req.auth!.userId, tenantId: req.auth!.tenantId });
  res.json({ ...await feedbackEmailState(a.sessionId), canDecideHold: true });
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
  await recordAssessmentOpened(req.auth!, a.id);
  const reviews = await prisma.humanReview.findMany({ where: { assessmentId: a.id }, orderBy: { createdAt: 'desc' } });
  const result = readAssessmentResult(a);
  // The three readings the page shows side by side: what the AI produced, what
  // the reviewer left, and where the two differ. All of it derived from the
  // review already stored (services/assessmentReview.ts), so the comparison
  // can be analysed later without a second copy of the truth.
  const completed = await completedReviewFor(a.id);
  const differences = await reviewDifferenceView(req.auth!.tenantId, a.id, completed);
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
    differences,
    // What this role's own reviewers taught the model before this interview was
    // assessed, and the model's own level beside it. Empty for every assessment
    // written before a calibration existed and for every organisation with
    // calibration off, which is the default. The page contract — what to render
    // and the rules for rendering it — is in domain/calibrationView.ts.
    calibration: assessmentCalibration(result, differences),
    // Which interviewer turns ran on the local fallback model or the built-in
    // writer during a model outage, so a thinner probe is not held against the
    // candidate. Empty unless the local fallback chain (LOCAL_LLM_ENABLED) ran.
    servingMode: await servingModeForSession(a.sessionId),
    // Only for an interview the Q&A library planned; absent otherwise, as before.
    ...await questionsAskedField(a.sessionId),
    // What the rest of the product should report: the human verdict once there
    // is one, the AI's until then.
    outcome: reviewedOutcome(result, completed),
    // Where the candidate stands, and what each verdict would do to that —
    // computed by the same function the submit acts through, so the sentence
    // beside the button cannot promise something the submit will not do
    // (domain/verdictConsequence.ts). Null when there is no pipeline to move.
    journey: await journeyFor(a.session.candidateId, a.session.roleId, a.id),
    // Whether the ATS export is on offer to this reader, and if not, why. The
    // page writes the sentence; naming the reason here keeps the offer and the
    // route that enforces it (POST /:id/export) reading from one rule.
    export: exportOffer({
      mayExport: hasCapability(req.auth!, 'assessment:export'),
      scored: result.overallScore !== null,
    }),
  });
}));

/**
 * The "Identity & integrity" panel: whether the one-time code was confirmed,
 * and the CV-anchored questions with their answers. Read-only and advisory.
 * Gated like the assessment itself, since it sits on the same page.
 */
assessmentsRouter.get('/:id/identity', requireCapability('assessment:read'), asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!, req.params.id);
  await assertUnblindedReadAllowed({
    assessmentId: a.id, userId: req.auth!.userId, canReview: hasCapability(req.auth!, 'assessment:review'),
    tenantId: req.auth!.tenantId,
  });
  res.json(await identityPanelFor(a.session));
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

// ---------------------------------------------------------------------------
// The verdict: one submit that does the work
// ---------------------------------------------------------------------------

/**
 * Why the submit does everything at once.
 *
 * A completed review used to write a row and stop. The candidate's stage, the
 * decision on the round and the export were three more things a person had to
 * remember, on three other screens, and the review they had just recorded was
 * the only evidence that any of them were owed. The council review's finding
 * (2.2) was that the product asked a reviewer to make a decision and then did
 * not act on it.
 *
 * So one submit writes the review, carries the journey, records the decision
 * once, and offers the export — in that order, each step audited, and each one
 * described to the reviewer BEFORE they commit to it (domain/verdictConsequence.ts).
 * "Just record it" (applyToJourney: false) is the deliberate way to write a
 * review without the consequence; it is a choice, not the default.
 *
 * Retries do not repeat any of it: the page sends a submissionId, the column is
 * unique, and a second arrival replays the first submit's answer.
 */

/** Why an export is not on offer. The page writes the sentence; this names the reason. */
type ExportRefusal = 'no_capability' | 'not_scored' | 'no_review';

interface ExportOffer {
  readonly available: boolean;
  readonly because: ExportRefusal | null;
}

function exportOffer(o: { readonly mayExport: boolean; readonly scored: boolean }): ExportOffer {
  if (!o.mayExport) return { available: false, because: 'no_capability' };
  // The ATS has no way to render "unavailable", so an unscored assessment must
  // not reach the system of record (see POST /:id/export).
  if (!o.scored) return { available: false, because: 'not_scored' };
  return { available: true, because: null };
}

// Human review / override (FR-033)
const reviewSchema = z.object({
  // One vocabulary, end to end (domain/verdict.ts). The column is still called
  // `disposition` because it holds rows written years of releases ago; the
  // word everybody says, types and reads is the verdict.
  verdict: z.enum(VERDICTS),
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
  // The submit this request belongs to. A double-click, or a client retrying a
  // request whose response was lost, sends the same one — and gets the first
  // submit's answer back rather than recording the judgement twice.
  submissionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'A submission id is 8-64 url-safe characters.').optional(),
  // "Just record it": write the review WITHOUT recording the decision on the
  // round. It cannot leave the journey untouched — reviewing an interview is
  // what assesses it, and that stage event is a fact about the interview
  // rather than about the verdict — so the page says so beside the button
  // (verdictFlowModel.recordOnlyNote). The default is the whole act, because
  // a verdict nobody carried out was the thing that needed fixing.
  applyToJourney: z.boolean().default(true),
}).strict();
/**
 * "I have read the transcript" — the record the verdict is refused without.
 *
 * Two shapes, because there are two honest ways to have read it:
 *
 *   in_app     the page names the turn indexes it put in front of the
 *              reviewer, and the server checks the list against the turns the
 *              session actually has. Counting turns rather than scroll
 *              distance is what makes this reachable with a keyboard and with
 *              a screen reader: a percentage is a fact about a scrollbar, and
 *              a reviewer who never touches one would fail it having read
 *              every word.
 *
 *   elsewhere  the reviewer downloaded the transcript and read it in a
 *              document, and says so in a sentence. An explicit, audited path
 *              rather than a dead end — the alternative to naming it is that
 *              they page to the bottom without reading, and we learn nothing.
 */
const transcriptReadSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal(READ_METHODS[0]),
    // Bounded so a client cannot post a megabyte of indexes; a real interview
    // is tens of turns and the cap is far above any of them.
    seenIndexes: z.array(z.number().int().min(0).max(100_000)).max(5_000),
  }).strict(),
  z.object({
    method: z.literal(READ_METHODS[1]),
    attestation: z.string().trim().min(ATTESTATION_MIN, 'Say where you read the transcript.').max(ATTESTATION_MAX),
  }).strict(),
]);

assessmentsRouter.post('/:id/transcript-read', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!, req.params.id);
  const body = transcriptReadSchema.parse(req.body);
  const stored = await recordTranscriptRead({
    tenantId: req.auth!.tenantId, reviewerId: req.auth!.userId, assessmentId: a.id, sessionId: a.sessionId,
    report: body.method === 'elsewhere'
      ? { method: 'elsewhere', seenIndexes: [], attestation: body.attestation }
      : { method: 'in_app', seenIndexes: body.seenIndexes, attestation: '' },
  });
  res.status(201).json({ transcriptRead: { method: stored.method, turnsSeen: stored.turnsSeen, turnsTotal: stored.turnsTotal, at: stored.createdAt } });
}));

/** Whether this reviewer has already met the requirement, so the page can say so. */
assessmentsRouter.get('/:id/transcript-read', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!, req.params.id);
  const stored = await transcriptReadBy(a.id, req.auth!.userId);
  res.json({
    transcriptRead: stored
      ? { method: stored.method, turnsSeen: stored.turnsSeen, turnsTotal: stored.turnsTotal, at: stored.createdAt }
      : null,
  });
}));

assessmentsRouter.post('/:id/review', requireCapability('assessment:review'), asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!, req.params.id);
  const body = reviewSchema.parse(req.body);
  // The transcript first, before anything is written.
  //
  // The page has always asked for this and always said, truthfully, that it
  // was asking rather than requiring. It is required now: a verdict recorded
  // from the AI's summary is a review of the summary, and that is not what the
  // candidate was told would happen to their interview. A reviewer who read it
  // outside the app records that instead (POST /:id/transcript-read) — the
  // point is a record with a name and a time on it, not a scrollbar.
  const transcriptRead = await assertTranscriptRead(a.id, req.auth!.userId);
  const scored = readAssessmentResult(a).overallScore !== null;
  const offer = exportOffer({ mayExport: hasCapability(req.auth!, 'assessment:export'), scored });

  /**
   * Has this exact submit already landed?
   *
   * Asked at every point where this request could otherwise be mistaken for a
   * second opinion — before anything is read, again before the "already
   * reviewed" refusal, and once more when a unique index turns it down. The
   * first two are reads and so can each be overtaken by the winner committing
   * a moment later; only asking at all three leaves no window in which a
   * reviewer's retry comes back as a refusal for something they did not do.
   */
  const replayOf = async (): Promise<{ id: string; disposition: string; comments: string; assessmentId: string } | null> => {
    if (!body.submissionId) return null;
    const found = await prisma.humanReview.findUnique({ where: { submissionId: body.submissionId } });
    if (!found) return null;
    if (found.assessmentId !== a.id) throw new HttpError(409, 'That submission belongs to a different assessment.');
    return found;
  };
  /**
   * Carry the journey and record the decision once — the half of the submit
   * that happens outside the review's own transaction.
   *
   * Every step is safe to repeat, and deliberately so. The review commits
   * first (it is what the candidate's letter is released against), and if this
   * process then died before the pipeline moved, a retry would otherwise
   * replay "it worked" over a candidate nobody had moved. So a replay runs
   * this too: the stage event is forward-only, the decision is a conditional
   * update that resolves again from wherever the candidate actually is, and
   * the audit is written only when this review has not already been recorded
   * as decided. Repeating it repairs; it does not duplicate.
   */
  async function carryJourney(reviewId: string): Promise<JourneyMove | null> {
    // Read here rather than passed in: this runs on the replay path too,
    // which returns long before the fresh path's snapshot is taken.
    const before = await journeyStanding(a.session.candidateId, a.session.roleId);
    // A reviewed interview is an assessed one: Gold, if the finalisation had
    // not already got there. This is a fact about the interview rather than
    // the verdict, so "Just record it" does not suppress it.
    await notePipelineEvent({ tenantId: req.auth!.tenantId, candidateId: a.session.candidateId, roleId: a.session.roleId, event: 'interview.assessed', trigger: 'review.completed' });
    // And the verdict is the decision on that round: Proceed keeps them
    // moving, Do not progress ends their journey, Consider waits for a person.
    // Skipped when the reviewer chose "Just record it".
    const decision = body.applyToJourney
      ? await noteReviewDecision({
        tenantId: req.auth!.tenantId, candidateId: a.session.candidateId, roleId: a.session.roleId,
        verdict: body.verdict, reason: body.reason, reviewerId: req.auth!.userId,
      })
      : null;
    if (!before) return null;
    const stages = parseStages(
      (await prisma.candidatePipeline.findUnique({ where: { id: before.pipelineId }, select: { stagesJson: true } }))?.stagesJson
        ?? JSON.stringify(DEFAULT_STAGES),
    );
    const moved = await journeyMove(before, stages);
    // Once per review, including when it moved nobody: "nothing happened" is
    // what people come to an audit trail for as often as "something did".
    const already = await prisma.auditEvent.findFirst({
      where: { action: 'review.decision', entityId: a.id, afterJson: { contains: reviewId } }, select: { id: true },
    });
    if (already) return moved;
    await logAudit({
      tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'review.decision',
      entityType: 'AssessmentVersion', entityId: a.id,
      before: { stage: before.currentStageKey, status: before.status },
      after: {
        verdict: body.verdict, decision: decisionOfVerdict(body.verdict) ?? 'none',
        applied: body.applyToJourney, outcome: decision?.applied === true ? 'applied' : decision?.because ?? 'not_applied',
        stage: moved.toStageKey, moved: moved.moves, closed: moved.closes,
        reviewId,
      },
    });
    return moved;
  }

  const replay = async (row: { id: string; disposition: string; comments: string }) => {
    // The journey is carried again rather than reported as nothing: a submit
    // whose answer was lost may also have died before the candidate moved.
    // A failure here is logged rather than swallowed — the review exists
    // either way, and a replay that quietly repaired nothing is the state
    // this whole path was added to prevent.
    const moved = await carryJourney(row.id).catch((err: unknown) => {
      logger.error(
        { err: err instanceof Error ? err.message : String(err), assessmentId: a.id, reviewId: row.id },
        'Replayed review could not carry the journey; the candidate may be left at the wrong stage',
      );
      return null;
    });
    res.status(200).json({
      review: { id: row.id, verdict: row.disposition, selfReview: row.comments.includes(SELF_REVIEW_NOTE) },
      replayed: true, feedbackReleased: false, journey: moved, export: offer,
    });
  };

  const landed = await replayOf();
  if (landed) { await replay(landed); return; }

  // "Final" has to mean something. Once a review is completed it is the
  // version the team acts on and the version the candidate's feedback is
  // written from, so a second one does not quietly replace it.
  const previous = await completedReviewFor(a.id);
  if (previous && !body.supersede) {
    // Unless the review already there is this very submit, arriving twice.
    const mine = await replayOf();
    if (mine) { await replay(mine); return; }
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
  // Where the candidate stood before this submit. The move is reported by
  // comparing this with the row afterwards, so what the reviewer is told
  // happened is the record rather than a second prediction.
  // The review and the release of the candidate's letter are one transaction:
  // the gate refuses (409 feedback_sending) while a send holds the row, and
  // the review then does not exist — the email cannot be unsent, so the
  // review is what waits. When the gate opens, the review becomes visible in
  // the same commit that releases the letter, so no send can read one
  // without the other (services/autoFeedback.ts).
  const written = await prisma.$transaction(async (tx) => {
    const released = await gateReviewCompletion(tx, a.id);
    // Superseding releases the previous review's claim on the assessment
    // first, in the same transaction: the claim is unique, so the new review
    // cannot take it while the old one still holds it.
    if (previous && body.supersede) {
      await tx.humanReview.update({
        where: { id: previous.id },
        data: { supersededAt: new Date(), supersededReason: body.supersede.reason, activeForAssessmentId: null },
      });
    }
    const created = await tx.humanReview.create({
      data: {
        assessmentId: a.id, reviewerId: req.auth!.userId, status: 'COMPLETED', disposition: body.verdict,
        reason: body.reason, submissionId: body.submissionId ?? null, activeForAssessmentId: a.id,
        comments: selfReview ? (comments ? `${comments}\n\n${SELF_REVIEW_NOTE}` : SELF_REVIEW_NOTE) : comments,
        overridesJson: JSON.stringify(body.overrides), completedAt: new Date(),
      },
    });
    return { review: created, feedbackReleased: released };
  }).catch(async (err: unknown) => {
    // A unique index decided this, not a read both attempts had passed.
    // Which index says which race was lost, and the provider spells that
    // differently, so the answer is read from the data rather than the error:
    // if this submit's id is now on a row, it is our own retry and replays;
    // otherwise somebody else's review is the completed one.
    if ((err as { code?: string }).code !== 'P2002') throw err;
    const mine = await replayOf();
    if (mine) return { review: mine, feedbackReleased: false, replayed: true as const };
    throw new HttpError(409, 'This assessment has already been reviewed. To replace that review, say that you mean to and give a reason.');
  });
  if ('replayed' in written) {
    await replay(written.review);
    return;
  }
  const { review, feedbackReleased } = written;
  // Session -> HUMAN_REVIEWED -> CLOSED
  if (a.session.state === 'REVIEW_READY') {
    await prisma.interviewSession.update({ where: { id: a.sessionId }, data: { state: 'HUMAN_REVIEWED' } });
  }
  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'review.completed',
    entityType: 'AssessmentVersion', entityId: a.id,
    before: { recommendation: a.recommendation },
    after: {
      verdict: body.verdict, reason: body.reason, selfReview, applyToJourney: body.applyToJourney,
      // How this reviewer met the transcript requirement, on the record of the
      // verdict itself: an auditor asking "did a person read it?" should not
      // have to join two tables to find out.
      transcriptRead: {
        method: transcriptRead.method, turnsSeen: transcriptRead.turnsSeen,
        turnsTotal: transcriptRead.turnsTotal, at: transcriptRead.createdAt.toISOString(),
      },
    },
  });
  await emitEvent(req.auth!.tenantId, 'review.completed', { assessmentId: a.id, verdict: body.verdict });
  const move = await carryJourney(review.id);
  if (previous && body.supersede) {
    // The row itself was superseded inside the transaction above, with the
    // new review; only the trail is written here.
    await logAudit({
      tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'review.superseded',
      entityType: 'AssessmentVersion', entityId: a.id,
      before: { reviewId: previous.id, verdict: previous.disposition },
      after: { reviewId: review.id, supersededReviewId: previous.id, verdict: body.verdict, reason: body.supersede.reason },
    });
  }
  // Where this reviewer parted company with the AI, kept for later analysis
  // (services/assessmentReview.ts). Written now, at the moment the fact exists.
  await recordReviewDifference(req.auth!.tenantId, a.id, review.id);
  // The same fact, per competency, in the shape calibration counts
  // (services/calibrationCapture.ts). Best effort, like the library's usage
  // rows: a review must complete whether or not any of this can be written,
  // and NOTHING here touches the assessment that was just reviewed.
  await recordCalibrationObservations({ tenantId: req.auth!.tenantId, assessmentId: a.id, reviewId: review.id });
  // And the signal the question library's quality loop already consumes, for
  // the questions this interview asked (services/calibrationAnchors.ts).
  await recordLibraryReviewerDelta({ assessmentId: a.id, reviewId: review.id });
  res.status(201).json({
    review: { id: review.id, verdict: review.disposition, selfReview },
    replayed: false,
    feedbackReleased,
    // What the journey actually did — the page reads this back to the
    // reviewer, so it is measured, never predicted a second time.
    journey: move,
    // Offered here rather than behind another screen: the moment a verdict is
    // recorded is the moment somebody wants it in the ATS.
    export: offer,
  });
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
  // The ATS is the system of record: once the AI's reading is in it, it is a
  // hiring signal that outlives this application and that nobody downstream can
  // trace back to whether a person ever read the interview. So the promise
  // holds here too — the recommendation leaves Questor only after the review
  // the candidate was told about has happened.
  const promise = await assessmentReviewRequirement({ tenantId: req.auth!.tenantId, assessmentId: a.id });
  if (promise.required && !promise.satisfied) {
    await logAudit({
      tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'assessment.export_refused',
      entityType: 'AssessmentVersion', entityId: a.id, after: { because: HUMAN_REVIEW_REQUIRED },
    });
    throw new HttpError(409, humanReviewRefusal(promise), HUMAN_REVIEW_REQUIRED);
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
