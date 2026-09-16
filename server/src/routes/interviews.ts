import { Router, type Request } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { prisma, parseJson } from '../db.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import { assertCanAccessCandidate, assertCanAccessSession, candidateScope } from '../services/access.js';
import { getPipelineSummary, type PipelineSummary } from '../services/pipeline.js';
import { buildInterviewPlan } from '../engines/interviewPlanner.js';
import { resolveCandidateBand } from '../engines/bandCalibration.js';
import type { FitScore, NormalizedProfile, RoleSuccessProfile } from '../domain/types.js';
import { assertTransition } from '../domain/stateMachine.js';
import { getEmail } from '../providers/email/index.js';
import { meetingCapability } from '../providers/meeting/index.js';
import { brandedEmail } from '../providers/email/branding.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { logAudit } from '../services/audit.js';
import { emitEvent } from '../services/webhooks.js';
import { startInterview, submitCandidateTurn, finalizeInterview, withdrawInterview, setState } from '../realtime/interviewEngine.js';
import { disclosureWithProctoringPolicy } from '../services/proctoringPolicy.js';
import { LIVE_INTERVIEW_STATES, mayObserveLive } from '../services/observerPolicy.js';
import { DEFAULT_PERSONA_NAME } from '../domain/persona.js';
import { SUPPORTED_LANGUAGES } from '../i18n/locales.js';

export const interviewsRouter = Router();
interviewsRouter.use(authenticate);

/** The AI interviewer's name. Questor is the product; Schranders conducts the
 *  interview. The candidate should meet the same name in the invitation that
 *  greets them in the room. */

/** The invitation a candidate receives. Kept in one place so the plain-text and
 *  HTML bodies cannot drift apart — a candidate whose client strips HTML must
 *  still get a working link. */
function buildInvite(candidateName: string, roleTitle: string, portalUrl: string, personaName: string = DEFAULT_PERSONA_NAME) {
  return brandedEmail({
    to: '',
    subject: `Your first-round interview for ${roleTitle}`,
    text: `Hi ${candidateName},\n\nYou're invited to a first-round interview for ${roleTitle}. It is conducted by ${personaName}, an AI voice interviewer, and your answers are transcribed as you speak — no audio recording is kept.\n\nStart or schedule here: ${portalUrl}\n\nYou can review privacy information and consent before you begin.\n\nThanks,\nRecruiting Team`,
    html: `<p>Hi ${candidateName},</p><p>You're invited to a first-round interview for <b>${roleTitle}</b>, conducted by <b>${personaName}</b>, an AI voice interviewer. Your answers are transcribed as you speak — no audio recording is kept.</p><p><a href="${portalUrl}">Start or schedule your interview</a></p>`,
  });
}

const createSchema = z.object({
  candidateId: z.string(),
  durationMinutes: z.number().int().min(10).max(120).default(45),
  language: z.string().default('en'),
  modules: z.array(z.string()).default([]),
  persona: z.object({ name: z.string(), tone: z.enum(['warm', 'neutral', 'formal']) }).default({ name: 'Schranders', tone: 'warm' }),
  provider: z.enum(['hosted', 'teams', 'zoom', 'meet']).default('hosted'),
  recordingRequested: z.boolean().default(false),
  humanReviewRequired: z.boolean().default(true),
  approve: z.boolean().default(true),
});

