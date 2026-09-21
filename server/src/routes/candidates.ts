import path from 'node:path';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma, parseJsonOptional, parseJsonStrict } from '../db.js';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { eraseCandidate } from '../services/dataRights.js';
import { applicationIdsForAddress, eraseAllApplications } from '../services/personErasure.js';
import { capabilitiesOf } from '../domain/capabilities.js';
import type { AuthClaims } from '../services/auth.js';
import {
  assertCanAccessCandidate,
  assertCanAccessRole,
  assignCandidate,
  candidateScope,
  roleScope,
} from '../services/access.js';
import { MAX_RESUME_TEXT_CHARS, extractResumeText, isResumeMimeType } from '../engines/resumeParser.js';
import { computeFitScore } from '../engines/fitScoring.js';
import { roleTechStack } from '../services/roleTechStack.js';
import type { NormalizedProfile, RoleSuccessProfile } from '../domain/types.js';
import { logAudit } from '../services/audit.js';
import { assertDemoCreationCap } from '../services/demoAccess.js';
import { emitEvent } from '../services/webhooks.js';
import { candidateFeedbackState } from '../services/candidateFeedback.js';
import { assertRoleOpen } from '../services/roleOpen.js';
import { notePipelineEvent } from '../services/pipelineAutonomy.js';
import { normalizeEmail } from '../services/userEmail.js';
import { resumeScoringFor, storeResumeProfile } from '../services/resumeProfile.js';
import {
  applyCandidateToRole,
  CANDIDATE_SEARCH_MIN_CHARS,
  findApplicationOnRole,
  inApplicationTransaction,
  searchCandidatePeople,
} from '../services/candidateReuse.js';

export const candidatesRouter = Router();
candidatesRouter.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  // Buffers live in process memory, so the ceiling is deliberately far below
  // anything a genuine resume needs; one file per request keeps a single upload
  // from fanning out into repeated parses.
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!isResumeMimeType(file.mimetype)) {
      cb(new HttpError(400, 'Only PDF, DOCX, or plain-text resumes are accepted'));
      return;
    }
    cb(null, true);
  },
});

// Multer rejections (size cap, file count) are not HttpErrors, so without this
// a rejected upload would be reported to the client as a 500.
function uploadResume(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      next(new HttpError(400, `Upload rejected: ${err.code === 'LIMIT_FILE_SIZE' ? 'file exceeds the 5 MB limit' : 'only a single resume file is accepted'}`));
      return;
    }
    next(err);
  });
}

// The stored filename is echoed back into the reviewer's browser, so strip any
// path the client smuggled in and keep only characters that cannot be read as
// markup or as a traversal segment.
function sanitizeFilename(original: string): string {
  const cleaned = path
    .basename(original)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || 'resume.txt';
}

// List candidates (optionally by role)
//
// candidate:read is asked for here as it is on /api/interviews and the
// dashboard: names, addresses and resume text are candidate detail, and an
// auditor holds no capability to see them.
// A repeated `?roleId=a&roleId=b` arrives as an array; cast to string it
// reached Prisma as one and failed there as a 500.
const listQuerySchema = z.object({ roleId: z.string().min(1).max(64).optional() });

candidatesRouter.get('/', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const { roleId } = listQuerySchema.parse(req.query);
  // `roleId` is ANDed with the caller's scope, so it can only ever NARROW the
  // result set. Previously it was the whole filter beside tenantId, which turned
  // a display convenience into "enumerate any requisition's pipeline by id".
  const candidates = await prisma.candidate.findMany({
    where: { ...(await candidateScope(req.auth!)), ...(roleId ? { roleId } : {}) },
    orderBy: { createdAt: 'desc' },
    include: { profiles: { orderBy: { version: 'desc' }, take: 1 }, role: true, interviews: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  res.json({ candidates: candidates.map((c) => ({
    id: c.id, fullName: c.fullName, email: c.email, roleId: c.roleId, roleTitle: c.role?.title ?? null,
    roleLevel: c.role?.level ?? null, roleRegionCode: c.role?.regionCode ?? null, roleExperienceBand: c.role?.experienceBand ?? null, roleCreatedAt: c.role?.createdAt ?? null,
    fit: c.profiles[0] ? parseJsonOptional<Record<string, unknown> | null>(c.profiles[0].fitScoreJson, null, { model: 'CandidateProfileVersion', id: c.profiles[0].id, field: 'fitScoreJson' }) : null,
    latestInterview: c.interviews[0] ? { id: c.interviews[0].id, state: c.interviews[0].state } : null,
    createdAt: c.createdAt,
  })) });
}));

// People already in Questor, for the type-ahead on Add candidate and for
// "Set up for another role". Declared before /:id, which would otherwise read
// "search" as a candidate id. Scoped like the list: only rows the caller may
// see are searched, and only those rows' roles are named.
const searchQuerySchema = z.object({ q: z.string().trim().min(CANDIDATE_SEARCH_MIN_CHARS).max(254) });

candidatesRouter.get('/search', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const { q } = searchQuerySchema.parse(req.query);
  res.json({ people: await searchCandidatePeople(req.auth!, q) });
}));

const createSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().max(40).optional(),
  roleId: z.string().min(1).max(64),
});

// Create a candidate under a role
candidatesRouter.post('/', requireCapability('candidate:create'), asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);
  await assertDemoCreationCap(req.auth!.tenantId, 'candidates');
  // The target role is scoped, not merely tenant-matched: attaching a candidate
  // to someone else's requisition would otherwise plant a record inside a
  // pipeline the caller cannot see but the role's owners can.
  await assertCanAccessRole(req.auth!, body.roleId);
  await assertRoleOpen(body.roleId);
  const tenantId = req.auth!.tenantId;
  const emailNormalized = normalizeEmail(body.email);
  // One application per person per role, as /:id/apply refuses too. The check
  // and the row (with its owner) commit together, so two identical adds at
  // once cannot both pass it.
  const outcome = await inApplicationTransaction(async (tx) => {
    const existing = await findApplicationOnRole(tx, { tenantId, roleId: body.roleId, emailNormalized });
    if (existing) return { kind: 'exists' as const, candidateId: existing.id };
    const made = await tx.candidate.create({
      data: { tenantId, roleId: body.roleId, fullName: body.fullName, email: body.email, emailNormalized, phone: body.phone ?? '' },
    });
    // Role assignment alone would already cover this candidate, but the explicit
    // grant survives the creator later being unassigned from the role.
    await assignCandidate(made.id, req.auth!.userId, 'owner', tx);
    return { kind: 'created' as const, candidate: made };
  });
  if (outcome.kind === 'exists') {
    res.status(409).json({ error: 'This person is already a candidate for that role.', code: 'candidate_exists', candidateId: outcome.candidateId });
    return;
  }
  const { candidate } = outcome;
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'candidate.created', entityType: 'Candidate', entityId: candidate.id });
  // Onboarding starts the candidate's journey at Participation on its own.
  await notePipelineEvent({ tenantId: req.auth!.tenantId, candidateId: candidate.id, roleId: candidate.roleId, event: 'candidate.onboarded', trigger: 'candidate.created' });
  res.status(201).json({ candidate: shape(candidate) });
}));

// Put an existing person forward for another role: a new application with
// their details and latest resume copied, re-scored for that role. A second
// application for the same address on the same role is refused with the one
// already there, which the caller can always see (it sits on a role they can
// access).
const applyBodySchema = z.object({ roleId: z.string().min(1).max(64) });

candidatesRouter.post('/:id/apply', requireCapability('candidate:create'), asyncHandler(async (req, res) => {
  const { id } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
  const { roleId } = applyBodySchema.parse(req.body ?? {});
  const result = await applyCandidateToRole(req.auth!, id, roleId);
  if (result.kind === 'exists') {
    res.status(409).json({ error: 'This person is already a candidate for that role.', code: 'candidate_exists', candidateId: result.candidateId });
    return;
  }
  res.status(201).json({ candidate: shape(result.candidate), profileCopied: result.profileCopied, fit: result.fit });
}));

