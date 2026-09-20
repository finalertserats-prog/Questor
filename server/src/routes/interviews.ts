import { Router, type Request } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma, parseJsonOptional, parseJsonStrict } from '../db.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import { assertCanAccessCandidate, assertCanAccessSession, candidateScope } from '../services/access.js';
import { getPipelineSummary, type PipelineSummary } from '../services/pipeline.js';
import { buildInterviewPlan } from '../engines/interviewPlanner.js';
import { resolveCandidateBand } from '../engines/bandCalibration.js';
import type { FitScore, NormalizedProfile, RoleSuccessProfile } from '../domain/types.js';
import { assertTransition } from '../domain/stateMachine.js';
import { getEmail } from '../providers/email/index.js';
import { meetingCapability } from '../providers/meeting/index.js';
import { brandedEmail, companyEmail, emailButton, headerSafe, escapeHtml } from '../providers/email/branding.js';
import { firstName } from '../engines/openingModel.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { logAudit } from '../services/audit.js';
import { assertDemoCreationCap, demoInvitationExpiry } from '../services/demoAccess.js';
import { emitEvent } from '../services/webhooks.js';
import { startInterview, submitCandidateTurn, finalizeInterview, withdrawInterview, endReasonFor, transitionIfInState, leftByButton, LEAVE_SOURCE } from '../realtime/interviewEngine.js';
import { disclosureWithProctoringPolicy } from '../services/proctoringPolicy.js';
import { LIVE_INTERVIEW_STATES, mayObserveLive } from '../services/observerPolicy.js';
import { personaNameOf } from '../domain/persona.js';
import { DEFAULT_DISCLOSURE_BODY, composeDisclosure, needsInterviewerBackfill, otherInterviewerNamed } from '../domain/interviewerModel.js';
import { assignInterviewer } from '../services/interviewers.js';
import { invitationLink, invitationSecretColumns, mintInvitationToken } from '../services/invitations.js';
import { SUPPORTED_LANGUAGES } from '../i18n/locales.js';
import { demoRecipientBlocked } from '../services/demoPolicy.js';
import { assertRoleOpen } from '../services/roleOpen.js';
import { notePipelineEvent } from '../services/pipelineAutonomy.js';
import { replanPending } from '../services/interviewReplan.js';

export const interviewsRouter = Router();
interviewsRouter.use(authenticate);

/** The invitation a candidate receives. It reads as a note from the company's
 *  hiring team: what the next step is, how long it takes, and the link. How the
 *  interview works, including that the interviewer is an AI, is explained on the
 *  page the link opens, before the interview starts and before consent is asked.
 *  Plain-text and HTML bodies are built from the same facts, and the link is
 *  also written out, because some mail clients (Gmail in spam) disable links. */
interface InviteDetails {
  readonly candidateName: string;
  readonly roleTitle: string;
  readonly companyName: string;
  readonly portalUrl: string;
  readonly durationMinutes: number;
  readonly expiresAt: Date | null;
}

const INVITE_DATE = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

function buildInvite(d: InviteDetails) {
  const first = firstName(d.candidateName) || 'there';
  const intro = `Thank you for applying for the ${d.roleTitle} role at ${d.companyName}. We would like to invite you to the next step: a first-round interview you can do online, whenever it suits you. It takes about ${d.durationMinutes} minutes.`;
  const tips = [
    'Find a quiet spot. A laptop or a phone both work.',
    'Speak or type your answers, whichever you prefer.',
    'If you need any adjustments, you can ask for them when you open the link.',
  ];
  const until = d.expiresAt ? `The link is open until ${INVITE_DATE.format(d.expiresAt)}. You can start straight away or pick a time from the same link.` : 'You can start straight away or pick a time from the same link.';
  const text = [
    `Hi ${first},`,
    '',
    intro,
    '',
    `Start your interview: ${d.portalUrl}`,
    '',
    'A few things that help:',
    ...tips.map((tip) => `- ${tip}`),
    '',
    until,
    '',
    'Best regards,',
    `The ${d.companyName} hiring team`,
  ].join('\n');
  const html = [
    `<p style="margin:0 0 14px">Hi ${escapeHtml(first)},</p>`,
    `<p style="margin:0 0 18px">${escapeHtml(intro)}</p>`,
    emailButton(d.portalUrl, 'Start your interview'),
    '<p style="margin:4px 0 6px;font-weight:600">A few things that help</p>',
    `<ul style="margin:0 0 16px;padding-left:20px">${tips.map((tip) => `<li style="margin:0 0 6px">${escapeHtml(tip)}</li>`).join('')}</ul>`,
    `<p style="margin:0 0 18px;color:#5a5a6e;font-size:14px">${escapeHtml(until)}</p>`,
    `<p style="margin:0">Best regards,<br>The ${escapeHtml(d.companyName)} hiring team</p>`,
  ].join('\n');
  return companyEmail({
    to: '',
    subject: `Your interview for ${headerSafe(d.roleTitle)} at ${headerSafe(d.companyName)}`,
    text,
    html,
  }, d.companyName);
}