// Approve interview + build plan (FR-011, FR-016)
interviewsRouter.post('/', requireCapability('interview:create'), asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);
  if (!body.approve) throw new HttpError(400, 'HR approval is required before an interview can be created');

  // Object scope, not just tenant: creating a session is how a candidate enters
  // the interview pipeline, so being able to name a candidate id must not be
  // enough to start one. Throws 404 when out of scope.
  const candidate = await assertCanAccessCandidate(req.auth!, body.candidateId);
  if (!candidate.roleId) throw new HttpError(404, 'Candidate or role not found');

  const scorecard = await prisma.roleScorecardVersion.findFirst({ where: { roleId: candidate.roleId, status: 'approved' }, orderBy: { version: 'desc' } });
  if (!scorecard) throw new HttpError(400, 'Role scorecard must be approved before interviewing (BRD FR-003).');

  const profile = parseJson<RoleSuccessProfile>(scorecard.profileJson, {} as RoleSuccessProfile);
  const latestProfile = await prisma.candidateProfileVersion.findFirst({ where: { candidateId: candidate.id }, orderBy: { version: 'desc' } });
  const fit = latestProfile ? parseJson<FitScore>(latestProfile.fitScoreJson, undefined as any) : undefined;

  // Pitch the interview at the candidate rather than at the requisition. Their
  // parsed resume already knew how long they have worked and what they have
  // owned; until now none of it reached the plan, so a first-year applicant to a
  // senior req was questioned as though they held the job.
  const parsed = latestProfile ? parseJson<NormalizedProfile>(latestProfile.profileJson, {} as NormalizedProfile) : ({} as NormalizedProfile);
  const banding = resolveCandidateBand({
    profile: parsed,
    resumeText: latestProfile?.rawText ?? '',
    roleSeniority: profile.seniority ?? '',
  });

  const plan = buildInterviewPlan({
    role: profile, fit, durationMinutes: body.durationMinutes, language: body.language, modules: body.modules,
    band: banding.band.id,
    bandRationale: `${banding.rationale} (decided from the ${banding.source}, confidence ${banding.confidence.toFixed(2)})`,
  });

  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId } });
  const tenantPolicy = parseJson<any>(tenant?.policyJson ?? '{}', {});
  const baseDisclosureText = tenantPolicy.disclosureText ??
    // No `recordingRequested` branch: it offered two different sentences for a
    // distinction that does not exist, since no audio artefact is produced
    // either way. Stating capture, transcription and retention plainly is both
    // true and more useful than the flag ever was.
    `Hello, I'm ${body.persona.name}, an AI interviewer for this first-round conversation. Your voice is transcribed as we talk — no audio recording is kept, but the written transcript is, and a person on the hiring team reads it. I'll ask about your relevant experience. You can ask me to repeat anything or request a pause at any time.`;
  const disclosureText = await disclosureWithProctoringPolicy({ tenantId: req.auth!.tenantId, scorecardId: scorecard.id }, baseDisclosureText);

  const session = await prisma.interviewSession.create({
    data: {
      tenantId: req.auth!.tenantId, candidateId: candidate.id, roleId: candidate.roleId, scorecardId: scorecard.id,
      state: 'PROVISIONED', provider: body.provider, language: body.language, durationMinutes: body.durationMinutes,
      personaJson: JSON.stringify(body.persona),
      consentJson: JSON.stringify({ disclosureText, recordingRequested: body.recordingRequested, humanReviewRequired: body.humanReviewRequired }),
      recordingConsent: false,
    },
  });
  await prisma.interviewPlanVersion.create({ data: { sessionId: session.id, version: 1, planJson: JSON.stringify(plan) } });
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'interview.approved', entityType: 'InterviewSession', entityId: session.id });

  res.status(201).json({ session: { id: session.id, state: session.state, provider: session.provider }, plan, meetingCapability: meetingCapability(body.provider) });
}));

// List sessions.
//
// Gated on candidate:read as well as scoped, because each row carries a
// candidate's name and their recommendation — an auditor holds audit:read and
// has no business reading candidate detail here.
interviewsRouter.get('/', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  // Sessions have no scope of their own; they inherit the candidate's. Filtering
  // through the candidate relation keeps that single definition of scope rather
  // than reimplementing the assignment rules in this query.
  const scope = (await candidateScope(req.auth!)) as Prisma.CandidateWhereInput;
  const sessions = await prisma.interviewSession.findMany({
    where: { tenantId: req.auth!.tenantId, candidate: scope }, orderBy: { createdAt: 'desc' },
    include: { candidate: true, role: true, assessments: { orderBy: { version: 'desc' }, take: 1 }, invitation: true },
  });
  res.json({ sessions: sessions.map((s) => ({
    id: s.id, state: s.state, provider: s.provider, scheduledAt: s.scheduledAt,
    candidate: { id: s.candidateId, name: s.candidate.fullName }, role: { id: s.roleId, title: s.role.title },
    recommendation: s.assessments[0]?.recommendation ?? null, assessmentId: s.assessments[0]?.id ?? null,
    invited: !!s.invitation, createdAt: s.createdAt,
  })) });
}));

const pipelineSummaryQuerySchema = z.object({
  roleId: z.string().min(1).optional(),
  format: z.enum(['csv']).optional(),
});

/**
 * One CSV cell. A value starting with =, +, -, @, tab or CR is prefixed with an
 * apostrophe so a spreadsheet opens it as text rather than running it as a
 * formula; values containing quotes, commas or newlines are quoted.
 */