// Upload + parse resume, compute fit score, build evidence graph (FR-006..010)
// A write, gated like the create it belongs to. Object scope alone let a
// reviewer assigned to a candidate replace their profile, rewrite the evidence
// graph and rescore the fit.
const resumeLimit = rateLimit({ name: 'resume-upload', windowMs: 15 * 60_000, max: 60, keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown' });

candidatesRouter.post('/:id/resume', requireCapability('candidate:create'), resumeLimit, uploadResume, asyncHandler(async (req, res) => {
  const candidate = await assertCanAccessCandidate(req.auth!, req.params.id);
  let rawText = '';
  let filename = 'pasted.txt';
  if (req.file) {
    filename = sanitizeFilename(req.file.originalname);
    try {
      rawText = await extractResumeText(req.file.buffer, req.file.mimetype);
    } catch (err) {
      // extractResumeText already reports why it refused the file; only genuinely
      // unexpected failures fall back to the generic FR-006 message.
      if (err instanceof HttpError) throw err;
      throw new HttpError(422, 'Could not read the uploaded file. Please upload a text-based PDF, DOCX, or paste the resume text.');
    }
  } else if (typeof req.body.text === 'string') {
    // Pasted text bypasses the parsers but still lands in the same downstream
    // path, so it gets the same ceiling.
    rawText = req.body.text.slice(0, MAX_RESUME_TEXT_CHARS);
  }
  if (!rawText.trim()) throw new HttpError(400, 'No resume text found');

  const { profile, fit, profileVersionId } = await storeResumeProfile(prisma, {
    tenantId: req.auth!.tenantId, candidateId: candidate.id, rawText, filename,
    contentType: req.file?.mimetype ?? 'text/plain', scoring: await resumeScoringFor(candidate.roleId),
  });
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'candidate.parsed', entityType: 'Candidate', entityId: candidate.id });
  await emitEvent(req.auth!.tenantId, 'candidate.parsed', { candidateId: candidate.id, fit: fit.overall });
  // An analysed profile is what the Bronze review works from: Participation is over.
  await notePipelineEvent({ tenantId: req.auth!.tenantId, candidateId: candidate.id, roleId: candidate.roleId, event: 'candidate.profiled', trigger: 'candidate.parsed' });

  res.status(201).json({ profile, fit, profileVersionId, filename });
}));


const candidateIdParams = z.object({ id: z.string().min(1) });
const MAX_ALTERNATIVE_ROLES_CONSIDERED = 50;
const MAX_ALTERNATIVE_ROLES_RETURNED = 5;

function publicFit(fit: any) {
  if (!fit) return null;
  const { excludedSignals: _excludedSignals, ...rest } = fit;
  return {
    ...rest,
    components: (rest.components ?? []).map((c: any) => ({
      key: c.key,
      label: c.label,
      weight: c.weight,
      score: c.score,
      evidence: (c.evidence ?? []).slice(0, 3),
      rule: c.rule,
    })),
  };
}

function fitTextFromProfile(profile: any): string {
  const parts: string[] = [];
  if (Array.isArray(profile?.skills)) parts.push(...profile.skills);
  if (Array.isArray(profile?.employment)) {
    for (const job of profile.employment) {
      parts.push(job?.title, job?.company);
      if (Array.isArray(job?.bullets)) parts.push(...job.bullets);
    }
  }
  if (Array.isArray(profile?.projects)) {
    for (const project of profile.projects) parts.push(project?.name, project?.summary);
  }
  if (Array.isArray(profile?.certifications)) parts.push(...profile.certifications);
  return parts.filter((part) => typeof part === 'string' && part.trim()).join('\n');
}

function explainAlternative(score: number, current: number | null, fit: any): string {
  const strongest = [...(fit.components ?? [])]
    .sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 2)
    .map((c: any) => c.label.toLowerCase());
  const basis = strongest.length ? `Strongest evidence: ${strongest.join(' and ')}.` : 'Limited scorecard evidence was available.';
  // With no fit for the applied role there is nothing to be stronger than.
  // This used to measure against a fabricated zero, so every alternative
  // read as "N points stronger" and HR was nudged to move the candidate.
  if (current === null) return `No fit for the applied role to compare against. ${basis}`;
  const delta = Math.round(score - current);
  return delta > 0
    ? `${delta} points stronger than the applied role. ${basis}`
    : `Not stronger than the applied role. ${basis}`;
}