const createSchema = z.object({
  candidateId: z.string(),
  durationMinutes: z.number().int().min(10).max(120).default(45),
  language: z.string().trim().min(2).max(16).default('en'),
  modules: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  // Tone is its own setting and is stored exactly as chosen. `name` is still
  // accepted so an older client keeps working, but it no longer names anyone:
  // the interviewer below does.
  persona: z.object({ name: z.string().trim().max(80).optional(), tone: z.enum(['warm', 'neutral', 'formal']) }).default({ tone: 'warm' }),
  // 'random' (the recommended default) or one catalogue id. Unknown or
  // inactive ids are refused in assignInterviewer.
  interviewer: z.union([z.literal('random'), z.string().regex(/^[a-z]{1,32}$/)]).default('random'),
  provider: z.enum(['hosted', 'teams', 'zoom', 'meet']).default('hosted'),
  recordingRequested: z.boolean().default(false),
  humanReviewRequired: z.boolean().default(true),
  approve: z.boolean().default(true),
});

// Approve interview + build plan (FR-011, FR-016)
interviewsRouter.post('/', requireCapability('interview:create'), asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);
  await assertDemoCreationCap(req.auth!.tenantId, 'interviews');
  if (!body.approve) throw new HttpError(400, 'HR approval is required before an interview can be created');

  // Object scope, not just tenant: creating a session is how a candidate enters
  // the interview pipeline, so being able to name a candidate id must not be
  // enough to start one. Throws 404 when out of scope.
  const candidate = await assertCanAccessCandidate(req.auth!, body.candidateId);
  if (!candidate.roleId) throw new HttpError(404, 'Candidate or role not found');
  await assertRoleOpen(candidate.roleId);

  const scorecard = await prisma.roleScorecardVersion.findFirst({ where: { roleId: candidate.roleId, status: 'approved' }, orderBy: { version: 'desc' } });
  if (!scorecard) throw new HttpError(400, 'Role scorecard must be approved before interviewing (BRD FR-003).');

  const profile = parseJsonStrict<RoleSuccessProfile>(scorecard.profileJson, { model: 'RoleScorecardVersion', id: scorecard.id, field: 'profileJson' });
  const latestProfile = await prisma.candidateProfileVersion.findFirst({ where: { candidateId: candidate.id }, orderBy: { version: 'desc' } });
  const fit = latestProfile ? parseJsonStrict<FitScore>(latestProfile.fitScoreJson, { model: 'CandidateProfileVersion', id: latestProfile.id, field: 'fitScoreJson' }) : undefined;

  // Pitch the interview at the candidate rather than at the requisition. Their
  // parsed resume already knew how long they have worked and what they have
  // owned; until now none of it reached the plan, so a first-year applicant to a
  // senior req was questioned as though they held the job.
  const parsed = latestProfile ? parseJsonStrict<NormalizedProfile>(latestProfile.profileJson, { model: 'CandidateProfileVersion', id: latestProfile.id, field: 'profileJson' }) : ({} as NormalizedProfile);
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

  // Drawn once, here, and stored: a session's interviewer never changes after
  // creation, retakes included. It decides the name and voice and nothing else.
  const interviewer = await assignInterviewer(body.interviewer);

  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId } });
  const tenantPolicy = parseJsonOptional<{ disclosureText?: string }>(tenant?.policyJson ?? '{}', {}, { model: 'Tenant', id: req.auth!.tenantId, field: 'policyJson' });
  // No `recordingRequested` branch: it offered two different sentences for a
  // distinction that does not exist, since no audio artefact is produced
  // either way. Stating capture, transcription and retention plainly is both
  // true and more useful than the flag ever was. The named introduction goes
  // in front of whichever disclosure applies, never instead of it.
  const baseDisclosureText = composeDisclosure(interviewer.name, tenantPolicy.disclosureText ?? DEFAULT_DISCLOSURE_BODY);
  // Tenant wording written for an old persona ("I'm Alex, …") would give the
  // candidate two names. Not rewritten — it is the tenant's legal text — but
  // flagged so an operator can fix the policy.
  const strayName = otherInterviewerNamed(baseDisclosureText, interviewer.name);
  if (strayName) logger.warn({ tenantId: req.auth!.tenantId, strayName }, 'Tenant disclosure names a different interviewer; update the disclosure policy');
  const disclosureText = await disclosureWithProctoringPolicy({ tenantId: req.auth!.tenantId, scorecardId: scorecard.id }, baseDisclosureText);

  const session = await prisma.interviewSession.create({
    data: {
      tenantId: req.auth!.tenantId, candidateId: candidate.id, roleId: candidate.roleId, scorecardId: scorecard.id,
      state: 'PROVISIONED', provider: body.provider, language: body.language, durationMinutes: body.durationMinutes,
      personaJson: JSON.stringify({ interviewerId: interviewer.interviewerId, name: interviewer.name, tone: body.persona.tone }),
      consentJson: JSON.stringify({ disclosureText, recordingRequested: body.recordingRequested, humanReviewRequired: body.humanReviewRequired }),
      recordingConsent: false,
    },
  });
  await prisma.interviewPlanVersion.create({ data: { sessionId: session.id, version: 1, planJson: JSON.stringify(plan) } });
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'interview.approved', entityType: 'InterviewSession', entityId: session.id });
  // An interview exists for the candidate: their pipeline reaches Silver on its own.
  await notePipelineEvent({ tenantId: req.auth!.tenantId, candidateId: candidate.id, roleId: candidate.roleId, event: 'interview.scheduled', trigger: 'interview.approved' });

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
    candidate: { id: s.candidateId, name: s.candidate.fullName }, role: { id: s.roleId, title: s.role.title, level: s.role.level, regionCode: s.role.regionCode, experienceBand: s.role.experienceBand, createdAt: s.role.createdAt },
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
// Each row is a database round trip and an outbound email inside one request.
const MAX_BULK_INVITE = 200;