function csvCell(value: string): string {
  const defused = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(defused) ? `"${defused.replace(/"/g, '""')}"` : defused;
}

/** `state,count` — one row per state present in the summary, in no particular order. */
function pipelineSummaryToCsv(summary: PipelineSummary): string {
  const lines = ['state,count', ...Object.entries(summary.stateCounts).map(([state, count]) => `${csvCell(state)},${count}`)];
  return `${lines.join('\n')}\n`;
}

interviewsRouter.get('/pipeline-summary', requireCapability('interview:read'), asyncHandler(async (req, res) => {
  const query = pipelineSummaryQuerySchema.parse(req.query);
  const summary = await getPipelineSummary(req.auth!, query.roleId);
  if (query.format === 'csv') {
    res.type('text/csv').send(pipelineSummaryToCsv(summary));
    return;
  }
  res.json(summary);
}));

/**
 * What languages this build can actually DELIVER an interview in.
 *
 * Declared before `/:id` because Express matches in order and a literal path
 * would otherwise be swallowed as a session id.
 *
 * The point of exposing this is honesty at scheduling time. `language` accepts
 * any string, so HR could always create a `fr` session — and until now nothing
 * told them that doing so meant an English disclosure and no voice support.
 * `translationReviewed: false` is the flag that says "this is a placeholder, a
 * human translator has not signed off the consent copy yet", and it is more
 * useful to see before the invitation goes out than after.
 *
 * Gated on interview:read rather than being public: it describes product
 * capability, not candidate data, but it is an authenticated HR surface and
 * there is no reason for it to be the one route that is not.
 */
interviewsRouter.get('/supported-languages', requireCapability('interview:read'), asyncHandler(async (_req, res) => {
  res.json({ languages: SUPPORTED_LANGUAGES });
}));

const bulkInviteRowSchema = z.object({ candidateId: z.string().min(1) });

interviewsRouter.post('/bulk-invite', requireCapability('interview:invite'), asyncHandler(async (req, res) => {
  const rows = z.array(z.unknown()).parse(req.body);
  const results = [];

  for (let index = 0; index < rows.length; index++) {
    const parsed = bulkInviteRowSchema.safeParse(rows[index]);
    const candidateId = parsed.success ? parsed.data.candidateId : undefined;
    try {
      if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join('; '));

      const candidate = await assertCanAccessCandidate(req.auth!, parsed.data.candidateId);
      const session = await prisma.interviewSession.findFirst({
        where: { tenantId: req.auth!.tenantId, candidateId: candidate.id },
        orderBy: { createdAt: 'desc' },
      });
      if (!session) throw new HttpError(404, 'Interview not found');

      const invitation = await inviteSession(req, session);
      results.push({ index, candidateId: candidate.id, sessionId: session.id, success: true, invitation });
    } catch (err) {
      results.push({
        index, candidateId, success: false,
        error: err instanceof Error ? err.message : 'Invitation failed',
      });
    }
  }

  res.json({ results });
}));

// Session detail.
//
// This response includes the live invitation token, which is a bearer
// credential for the unauthenticated candidate portal — anyone holding it can
// open the candidate's interview. Scope here is what stops one recruiter from
// lifting another's portal link.
interviewsRouter.get('/:id', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const session = await getSession(req, req.params.id);
  const [plan, turns, assessment, invitation, integrityEvents] = await Promise.all([
    prisma.interviewPlanVersion.findUnique({ where: { sessionId: session.id } }),
    prisma.turn.findMany({ where: { sessionId: session.id }, orderBy: { index: 'asc' } }),
    prisma.assessmentVersion.findFirst({ where: { sessionId: session.id }, orderBy: { version: 'desc' } }),
    prisma.invitation.findUnique({ where: { sessionId: session.id } }),
    prisma.integrityEvent.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: 'asc' }, select: { type: true, createdAt: true } }),
  ]);
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'interview.detail_read', entityType: 'InterviewSession', entityId: session.id });
  res.json({
    session: { id: session.id, state: session.state, provider: session.provider, language: session.language, durationMinutes: session.durationMinutes, scheduledAt: session.scheduledAt, persona: parseJson(session.personaJson, {}), consent: parseJson(session.consentJson, {}) },
    plan: plan ? parseJson(plan.planJson, {}) : null,
    turns: turns.map((t) => ({ id: t.id, index: t.index, speaker: t.speaker, text: t.text, startMs: t.startMs, endMs: t.endMs, competencyId: t.competencyId })),
    assessment: assessment ? { id: assessment.id, recommendation: assessment.recommendation, result: parseJson(assessment.resultJson, {}) } : null,
    // Integrity events are human-review context only. They are deliberately not
    // passed into assessment generation or score fields.
    integrityEvents: { count: integrityEvents.length, events: integrityEvents },
    invitation: invitation ? {
      token: invitation.token, status: invitation.status,
      portalUrl: `${config.webOrigin}/portal/${invitation.token}`,
      // Both timestamps, so the recruiter can tell "we sent it" from "they saw it".
      sentAt: invitation.sentAt, openedAt: invitation.openedAt,
    } : null,
  });
}));