// Candidate profile tab: scoped candidate data, current fit, and ranked alternatives.
candidatesRouter.get('/:id/profile-analysis', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const { id } = candidateIdParams.parse(req.params);
  const candidate = await assertCanAccessCandidate(req.auth!, id);
  const profileVersion = await prisma.candidateProfileVersion.findFirst({
    where: { candidateId: candidate.id },
    orderBy: { version: 'desc' },
  });
  const currentRole = candidate.roleId
    ? await prisma.role.findFirst({ where: { id: candidate.roleId, tenantId: req.auth!.tenantId } })
    : null;

  await logAudit({
    tenantId: req.auth!.tenantId,
    actorId: req.auth!.userId,
    actorType: 'user',
    action: 'candidate.profile_analysis.read',
    entityType: 'Candidate',
    entityId: candidate.id,
  });

  if (!profileVersion) {
    res.json({
      candidate: shape(candidate),
      currentRole: currentRole ? { id: currentRole.id, title: currentRole.title, level: currentRole.level } : null,
      profileVersion: null,
      profile: null,
      currentFit: null,
      alternativeRoles: [],
      consideredRoleCount: 0,
      betterFitMessage: 'No resume profile has been parsed yet, so Questor cannot compare this candidate to other roles.',
      caveat: 'Fit scores are heuristic and have not been validated against human judgement. Use them as prompts for review, not as hiring verdicts.',
    });
    return;
  }

  const profile = parseJsonStrict<NormalizedProfile>(profileVersion.profileJson, { model: 'CandidateProfileVersion', id: profileVersion.id, field: 'profileJson' });
  const currentStoredFit = publicFit(parseJsonStrict<Record<string, unknown>>(profileVersion.fitScoreJson, { model: 'CandidateProfileVersion', id: profileVersion.id, field: 'fitScoreJson' }));
  const fitText = fitTextFromProfile(profile);

  const scopedRoles = await prisma.role.findMany({
    where: { AND: [await roleScope(req.auth!), { status: 'approved' }] },
    orderBy: { updatedAt: 'desc' },
    take: MAX_ALTERNATIVE_ROLES_CONSIDERED,
    include: {
      scorecards: {
        where: { status: 'approved' },
        orderBy: { version: 'desc' },
        take: 1,
      },
    },
  });

  const currentRoleWithScorecard = scopedRoles.find((r) => r.id === candidate.roleId) ?? null;
  const currentScorecard = currentRoleWithScorecard?.scorecards[0] ?? null;
  const currentFit = currentScorecard
    ? publicFit(computeFitScore(profile ?? {}, fitText, parseJsonStrict<RoleSuccessProfile>(currentScorecard.profileJson, { model: 'RoleScorecardVersion', id: currentScorecard.id, field: 'profileJson' }), currentRoleWithScorecard ? roleTechStack(currentRoleWithScorecard) : []).fit)
    : currentStoredFit;
  const currentOverall: number | null = typeof currentFit?.overall === 'number' ? currentFit.overall : null;

  const alternatives = scopedRoles
    .filter((r) => r.id !== candidate.roleId && r.scorecards[0])
    .map((r) => {
      const fit = publicFit(computeFitScore(profile ?? {}, fitText, parseJsonStrict<RoleSuccessProfile>(r.scorecards[0].profileJson, { model: 'RoleScorecardVersion', id: r.scorecards[0].id, field: 'profileJson' }), roleTechStack(r)).fit)!;
      return {
        roleId: r.id,
        title: r.title,
        level: r.level,
        score: fit.overall,
        confidence: fit.confidence,
        components: fit.components,
        why: explainAlternative(fit.overall, currentOverall, fit),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ALTERNATIVE_ROLES_RETURNED);

  const better = currentOverall === null ? [] : alternatives.filter((a) => a.score > currentOverall);
  const betterFitMessage = alternatives.length === 0
    ? 'There are no other approved roles in your visible scope to compare.'
    : currentOverall === null
      ? 'There is no fit score for the applied role yet, so the other roles are listed without a comparison.'
    : better.length === 0
      ? 'No visible approved role appears to be a better fit than the current applied role.'
      : `${better.length} visible approved role${better.length === 1 ? '' : 's'} scored higher than the current applied role.`;

  res.json({
    candidate: shape(candidate),
    currentRole: currentRole ? { id: currentRole.id, title: currentRole.title, level: currentRole.level } : null,
    profileVersion: { id: profileVersion.id, version: profileVersion.version, createdAt: profileVersion.createdAt },
    profile,
    currentFit,
    alternativeRoles: alternatives,
    consideredRoleCount: scopedRoles.length,
    betterFitMessage,
    caveat: 'Fit scores are heuristic and have not been validated against human judgement. Use them as prompts for review, not as hiring verdicts.',
  });
}));