// Each row sends mail. Per user, not per address: everyone in an office shares one.
const bulkInviteLimit = rateLimit({ name: 'bulk-invite', windowMs: 15 * 60_000, max: 10, keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown' });

interviewsRouter.post('/bulk-invite', requireCapability('interview:invite'), bulkInviteLimit, asyncHandler(async (req, res) => {
  const rows = z.array(z.unknown()).max(MAX_BULK_INVITE).parse(req.body);
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
      // Only messages written for a caller are returned; a driver or Prisma
      // message here would bypass the sanitising in the error handler.
      if (!(err instanceof HttpError)) logger.error({ err: err instanceof Error ? err.message : String(err), candidateId }, 'bulk invite row failed');
      results.push({
        index, candidateId, success: false,
        error: err instanceof HttpError ? err.message : 'Invitation failed',
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
  const [plan, turns, assessment, invitation, integrityEvents, planPending] = await Promise.all([
    prisma.interviewPlanVersion.findUnique({ where: { sessionId: session.id } }),
    prisma.turn.findMany({ where: { sessionId: session.id }, orderBy: { index: 'asc' } }),
    prisma.assessmentVersion.findFirst({ where: { sessionId: session.id }, orderBy: { version: 'desc' } }),
    prisma.invitation.findUnique({ where: { sessionId: session.id } }),
    prisma.integrityEvent.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: 'asc' }, select: { type: true, createdAt: true } }),
    replanPending(session),
  ]);
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'interview.detail_read', entityType: 'InterviewSession', entityId: session.id });
  res.json({
    session: { id: session.id, state: session.state, provider: session.provider, language: session.language, durationMinutes: session.durationMinutes, scheduledAt: session.scheduledAt, startedAt: session.startedAt, completedAt: session.completedAt, persona: parseJsonOptional(session.personaJson, {}, { model: 'InterviewSession', id: session.id, field: 'personaJson' }), consent: parseJsonStrict(session.consentJson, { model: 'InterviewSession', id: session.id, field: 'consentJson' }) },
    plan: plan ? parseJsonStrict(plan.planJson, { model: 'InterviewPlanVersion', id: plan.id, field: 'planJson' }) : null,
    // The plan above is what was built at setup; a newer approved scorecard
    // means the interview will be re-planned from it when it starts.
    replanPending: planPending,
    turns: turns.map((t) => ({
      id: t.id, index: t.index, speaker: t.speaker, text: t.text, startMs: t.startMs, endMs: t.endMs, competencyId: t.competencyId,
      // A reviewer must be able to tell the Leave button from anything said.
      ...(leftByButton(t) ? { source: LEAVE_SOURCE } : {}),
    })),
    assessment: assessment ? { id: assessment.id, recommendation: assessment.recommendation, result: parseJsonStrict(assessment.resultJson, { model: 'AssessmentVersion', id: assessment.id, field: 'resultJson' }) } : null,
    // Integrity events are human-review context only. They are deliberately not
    // passed into assessment generation or score fields.
    integrityEvents: { count: integrityEvents.length, events: integrityEvents },
    invitation: invitation ? {
      status: invitation.status,
      // Rebuilt from the sealed copy; null only if the secret has changed since it was minted.
      portalUrl: invitationLink(invitation),
      // Both timestamps, so the recruiter can tell "we sent it" from "they saw it".
      sentAt: invitation.sentAt, openedAt: invitation.openedAt,
    } : null,
  });
}));

