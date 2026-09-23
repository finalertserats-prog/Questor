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
import { assertCanAccessCandidate, candidateScope, roleScope } from '../services/access.js';
import { MAX_RESUME_TEXT_CHARS, isResumeMimeType } from '../engines/resumeParser.js';
import { RESUME_MAX_BYTES, readResumeFile, sanitizeFilename } from '../services/resumeFile.js';
import { FIT_ENGINE_VERSION, scoreFit } from '../engines/fitScoring.js';
import { storedCvFacts } from '../services/resumeProfile.js';
import { FIT_CAVEAT } from '../domain/fitVocabulary.js';
import type { FitScore } from '../domain/types.js';
import { roleTechStack } from '../services/roleTechStack.js';
import { listCandidates } from '../services/candidateList.js';
import { pagingQuerySchema } from '../services/listPaging.js';
import type { NormalizedProfile, RoleSuccessProfile } from '../domain/types.js';
import { logAudit } from '../services/audit.js';
import { candidateFeedbackState } from '../services/candidateFeedback.js';
import {
  applyCandidateToRole,
  CANDIDATE_SEARCH_MIN_CHARS,
  searchCandidatePeople,
} from '../services/candidateReuse.js';
import { attachResume, createApplication } from '../services/candidateCreate.js';

export const candidatesRouter = Router();
candidatesRouter.use(authenticate);

const upload = multer({
  storage: multer.memoryStorage(),
  // Buffers live in process memory, so the ceiling is deliberately far below
  // anything a genuine resume needs; one file per request keeps a single upload
  // from fanning out into repeated parses.
  limits: { fileSize: RESUME_MAX_BYTES, files: 1 },
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

// List candidates (optionally by role)
//
// candidate:read is asked for here as it is on /api/interviews and the
// dashboard: names, addresses and resume text are candidate detail, and an
// auditor holds no capability to see them.
// A repeated `?roleId=a&roleId=b` arrives as an array; cast to string it
// reached Prisma as one and failed there as a 500.
const listQuerySchema = pagingQuerySchema.extend({ roleId: z.string().min(1).max(64).optional() });

// Paged, searched and counted on the server (services/candidateList.ts): the
// page used to load the caller's whole pipeline with nested detail and filter
// it in the browser. `roleId` is ANDed with the caller's scope, so it can only
// ever NARROW the result set, never enumerate another requisition's pipeline.
candidatesRouter.get('/', requireCapability('candidate:read'), asyncHandler(async (req, res) => {
  const query = listQuerySchema.parse(req.query);
  res.json(await listCandidates(req.auth!, query));
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

// Create a candidate under a role. The same service adds each person in a
// bulk import (routes/candidateImports.ts).
candidatesRouter.post('/', requireCapability('candidate:create'), asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);
  const outcome = await createApplication(req.auth!, body);
  if (outcome.kind === 'exists') {
    res.status(409).json({ error: 'This person is already a candidate for that role.', code: 'candidate_exists', candidateId: outcome.candidateId });
    return;
  }
  res.status(201).json({ candidate: shape(outcome.candidate) });
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
    rawText = await readResumeFile(req.file);
  } else if (typeof req.body.text === 'string') {
    // Pasted text bypasses the parsers but still lands in the same downstream
    // path, so it gets the same ceiling.
    rawText = req.body.text.slice(0, MAX_RESUME_TEXT_CHARS);
  }
  if (!rawText.trim()) throw new HttpError(400, 'No resume text found');

  const { profile, fit, profileVersionId } = await attachResume(req.auth!, candidate, {
    rawText, filename, contentType: req.file?.mimetype ?? 'text/plain',
  });

  res.status(201).json({ profile, fit, profileVersionId, filename });
}));


const candidateIdParams = z.object({ id: z.string().min(1) });
const MAX_ALTERNATIVE_ROLES_CONSIDERED = 50;
const MAX_ALTERNATIVE_ROLES_RETURNED = 5;

/**
 * The fit as the browser receives it.
 *
 * `excludedSignals` is stripped, as it always has been: the endpoint does not
 * echo protected-signal vocabulary back beside a named candidate. The panel
 * still shows the list — it reads it from `components/fit/fitVocabulary.ts`,
 * which a server test keeps identical to the engine's own, so the promise on
 * the screen cannot drift from what the engine refuses to read.
 */
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
      evidence: (c.evidence ?? []).slice(0, 4),
      evidenceDetail: (c.evidenceDetail ?? []).slice(0, 4),
      rule: c.rule,
      explanation: c.explanation,
    })),
  };
}