// Send invitation (FR-012)
interviewsRouter.post('/:id/invite', requireCapability('interview:invite'), asyncHandler(async (req, res) => {
  const session = await getSession(req, req.params.id);
  const invitation = await inviteSession(req, session);
  res.json({ invitation });
}));

// Schedule (FR-013)
//
/**
 * Return a handed-off interview to the candidate.
 *
 * MANUAL_HANDOFF was a one-way door: a candidate who asked for a human — or who
 * typed a stray character into that box — could never get back, and neither
 * could a recruiter without direct database access. That is the wrong shape for
 * a state a CANDIDATE can enter by accident, and it left a real person locked
 * out of an interview they wanted.
 *
 * Restores to CONSENTED, which is where they were: consent is already recorded,
 * so re-collecting it would be theatre. The reason is required and audited,
 * because reversing an accommodation request is exactly the kind of decision
 * that should be attributable.
 */
interviewsRouter.post('/:id/reopen', requireCapability('interview:invite'), asyncHandler(async (req, res) => {
  const session = await getSession(req, req.params.id);
  const { reason } = z.object({ reason: z.string().min(10, 'Say why this is being reopened.') }).parse(req.body);
  if (session.state !== 'MANUAL_HANDOFF') {
    throw new HttpError(409, `Only an interview handed to a human can be reopened; this one is ${session.state}.`);
  }
  await prisma.interviewSession.update({ where: { id: session.id }, data: { state: 'CONSENTED' } });
  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user',
    action: 'interview.reopened_from_handoff', entityType: 'InterviewSession', entityId: session.id,
    after: { from: 'MANUAL_HANDOFF', to: 'CONSENTED', reason },
  });
  res.json({ reopened: true, state: 'CONSENTED' });
}));

/**
 * No-fault retake.
 *
 * Deliberately narrow: only reachable from INCOMPLETE or TECHNICAL_FAILURE,
 * i.e. the candidate did not finish for a reason nobody has pinned on them —
 * a dropped connection, a broken client, an interruption that was never
 * scored. It is NOT a general "do-over" for a candidate who finished and
 * scored poorly; that would let anyone retry until the model happens to like
 * them, and it would quietly move the population the bias audit is measuring.
 *
 * This creates a NEW session rather than resuming the old one (contrast
 * /reopen, which resumes MANUAL_HANDOFF in place). The old session keeps its
 * partial transcript as the record of what happened, but is moved to CLOSED so
 * it stops sitting in HR's "needs action" views for ever.
 *
 * Attempts are capped: a candidate whose interviews keep failing needs a human
 * interviewer, not an unbounded loop of retakes.
 */
const MAX_INTERVIEW_ATTEMPTS = 2;