// Send invitation (FR-012)
interviewsRouter.post('/:id/invite', requireCapability('interview:invite'), asyncHandler(async (req, res) => {
  const session = await getSession(req, req.params.id);
  await assertRoleOpen(session.roleId);
  const invitation = await inviteSession(req, session);
  res.json({ invitation });
}));

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

/**
 * Before the interview: states the candidate's link can still start from (see
 * STARTABLE_STATES in realtime/interviewEngine.ts), minus the ones where they
 * are already connecting. PROVISIONED has no invitation yet, and is refused
 * later with a clearer message.
 */
const RESENDABLE_STATES: ReadonlySet<string> = new Set([
  'PROVISIONED', 'INVITED', 'ACCEPTED', 'READY_CHECK', 'WAITING', 'DISCLOSURE', 'CONSENTED',
]);

/** Everything that has not happened yet, plus an interview awaiting a new date. */
const SCHEDULABLE_STATES: ReadonlySet<string> = new Set([...RESENDABLE_STATES, 'RESCHEDULE_REQUIRED']);

interviewsRouter.post('/:id/retake', requireCapability('interview:invite'), asyncHandler(async (req, res) => {
  await assertDemoCreationCap(req.auth!.tenantId, 'interviews');
  const original = await getSession(req, req.params.id);
  await assertRoleOpen(original.roleId);
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
  // Losing the modules would silently drop a work sample from the retake.
  const originalModules = originalPlan
    ? parseJsonStrict<{ modules?: string[] }>(originalPlan.planJson, { model: 'InterviewPlanVersion', id: originalPlan.id, field: 'planJson' }).modules ?? []
    : [];
  // The retake keeps the original's interviewer. A session from before the
  // catalogue has none — only the retired default name — so the retake gets a
  // real interviewer now rather than inviting the candidate to meet a name
  // that no longer exists; its tone is carried over unchanged.
  const originalPersona = parseJsonOptional<Record<string, unknown>>(original.personaJson, {}, { model: 'InterviewSession', id: original.id, field: 'personaJson' });
  const replacement = needsInterviewerBackfill(originalPersona) ? await assignInterviewer('random') : null;
  const retakePersonaJson = replacement
    ? JSON.stringify({ ...originalPersona, interviewerId: replacement.interviewerId, name: replacement.name })
    : original.personaJson;
  const personaName = replacement ? replacement.name : personaNameOf(original.personaJson, original.id);

  const candidate = await assertCanAccessCandidate(req.auth!, original.candidateId);
  const scorecard = await prisma.roleScorecardVersion.findFirst({ where: { roleId: original.roleId, status: 'approved' }, orderBy: { version: 'desc' } });
  if (!scorecard) throw new HttpError(400, 'Role scorecard must be approved before interviewing (BRD FR-003).');

  const profile = parseJsonStrict<RoleSuccessProfile>(scorecard.profileJson, { model: 'RoleScorecardVersion', id: scorecard.id, field: 'profileJson' });
  const latestProfile = await prisma.candidateProfileVersion.findFirst({ where: { candidateId: candidate.id }, orderBy: { version: 'desc' } });
  const fit = latestProfile ? parseJsonStrict<FitScore>(latestProfile.fitScoreJson, { model: 'CandidateProfileVersion', id: latestProfile.id, field: 'fitScoreJson' }) : undefined;
  const parsed = latestProfile ? parseJsonStrict<NormalizedProfile>(latestProfile.profileJson, { model: 'CandidateProfileVersion', id: latestProfile.id, field: 'profileJson' }) : ({} as NormalizedProfile);
  const banding = resolveCandidateBand({ profile: parsed, resumeText: latestProfile?.rawText ?? '', roleSeniority: profile.seniority ?? '' });

  const plan = buildInterviewPlan({
    role: profile, fit, durationMinutes: original.durationMinutes, language: original.language, modules: originalModules,
    band: banding.band.id,
    bandRationale: `${banding.rationale} (decided from the ${banding.source}, confidence ${banding.confidence.toFixed(2)})`,
  });

  const tenant = await prisma.tenant.findUnique({ where: { id: req.auth!.tenantId } });
  const tenantPolicy = parseJsonOptional<{ disclosureText?: string }>(tenant?.policyJson ?? '{}', {}, { model: 'Tenant', id: req.auth!.tenantId, field: 'policyJson' });
  const baseDisclosureText = composeDisclosure(personaName, tenantPolicy.disclosureText ?? DEFAULT_DISCLOSURE_BODY);
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
        personaJson: retakePersonaJson,
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
  await notePipelineEvent({ tenantId: req.auth!.tenantId, candidateId: candidate.id, roleId: original.roleId, event: 'interview.scheduled', trigger: 'interview.retake_created' });
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
  // The link only starts an interview from these states. Resending it for one
  // that is live, finished, cancelled or handed to a person emails the
  // candidate a link that opens onto "this interview is not open".
  if (!RESENDABLE_STATES.has(session.state)) {
    throw new HttpError(409, `This interview is ${session.state}, so there is no invitation to resend. Only an interview the candidate has not started yet can be resent.`);
  }
  const invitation = await prisma.invitation.findUnique({ where: { sessionId: session.id } });
  if (!invitation) throw new HttpError(404, 'This interview has no invitation yet — send one first.');
  if (invitation.status === 'consumed') throw new HttpError(409, 'This interview is already complete.');
  if (invitation.expiresAt && invitation.expiresAt < new Date()) {
    throw new HttpError(410, 'This invitation has expired. Create a new interview for this candidate.');
  }

  const candidate = await prisma.candidate.findUnique({ where: { id: session.candidateId } });
  const role = await prisma.role.findUnique({ where: { id: session.roleId } });
  const portalUrl = invitationLink(invitation);
  if (!portalUrl) throw new HttpError(409, 'This invitation link can no longer be reconstructed. Create a new interview for this candidate.');
  if (await demoRecipientBlocked(req.auth!.tenantId, candidate!.email)) throw new HttpError(403, 'In the demo, email goes only to you. Use your own address for the candidate, or copy the interview link.');
  const email = getEmail();

  if (!email.delivers) {
    throw new HttpError(503, `Email is not configured to deliver (provider "${email.name}"). Copy the candidate's link and send it yourself.`);
  }

  try {
    const tenant = await prisma.tenant.findUnique({ where: { id: session.tenantId }, select: { name: true } });
    await email.send({ ...buildInvite({ candidateName: candidate!.fullName, roleTitle: role!.title, companyName: tenant?.name ?? 'our', portalUrl, durationMinutes: session.durationMinutes, expiresAt: invitation.expiresAt }), to: candidate!.email });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), sessionId: session.id }, 'Invitation resend failed');
    throw new HttpError(502, 'The email could not be sent. Copy the link and send it yourself, or try again.');
  }

  const events = parseJsonOptional<Array<Record<string, unknown>>>(invitation.eventsJson, [], { model: 'Invitation', id: invitation.id, field: 'eventsJson' });
  events.push({ type: 'resent', at: new Date().toISOString(), by: req.auth!.userId });
  await prisma.invitation.update({
    where: { id: invitation.id },
    data: { status: invitation.status === 'created' ? 'sent' : invitation.status, sentAt: new Date(), eventsJson: JSON.stringify(events) },
  });

  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'invitation.resent', entityType: 'InterviewSession', entityId: session.id });
  res.json({ resent: true, to: candidate!.email, portalUrl, deliveryNote: `Sent again to ${candidate!.email}.` });
}));