/**
 * What changed under a stored fit since it was written.
 *
 * A stored fit is the record of what HR was shown on the day. It is never
 * silently overwritten — the panel re-scores on read against the role as it is
 * NOW, and this says whether that differs from the stored reading and why. That
 * keeps the candidate comparison honest: it reads stored assessments and warns
 * when two candidates were measured against different scorecard versions, and a
 * fit that had been rewritten underneath it would make that warning a lie.
 */
function stalenessOf(stored: Partial<FitScore> | null, fresh: FitScore): { stale: boolean; reason: string } | null {
  if (!stored || typeof stored.overall !== 'number') return null;
  const reasons: string[] = [];
  if ((stored.engineVersion ?? 'fit-v1') !== fresh.engineVersion) {
    reasons.push('the fit engine has changed since this CV was scored');
  }
  if (stored.scorecardVersion != null && fresh.scorecardVersion != null && stored.scorecardVersion !== fresh.scorecardVersion) {
    reasons.push(`the role moved from scorecard v${stored.scorecardVersion} to v${fresh.scorecardVersion}`);
  }
  if (stored.techStackFingerprint !== undefined && stored.techStackFingerprint !== fresh.techStackFingerprint) {
    reasons.push("the role's technologies have changed");
  }
  if (reasons.length === 0) return null;
  return {
    stale: true,
    reason: `Re-scored just now because ${reasons.join(', and ')}. The stored reading (${Math.round(stored.overall)}) is kept as the record of what was shown at the time.`,
  };
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
      caveat: FIT_CAVEAT,
      rescored: null,
    });
    return;
  }

  const profile = parseJsonStrict<NormalizedProfile>(profileVersion.profileJson, { model: 'CandidateProfileVersion', id: profileVersion.id, field: 'profileJson' });
  const storedFit = parseJsonStrict<Partial<FitScore>>(profileVersion.fitScoreJson, { model: 'CandidateProfileVersion', id: profileVersion.id, field: 'fitScoreJson' });
  const currentStoredFit = publicFit(storedFit);
  // The same CV text the stored score was built from. Reading the parsed
  // profile back instead, as this used to, scored a DIFFERENT document from the
  // one on file: the panel and the stored number disagreed, and neither said so.
  const facts = storedCvFacts(profileVersion);

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
  const freshFit = currentScorecard
    ? scoreFit(
        facts,
        parseJsonStrict<RoleSuccessProfile>(currentScorecard.profileJson, { model: 'RoleScorecardVersion', id: currentScorecard.id, field: 'profileJson' }),
        currentRoleWithScorecard ? roleTechStack(currentRoleWithScorecard) : [],
        { scorecardVersion: currentScorecard.version },
      ).fit
    : null;
  const currentFit = freshFit ? publicFit(freshFit) : currentStoredFit;
  const rescored = freshFit ? stalenessOf(storedFit, freshFit) : null;
  const currentOverall: number | null = typeof currentFit?.overall === 'number' ? currentFit.overall : null;

  const alternatives = scopedRoles
    .filter((r) => r.id !== candidate.roleId && r.scorecards[0])
    .map((r) => {
      const fit = publicFit(scoreFit(facts, parseJsonStrict<RoleSuccessProfile>(r.scorecards[0].profileJson, { model: 'RoleScorecardVersion', id: r.scorecards[0].id, field: 'profileJson' }), roleTechStack(r), { scorecardVersion: r.scorecards[0].version }).fit)!;
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
    caveat: FIT_CAVEAT,
    rescored,
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
    const person = await eraseAllApplications({ tenantId: req.auth!.tenantId, candidateId: req.params.id, actorId: req.auth!.userId, reason, scope: await candidateScope(req.auth!) });
    res.json({ ...person, erasedCount: person.erasedIds.length, skippedCount: person.skipped.length, failedCount: person.failed.length });
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

function shape(c: any) { return { id: c.id, fullName: c.fullName, email: c.email, phone: c.phone, linkedinUrl: c.linkedinUrl ?? '', roleId: c.roleId, createdAt: c.createdAt }; }