interviewsRouter.post('/:id/retake', requireCapability('interview:invite'), asyncHandler(async (req, res) => {
  const original = await getSession(req, req.params.id);
  const { reason } = z.object({ reason: z.string().min(10, 'Say why this candidate is being offered a retake.') }).parse(req.body);

  if (original.state !== 'INCOMPLETE' && original.state !== 'TECHNICAL_FAILURE') {
    throw new HttpError(409, `Only an interview that stopped through no fault of the candidate's (INCOMPLETE or TECHNICAL_FAILURE) can be retaken; this one is ${original.state}.`);
  }
  const priorAssessment = await prisma.assessmentVersion.findFirst({ where: { sessionId: original.id } });
  if (priorAssessment) throw new HttpError(409, 'This interview was already scored — a retake would duplicate an assessment. Use human review instead.');
  if (original.attemptNumber >= MAX_INTERVIEW_ATTEMPTS) {
    throw new HttpError(409, `This candidate has already had ${MAX_INTERVIEW_ATTEMPTS} attempts at this interview. Arrange a human interviewer instead.`);
  }
  assertTransition(original.state, 'CLOSED');

  // A retake is the same interview again, so it keeps the original's modules
  // (a work sample, say) and its interviewer persona.
  const originalPlan = await prisma.interviewPlanVersion.findUnique({ where: { sessionId: original.id } });
  const originalModules = parseJson<{ modules?: string[] }>(originalPlan?.planJson ?? '{}', {}).modules ?? [];
  const persona = parseJson<{ name?: string }>(original.personaJson, {});

  const candidate = await assertCanAccessCandidate(req.auth!, original.candidateId);
  const scorecard = await prisma.roleScorecardVersion.findFirst({ where: { roleId: original.roleId, status: 'approved' }, orderBy: { version: 'desc' } });
  if (!scorecard) throw new HttpError(400, 'Role scorecard must be approved before interviewing (BRD FR-003).');

  const profile = parseJson<RoleSuccessProfile>(scorecard.profileJson, {} as RoleSuccessProfile);
  const latestProfile = await prisma.candidateProfileVersion.findFirst({ where: { candidateId: candidate.id }, orderBy: { version: 'desc' } });
  const fit = latestProfile ? parseJson<FitScore>(latestProfile.fitScoreJson, undefined as any) : undefined;
  const parsed = latestProfile ? parseJson<NormalizedProfile>(latestProfile.profileJson, {} as NormalizedProfile) : ({} as NormalizedProfile);
  const banding = resolveCandidateBand({ profile: parsed, resumeText: latestProfile?.rawText ?? '', roleSeniority: profile.seniority ?? '' });

  const plan = buildInterviewPlan({
    role: profile, fit, durationMinutes: original.durationMinutes, language: original.language, modules: originalModules,
    band: banding.band.id,
    bandRationale: `${banding.rationale} (decided from the ${banding.source}, confidence ${banding.confidence.toFixed(2)})`,
  });

  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId } });
  const tenantPolicy = parseJson<any>(tenant?.policyJson ?? '{}', {});
  const baseDisclosureText = tenantPolicy.disclosureText ??
    `Hello, I'm ${persona.name ? `${persona.name}, an AI interviewer` : 'an AI interviewer'} for this first-round conversation. Your voice is transcribed as we talk — no audio recording is kept, but the written transcript is, and a person on the hiring team reads it. I'll ask about your relevant experience. You can ask me to repeat anything or request a pause at any time.`;
  const disclosureText = await disclosureWithProctoringPolicy({ tenantId: req.auth!.tenantId, scorecardId: scorecard.id }, baseDisclosureText);

  // Claim the original atomically. The conditional close succeeds for exactly
  // one request, so a double-click or two HR users acting at once cannot both
  // pass the attempt cap and create two retakes.
  const retake = await prisma.$transaction(async (tx) => {
    const claimed = await tx.interviewSession.updateMany({
      where: { id: original.id, state: original.state, attemptNumber: original.attemptNumber },
      data: { state: 'CLOSED' },
    });
    if (claimed.count !== 1) throw new HttpError(409, 'A retake for this interview has already been created.');

    const created = await tx.interviewSession.create({
      data: {
        tenantId: req.auth!.tenantId, candidateId: candidate.id, roleId: original.roleId, scorecardId: scorecard.id,
        state: 'PROVISIONED', provider: original.provider, language: original.language, durationMinutes: original.durationMinutes,
        personaJson: original.personaJson,
        // Consent is captured fresh for the new session — it is a new interview,
        // not a continuation, and re-showing disclosure is cheap insurance
        // against relying on a consent event that belongs to a different session.
        consentJson: JSON.stringify({ disclosureText, recordingRequested: false, humanReviewRequired: true }),
        recordingConsent: false,
        attemptNumber: original.attemptNumber + 1,
        retakeOfSessionId: original.id,
      },
    });
    await tx.interviewPlanVersion.create({ data: { sessionId: created.id, version: 1, planJson: JSON.stringify(plan) } });
    return created;
  });
  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'interview.retake_created',
    entityType: 'InterviewSession', entityId: retake.id,
    before: { originalSessionId: original.id, originalState: original.state },
    after: { attemptNumber: retake.attemptNumber, reason, originalClosed: true },
  });
  await emitEvent(req.auth!.tenantId, 'interview.retake_created', { originalSessionId: original.id, sessionId: retake.id, candidateId: candidate.id, attemptNumber: retake.attemptNumber });
  res.status(201).json({ session: { id: retake.id, state: retake.state, attemptNumber: retake.attemptNumber, retakeOfSessionId: original.id }, plan });
}));