// Get candidate detail (profile + fit + evidence)
candidatesRouter.get('/:id', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const candidate = await assertCanAccessCandidate(req.auth!, req.params.id);
  const profileVersion = await prisma.candidateProfileVersion.findFirst({ where: { candidateId: candidate.id }, orderBy: { version: 'desc' }, include: { evidenceNodes: true } });
  const interviews = await prisma.interviewSession.findMany({ where: { candidateId: candidate.id }, orderBy: { createdAt: 'desc' } });
  // Three facts the owner of this candidate needs and would otherwise have to
  // go looking for: did they ask for feedback, is a draft waiting, and have they
  // asked to speak to someone. Scoped by the assertCanAccessCandidate above.
  const candidateFeedback = await candidateFeedbackState(interviews.map((i) => i.id));
  const otherApplications = await otherApplicationCount(req.auth!, candidate);
  res.json({
    candidate: shape(candidate),
    profile: profileVersion ? parseJsonStrict<Record<string, unknown>>(profileVersion.profileJson, { model: 'CandidateProfileVersion', id: profileVersion.id, field: 'profileJson' }) : null,
    fit: profileVersion ? parseJsonStrict<Record<string, unknown>>(profileVersion.fitScoreJson, { model: 'CandidateProfileVersion', id: profileVersion.id, field: 'fitScoreJson' }) : null,
    rawText: profileVersion?.rawText ?? '',
    interviews: interviews.map((i) => ({ id: i.id, state: i.state, scheduledAt: i.scheduledAt, scheduledTimeZone: i.scheduledTimeZone, createdAt: i.createdAt })),
    candidateFeedback,
    ...(otherApplications === null ? {} : { otherApplications }),
  });
}));

/**
 * How many other applications the same address has, for the erase control —
 * so only for a caller who may erase, and counted within their scope, which
 * for an admin is the whole organisation. Null for anyone else.
 */
async function otherApplicationCount(auth: AuthClaims, candidate: { id: string; email: string; emailNormalized: string }): Promise<number | null> {
  if (!capabilitiesOf(auth.role).includes('candidate:erase')) return null;
  const ids = await applicationIdsForAddress(await candidateScope(auth), candidate);
  return ids.filter((id) => id !== candidate.id).length;
}

// Right to erasure: GDPR Art. 17, India DPDP s.8, Illinois AIVIA s.20 (which
// requires deletion within 30 days of request, including copies). Irreversible;
// the audit trail records that it happened.
//
// Gated on the `candidate:erase` capability rather than the literal role name:
// `requireRole('admin')` also silently admitted anyone the role map later grants
// an admin-ish role, and it stated the grant in a second place that could drift
// from capabilities.ts. Only admin holds this capability today.
//
// `allApplications` erases every application in the organisation for the same
// address — the person, not only this role's record — each through the same
// path; any under legal hold is skipped and reported rather than refused.
const eraseBodySchema = z.object({ reason: z.string().min(1).max(500), allApplications: z.boolean().optional() });

candidatesRouter.delete('/:id', requireCapability('candidate:erase'), asyncHandler(async (req, res) => {
  const { reason, allApplications } = eraseBodySchema.parse(req.body ?? {});
  await assertCanAccessCandidate(req.auth!, req.params.id);
  if (allApplications) {
    const person = await eraseAllApplications({ tenantId: req.auth!.tenantId, candidateId: req.params.id, actorId: req.auth!.userId, reason });
    res.json({ ...person, erasedCount: person.erasedIds.length, skippedCount: person.skipped.length });
    return;
  }
  const result = await eraseCandidate({
    tenantId: req.auth!.tenantId,
    candidateId: req.params.id,
    actorId: req.auth!.userId,
    reason,
  });
  res.json({ erased: true, ...result });
}));

// The former `getCandidate(tenantId, id)` helper is deliberately deleted rather
// than repaired: it read like an access check while only ever matching a tenant,
// so every route that reached for it inherited the hole. `assertCanAccessCandidate`
// is now the only lookup path.

function shape(c: any) { return { id: c.id, fullName: c.fullName, email: c.email, phone: c.phone, roleId: c.roleId, createdAt: c.createdAt }; }