// Schedule (FR-013).
//
// Gated on interview:schedule, which recruiter, manager and admin hold (not
// reviewer or auditor) — the same people who held the invite grant these two
// routes borrowed before the capability existed.
interviewsRouter.post('/:id/schedule', requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
  const session = await getSession(req, req.params.id);
  // A bare string became `new Date('x')`, an Invalid Date, a Prisma throw and a 500.
  const at = z.object({ scheduledAt: z.string().datetime({ offset: true }) }).parse(req.body).scheduledAt;
  // A date on a closed, cancelled or already-held interview is a promise to the
  // candidate that nothing will keep. Conditional, so a session that moves on
  // between the read and the write is refused rather than overwritten.
  const { count } = await prisma.interviewSession.updateMany({
    where: { id: session.id, state: { in: [...SCHEDULABLE_STATES] } },
    data: { scheduledAt: new Date(at) },
  });
  if (count !== 1) {
    throw new HttpError(409, `This interview is ${session.state}, so it can no longer be scheduled.`);
  }
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'interview.scheduled', entityType: 'InterviewSession', entityId: session.id, after: { scheduledAt: at } });
  await notePipelineEvent({ tenantId: req.auth!.tenantId, candidateId: session.candidateId, roleId: session.roleId, event: 'interview.scheduled', trigger: 'interview.scheduled' });
  res.json({ ok: true, scheduledAt: at });
}));