/**
 * Resend an existing invitation.
 *
 * Separate from /invite because that one only accepts PROVISIONED — once a
 * session is INVITED there was no way to reach the candidate again, and
 * "I never got it" is the single most common thing a recruiter has to answer.
 *
 * Reuses the existing link rather than minting a new one. Rotating the token
 * would kill any copy already sent by hand, which is exactly what someone does
 * while waiting for a resend to exist.
 */
interviewsRouter.post('/:id/resend', requireCapability('interview:invite'), asyncHandler(async (req, res) => {
  const session = await getSession(req, req.params.id);
  const invitation = await prisma.invitation.findUnique({ where: { sessionId: session.id } });
  if (!invitation) throw new HttpError(404, 'This interview has no invitation yet — send one first.');
  if (invitation.status === 'consumed') throw new HttpError(409, 'This interview is already complete.');
  if (invitation.expiresAt && invitation.expiresAt < new Date()) {
    throw new HttpError(410, 'This invitation has expired. Create a new interview for this candidate.');
  }

  const candidate = await prisma.candidate.findUnique({ where: { id: session.candidateId } });
  const role = await prisma.role.findUnique({ where: { id: session.roleId } });
  const portalUrl = `${config.webOrigin}/portal/${invitation.token}`;
  const email = getEmail();

  if (!email.delivers) {
    throw new HttpError(503, `Email is not configured to deliver (provider "${email.name}"). Copy the candidate's link and send it yourself.`);
  }

  try {
    await email.send({ ...buildInvite(candidate!.fullName, role!.title, portalUrl), to: candidate!.email });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), sessionId: session.id }, 'Invitation resend failed');
    throw new HttpError(502, 'The email could not be sent. Copy the link and send it yourself, or try again.');
  }

  const events = parseJson<Array<Record<string, unknown>>>(invitation.eventsJson, []);
  events.push({ type: 'resent', at: new Date().toISOString(), by: req.auth!.userId });
  await prisma.invitation.update({
    where: { id: invitation.id },
    data: { status: invitation.status === 'created' ? 'sent' : invitation.status, sentAt: new Date(), eventsJson: JSON.stringify(events) },
  });

  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'invitation.resent', entityType: 'InterviewSession', entityId: session.id });
  res.json({ resent: true, to: candidate!.email, portalUrl, deliveryNote: `Sent again to ${candidate!.email}.` });
}));

// Gated on interview:invite as the nearest existing scheduling-lane capability
// (recruiter, manager, admin — not reviewer or auditor). There is no
// `interview:schedule` capability yet; when one is added this and /cancel
// should move to it rather than borrowing the invite grant.
interviewsRouter.post('/:id/schedule', requireCapability('interview:invite'), asyncHandler(async (req, res) => {
  const session = await getSession(req, req.params.id);
  const at = z.object({ scheduledAt: z.string() }).parse(req.body).scheduledAt;
  await prisma.interviewSession.update({ where: { id: session.id }, data: { scheduledAt: new Date(at) } });
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'interview.scheduled', entityType: 'InterviewSession', entityId: session.id, after: { scheduledAt: at } });
  res.json({ ok: true, scheduledAt: at });
}));

// Cancel / reschedule (FR-014)
interviewsRouter.post('/:id/cancel', requireCapability('interview:invite'), asyncHandler(async (req, res) => {
  const session = await getSession(req, req.params.id);
  assertTransition(session.state, 'CANCELLED');
  await prisma.interviewSession.update({ where: { id: session.id }, data: { state: 'CANCELLED' } });
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'interview.cancelled', entityType: 'InterviewSession', entityId: session.id });
  res.json({ ok: true });
}));

