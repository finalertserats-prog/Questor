import { Router, type Request } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { prisma, parseJson } from '../db.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import { assertCanAccessCandidate, assertCanAccessSession, candidateScope } from '../services/access.js';
import { buildInterviewPlan } from '../engines/interviewPlanner.js';
import type { FitScore, RoleSuccessProfile } from '../domain/types.js';
import { assertTransition } from '../domain/stateMachine.js';
import { getEmail } from '../providers/email/index.js';
import { meetingCapability } from '../providers/meeting/index.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { logAudit } from '../services/audit.js';
import { emitEvent } from '../services/webhooks.js';
import { startInterview, submitCandidateTurn, finalizeInterview } from '../realtime/interviewEngine.js';

export const interviewsRouter = Router();
interviewsRouter.use(authenticate);

/** The invitation a candidate receives. Kept in one place so the plain-text and
 *  HTML bodies cannot drift apart — a candidate whose client strips HTML must
 *  still get a working link. */
function buildInvite(candidateName: string, roleTitle: string, portalUrl: string) {
  return {
    to: '',
    subject: `Your first-round interview for ${roleTitle}`,
    text: `Hi ${candidateName},\n\nYou're invited to a first-round interview for ${roleTitle}. This interview is conducted by Questor, an AI voice interviewer, and will be transcribed.\n\nStart or schedule here: ${portalUrl}\n\nYou can review privacy information and consent before you begin.\n\nThanks,\nRecruiting Team`,
    html: `<p>Hi ${candidateName},</p><p>You're invited to a first-round interview for <b>${roleTitle}</b>, conducted by <b>Questor</b>, an AI voice interviewer. It will be transcribed.</p><p><a href="${portalUrl}">Start or schedule your interview</a></p>`,
  };
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

  const plan = buildInterviewPlan({ role: profile, fit, durationMinutes: body.durationMinutes, language: body.language, modules: body.modules });

  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId } });
  const tenantPolicy = parseJson<any>(tenant?.policyJson ?? '{}', {});
  const disclosureText = tenantPolicy.disclosureText ??
    // No `recordingRequested` branch: it offered two different sentences for a
    // distinction that does not exist, since no audio artefact is produced
    // either way. Stating capture, transcription and retention plainly is both
    // true and more useful than the flag ever was.
    `Hello, I'm ${body.persona.name}, an AI interviewer for this first-round conversation. Your voice is transcribed as we talk — no audio recording is kept, but the written transcript is, and a person on the hiring team reads it. I'll ask about your relevant experience. You can ask me to repeat anything or request a pause at any time.`;

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

// Session detail.
//
// This response includes the live invitation token, which is a bearer
// credential for the unauthenticated candidate portal — anyone holding it can
// open the candidate's interview. Scope here is what stops one recruiter from
// lifting another's portal link.
interviewsRouter.get('/:id', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const session = await getSession(req, req.params.id);
  const [plan, turns, assessment, invitation] = await Promise.all([
    prisma.interviewPlanVersion.findUnique({ where: { sessionId: session.id } }),
    prisma.turn.findMany({ where: { sessionId: session.id }, orderBy: { index: 'asc' } }),
    prisma.assessmentVersion.findFirst({ where: { sessionId: session.id }, orderBy: { version: 'desc' } }),
    prisma.invitation.findUnique({ where: { sessionId: session.id } }),
  ]);
  res.json({
    session: { id: session.id, state: session.state, provider: session.provider, language: session.language, durationMinutes: session.durationMinutes, scheduledAt: session.scheduledAt, persona: parseJson(session.personaJson, {}), consent: parseJson(session.consentJson, {}) },
    plan: plan ? parseJson(plan.planJson, {}) : null,
    turns: turns.map((t) => ({ id: t.id, index: t.index, speaker: t.speaker, text: t.text, startMs: t.startMs, endMs: t.endMs, competencyId: t.competencyId })),
    assessment: assessment ? { id: assessment.id, recommendation: assessment.recommendation, result: parseJson(assessment.resultJson, {}) } : null,
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
  const candidate = await prisma.candidate.findUnique({ where: { id: session.candidateId } });
  const role = await prisma.role.findUnique({ where: { id: session.roleId } });
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
    await email.send({ ...buildInvite(candidate!.fullName, role!.title, portalUrl), to: candidate!.email }); // logs it
    deliveryNote = `No email was sent: EMAIL_PROVIDER is "${email.name}", which does not deliver. Copy the link and send it yourself.`;
    logger.warn({ sessionId: session.id, to: candidate!.email }, 'Invitation created but NOT emailed — no delivering email provider configured');
  } else {
    try {
      await email.send({ ...buildInvite(candidate!.fullName, role!.title, portalUrl), to: candidate!.email });
      delivered = true;
      deliveryNote = `Emailed to ${candidate!.email}.`;
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
  res.json({ invitation: { token: invitation.token, status: delivered ? 'sent' : 'created', portalUrl, delivered, deliveryNote } });
}));

// Schedule (FR-013)
//
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
  if (turn.done) ({ assessmentId } = await finalizeInterview(req.params.id));
  res.json({ turn, assessmentId });
}));
interviewsRouter.post('/:id/finalize', requireCapability('interview:drive'), asyncHandler(async (req, res) => {
  await getSession(req, req.params.id);
  const { assessmentId } = await finalizeInterview(req.params.id);
  res.json({ assessmentId });
}));

interviewsRouter.get('/:id/transcript', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const session = await getSession(req, req.params.id);
  const turns = await prisma.turn.findMany({ where: { sessionId: session.id }, orderBy: { index: 'asc' } });
  res.json({ transcript: turns.map((t) => ({ index: t.index, speaker: t.speaker, text: t.text, startMs: t.startMs })) });
}));

/**
 * Load a session the caller is actually entitled to.
 *
 * Takes the request rather than a bare tenantId so no route can call it with
 * only the tenant in hand — the tenant-only lookup this replaced was the single
 * line behind every leak on this router.
 */
async function getSession(req: Request, id: string) {
  return assertCanAccessSession(req.auth!, id);
}