// Cancel / reschedule (FR-014)
interviewsRouter.post('/:id/cancel', requireCapability('interview:schedule'), asyncHandler(async (req, res) => {
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
    await withdrawInterview(req.params.id, endReasonFor(turn.kind));
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

  // Back to a state finalizeInterview accepts, then score it. Conditional on
  // the session still being INCOMPLETE: a double-click or two reviewers at once
  // both passed the check above, and an update-by-id let both walk the session
  // into finalisation. Exactly one request wins this claim.
  if (!await transitionIfInState(session.id, 'INCOMPLETE', 'CLOSING')) {
    throw new HttpError(409, 'This interview is already being assessed. Refresh to see the result.');
  }
  // `partial` so the candidate is not emailed feedback on an interview they
  // did not finish (services/autoFeedback.ts).
  const { assessmentId } = await finalizeInterview(session.id, { partial: true });

  // Recorded after the assessment exists, so the trail never claims a person
  // assessed a partial interview when the request was refused or failed.
  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user',
    action: 'interview.assess_partial', entityType: 'InterviewSession', entityId: session.id,
    after: { reason, assessmentId },
  });
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
    persona: { name: personaNameOf(session.personaJson, session.id) },
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
type InvitableSession = { id: string; tenantId: string; candidateId: string; roleId: string; state: string; personaJson: string; durationMinutes: number };

async function inviteSession(req: Request, session: InvitableSession) {
  const candidate = await prisma.candidate.findUnique({ where: { id: session.candidateId } });
  const role = await prisma.role.findUnique({ where: { id: session.roleId } });
  if (!candidate || !role) throw new HttpError(404, 'Candidate or role not found');
  if (session.state !== 'PROVISIONED' && session.state !== 'RESCHEDULE_REQUIRED') throw new HttpError(409, `Cannot invite from state ${session.state}`);
  // Checked before anything is sent. This used to run after the email had
  // gone, so an illegal transition surfaced as a 500 with the mail already out.
  assertTransition(session.state, 'INVITED');
  // A re-invite must add to the invitation's history, not start it over: the
  // update below used to write a one-element list, erasing every earlier
  // sent / resent / not-delivered event.
  const previous = await prisma.invitation.findUnique({ where: { sessionId: session.id }, select: { id: true, eventsJson: true } });
  const priorEvents = previous ? parseJsonOptional<unknown[]>(previous.eventsJson, [], { model: 'Invitation', id: previous.id, field: 'eventsJson' }) : [];

  // Before the link exists: a demo sandbox may only invite its own visitor.
  if (await demoRecipientBlocked(req.auth!.tenantId, candidate.email)) throw new HttpError(403, 'In the demo, email goes only to you. Use your own address for the candidate, or copy the interview link.');
  const token = mintInvitationToken();
  const secret = invitationSecretColumns(token);
  const expiresAt = await demoInvitationExpiry(req.auth!, new Date(Date.now() + 14 * 24 * 3600 * 1000));
  const invitation = await prisma.invitation.upsert({
    where: { sessionId: session.id },
    create: { sessionId: session.id, ...secret, status: 'sent', sentAt: new Date(), expiresAt, eventsJson: JSON.stringify([{ type: 'sent', at: new Date().toISOString() }]) },
    update: { ...secret, token: null, status: 'sent', sentAt: new Date(), expiresAt },
  });

  const portalUrl = `${config.webOrigin}/portal/${token}`;
  const email = getEmail();
  const tenant = await prisma.tenant.findUnique({ where: { id: session.tenantId }, select: { name: true } });
  const invite = buildInvite({ candidateName: candidate.fullName, roleTitle: role.title, companyName: tenant?.name ?? 'our', portalUrl, durationMinutes: session.durationMinutes, expiresAt });

  // Delivery is reported honestly, and a failure never loses the invitation.
  // The link is the valuable artefact — a recruiter who can see it can send it
  // by hand, whereas a 500 here would leave a half-created invitation and no
  // way to reach the candidate at all.
  let delivered = false;
  let deliveryNote: string;
  if (!email.delivers) {
    await email.send({ ...invite, to: candidate.email }); // logs it
    deliveryNote = `No email was sent: EMAIL_PROVIDER is "${email.name}", which does not deliver. Copy the link and send it yourself.`;
    logger.warn({ sessionId: session.id, to: candidate.email }, 'Invitation created but NOT emailed — no delivering email provider configured');
  } else {
    try {
      await email.send({ ...invite, to: candidate.email });
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
      eventsJson: JSON.stringify([...priorEvents, { type: delivered ? 'sent' : 'created_not_delivered', at: new Date().toISOString() }]),
    },
  });

  await prisma.interviewSession.update({ where: { id: session.id }, data: { state: 'INVITED' } });
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: delivered ? 'invitation.sent' : 'invitation.created_not_delivered', entityType: 'InterviewSession', entityId: session.id });
  // Covers the bulk path too: a candidate invited to an interview is at Silver.
  await notePipelineEvent({ tenantId: req.auth!.tenantId, candidateId: session.candidateId, roleId: session.roleId, event: 'interview.scheduled', trigger: 'invitation.sent' });
  await emitEvent(req.auth!.tenantId, 'invitation.sent', { sessionId: session.id, candidateId: session.candidateId, delivered });
  return { token, status: delivered ? 'sent' : 'created', portalUrl, delivered, deliveryNote };
}

async function getSession(req: Request, id: string) {
  return assertCanAccessSession(req.auth!, id);
}