// Recruiter text-mode drive (also used for testing without voice).
//
// These let an authenticated recruiter write turns into a transcript that backs
// a hiring decision, so every use is audit-logged with the acting user. The
// engine's state and turn-cap guards apply here too — they live in
// interviewEngine rather than in the portal route precisely so this path cannot
// sidestep them.
interviewsRouter.post('/:id/start', requireCapability('interview:drive'), asyncHandler(async (req, res) => {
  await getSession(req, req.params.id);
  const turn = await startInterview(req.params.id);
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'interview.started.by_recruiter', entityType: 'InterviewSession', entityId: req.params.id });
  res.json({ turn });
}));
interviewsRouter.post('/:id/turn', requireCapability('interview:drive'), asyncHandler(async (req, res) => {
  await getSession(req, req.params.id);
  // Same ceiling as the candidate portal; an authenticated caller is still a
  // caller, and this text goes into a paid prompt.
  const { text } = z.object({ text: z.string().min(1).max(4000) }).parse(req.body);
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'interview.turn.by_recruiter', entityType: 'InterviewSession', entityId: req.params.id });
  const turn = await submitCandidateTurn(req.params.id, text);
  let assessmentId: string | null = null;
  if (turn.withdrawn) {
    await withdrawInterview(req.params.id, turn.kind === 'safety' ? 'safety_stop' : 'candidate_withdrew');
  } else if (turn.done) ({ assessmentId } = await finalizeInterview(req.params.id));
  res.json({ turn, assessmentId });
}));
interviewsRouter.post('/:id/finalize', requireCapability('interview:drive'), asyncHandler(async (req, res) => {
  await getSession(req, req.params.id);
  const { assessmentId } = await finalizeInterview(req.params.id);
  res.json({ assessmentId });
}));

/**
 * Assess an interview that stopped part-way, on a human's explicit instruction.
 *
 * The sweep that marks interviews INCOMPLETE deliberately does not score them:
 * a candidate whose network dropped after three good answers must not acquire a
 * permanent recommendation from an interview they never chose to end, and no
 * timer should be deciding whether a partial transcript is "enough" to judge a
 * person on.
 *
 * A reviewer looking at the transcript can decide it IS worth assessing. That
 * is a person taking responsibility for a partial record, which is a different
 * act from a scheduled job doing it silently — so it is a separate endpoint,
 * needs the drive capability, and is recorded in the audit trail with a reason.
 */
interviewsRouter.post('/:id/assess-partial', requireCapability('interview:drive'), asyncHandler(async (req, res) => {
  const session = await getSession(req, req.params.id);
  if (session.state !== 'INCOMPLETE') {
    throw new HttpError(409, 'Only an interview marked INCOMPLETE can be assessed this way.');
  }

  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length < 10) {
    // Not bureaucracy. If this assessment is ever questioned, the record has to
    // show a person decided a partial interview was fair to score, and why.
    throw new HttpError(400, 'A reason is required (at least 10 characters) — it is recorded with the assessment.');
  }

  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user',
    action: 'interview.assess_partial', entityType: 'InterviewSession', entityId: session.id,
    after: { reason },
  });

  // Back to a state finalizeInterview accepts, then score it.
  await setState(session.id, 'INCOMPLETE', 'CLOSING');
  const { assessmentId } = await finalizeInterview(session.id);
  res.json({ assessmentId, partial: true });
}));

/**
 * HR silently observing the AI interview: the transcript so far, read-only.
 *
 * Refused unless the candidate consented on a page that told them a member of
 * the hiring team may observe. Each observer is audited once per interview
 * rather than once per poll.
 */
interviewsRouter.get('/:id/observe', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const session = await getSession(req, req.params.id);
  if (!(await mayObserveLive(session))) {
    throw new HttpError(409, 'Live observation opens once the candidate has joined, heard that a member of the hiring team may observe, and answered. The transcript is available once the interview ends.');
  }

  const turns = await prisma.turn.findMany({
    where: { sessionId: session.id },
    orderBy: { index: 'asc' },
    select: { index: true, speaker: true, text: true, createdAt: true },
  });

  const alreadyRecorded = await prisma.auditEvent.findFirst({
    where: { action: 'interview.observed', entityId: session.id, actorId: req.auth!.userId },
    select: { id: true },
  });
  if (!alreadyRecorded) {
    await logAudit({
      tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user',
      action: 'interview.observed', entityType: 'InterviewSession', entityId: session.id,
    });
  }

  res.json({
    session: { id: session.id, state: session.state },
    persona: { name: parseJson<{ name?: unknown }>(session.personaJson, {}).name ?? DEFAULT_PERSONA_NAME },
    turns,
  });
}));

// The live-state set and the observer-consent gate live in
// services/observerPolicy.ts, shared with the socket transport.

interviewsRouter.get('/:id/transcript', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const session = await getSession(req, req.params.id);
  // While the candidate may still be on the call, reading the transcript is
  // live observation, and gets the same consent gate as /observe.
  if (LIVE_INTERVIEW_STATES.has(session.state) && !(await mayObserveLive(session))) {
    throw new HttpError(409, 'The transcript is available once the interview ends.');
  }
  const [turns, integrityEvents] = await Promise.all([
    prisma.turn.findMany({ where: { sessionId: session.id }, orderBy: { index: 'asc' } }),
    prisma.integrityEvent.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: 'asc' }, select: { type: true, createdAt: true } }),
  ]);
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'interview.transcript_read', entityType: 'InterviewSession', entityId: session.id });
  res.json({
    transcript: turns.map((t) => ({ index: t.index, speaker: t.speaker, text: t.text, startMs: t.startMs })),
    // Human-review context only; never an automated scoring input.
    integrityEvents: { count: integrityEvents.length, events: integrityEvents },
  });
}));

/**
 * Load a session the caller is actually entitled to.
 *
 * Takes the request rather than a bare tenantId so no route can call it with
 * only the tenant in hand — the tenant-only lookup this replaced was the single
 * line behind every leak on this router.
 */
type InvitableSession = { id: string; candidateId: string; roleId: string; state: string };

async function inviteSession(req: Request, session: InvitableSession) {
  const candidate = await prisma.candidate.findUnique({ where: { id: session.candidateId } });
  const role = await prisma.role.findUnique({ where: { id: session.roleId } });
  if (!candidate || !role) throw new HttpError(404, 'Candidate or role not found');
  if (session.state !== 'PROVISIONED' && session.state !== 'RESCHEDULE_REQUIRED') throw new HttpError(409, `Cannot invite from state ${session.state}`);

  const token = nanoid(24);
  const expiresAt = new Date(Date.now() + 14 * 24 * 3600 * 1000);
  const invitation = await prisma.invitation.upsert({
    where: { sessionId: session.id },
    create: { sessionId: session.id, token, status: 'sent', sentAt: new Date(), expiresAt, eventsJson: JSON.stringify([{ type: 'sent', at: new Date().toISOString() }]) },
    update: { token, status: 'sent', sentAt: new Date(), expiresAt },
  });

  const portalUrl = `${config.webOrigin}/portal/${invitation.token}`;
  const email = getEmail();

  // Delivery is reported honestly, and a failure never loses the invitation.
  // The link is the valuable artefact — a recruiter who can see it can send it
  // by hand, whereas a 500 here would leave a half-created invitation and no
  // way to reach the candidate at all.
  let delivered = false;
  let deliveryNote: string;
  if (!email.delivers) {
    await email.send({ ...buildInvite(candidate.fullName, role.title, portalUrl), to: candidate.email }); // logs it
    deliveryNote = `No email was sent: EMAIL_PROVIDER is "${email.name}", which does not deliver. Copy the link and send it yourself.`;
    logger.warn({ sessionId: session.id, to: candidate.email }, 'Invitation created but NOT emailed — no delivering email provider configured');
  } else {
    try {
      await email.send({ ...buildInvite(candidate.fullName, role.title, portalUrl), to: candidate.email });
      delivered = true;
      deliveryNote = `Emailed to ${candidate.email}.`;
    } catch (err) {
      deliveryNote = 'The invitation link was created, but the email could not be sent. Copy the link and send it yourself.';
      logger.error({ err: err instanceof Error ? err.message : String(err), sessionId: session.id }, 'Invitation email failed to send');
    }
  }

  await prisma.invitation.update({
    where: { id: invitation.id },
    data: {
      status: delivered ? 'sent' : 'created',
      sentAt: delivered ? new Date() : null,
      eventsJson: JSON.stringify([{ type: delivered ? 'sent' : 'created_not_delivered', at: new Date().toISOString() }]),
    },
  });

  assertTransition(session.state, 'INVITED');
  await prisma.interviewSession.update({ where: { id: session.id }, data: { state: 'INVITED' } });
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: delivered ? 'invitation.sent' : 'invitation.created_not_delivered', entityType: 'InterviewSession', entityId: session.id });
  await emitEvent(req.auth!.tenantId, 'invitation.sent', { sessionId: session.id, candidateId: session.candidateId, delivered });
  return { token: invitation.token, status: delivered ? 'sent' : 'created', portalUrl, delivered, deliveryNote };
}

async function getSession(req: Request, id: string) {
  return assertCanAccessSession(req.auth!, id);
}
