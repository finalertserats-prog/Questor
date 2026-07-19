import path from 'node:path';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma, parseJson } from '../db.js';
import { asyncHandler, authenticate, requireRole, HttpError } from '../middleware/index.js';
import { eraseCandidate } from '../services/dataRights.js';
import { MAX_RESUME_TEXT_CHARS, extractResumeText, isResumeMimeType, normalizeProfile } from '../engines/resumeParser.js';
import { computeFitScore } from '../engines/fitScoring.js';
import type { RoleSuccessProfile } from '../domain/types.js';
import { logAudit } from '../services/audit.js';
import { emitEvent } from '../services/webhooks.js';

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
candidatesRouter.get('/', asyncHandler(async (req, res) => {
  const roleId = req.query.roleId as string | undefined;
  const candidates = await prisma.candidate.findMany({
    where: { tenantId: req.auth!.tenantId, ...(roleId ? { roleId } : {}) },
    orderBy: { createdAt: 'desc' },
    include: { profiles: { orderBy: { version: 'desc' }, take: 1 }, role: true, interviews: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  res.json({ candidates: candidates.map((c) => ({
    id: c.id, fullName: c.fullName, email: c.email, roleId: c.roleId, roleTitle: c.role?.title ?? null,
    fit: c.profiles[0] ? parseJson<any>(c.profiles[0].fitScoreJson, null) : null,
    latestInterview: c.interviews[0] ? { id: c.interviews[0].id, state: c.interviews[0].state } : null,
    createdAt: c.createdAt,
  })) });
}));

const createSchema = z.object({ fullName: z.string().min(1), email: z.string().email(), phone: z.string().optional(), roleId: z.string() });

// Create a candidate under a role
candidatesRouter.post('/', asyncHandler(async (req, res) => {
  const body = createSchema.parse(req.body);
  const role = await prisma.role.findFirst({ where: { id: body.roleId, tenantId: req.auth!.tenantId } });
  if (!role) throw new HttpError(404, 'Role not found');
  const candidate = await prisma.candidate.create({
    data: { tenantId: req.auth!.tenantId, roleId: body.roleId, fullName: body.fullName, email: body.email, phone: body.phone ?? '' },
  });
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'candidate.created', entityType: 'Candidate', entityId: candidate.id });
  res.status(201).json({ candidate: shape(candidate) });
}));

// Upload + parse resume, compute fit score, build evidence graph (FR-006..010)
candidatesRouter.post('/:id/resume', uploadResume, asyncHandler(async (req, res) => {
  const candidate = await getCandidate(req.auth!.tenantId, req.params.id);
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

  const profile = normalizeProfile(rawText);

  // Role scorecard (approved preferred, else latest)
  const scorecard = await prisma.roleScorecardVersion.findFirst({
    where: { roleId: candidate.roleId ?? '' }, orderBy: [{ status: 'desc' }, { version: 'desc' }],
  });
  const role = scorecard ? parseJson<RoleSuccessProfile>(scorecard.profileJson, emptyProfile()) : emptyProfile();
  const { fit, perCompetency } = computeFitScore(profile, rawText, role);

  const version = (await prisma.candidateProfileVersion.count({ where: { candidateId: candidate.id } })) + 1;
  const profileVersion = await prisma.candidateProfileVersion.create({
    data: { candidateId: candidate.id, version, rawText, profileJson: JSON.stringify(profile), fitScoreJson: JSON.stringify(fit) },
  });

  // Evidence graph nodes/edges
  for (const pc of perCompetency) {
    const compNode = await prisma.evidenceNode.create({ data: { profileId: profileVersion.id, kind: 'competency', label: pc.name, dataJson: JSON.stringify({ competencyId: pc.competencyId, strength: pc.strength }) } });
    for (const ev of pc.evidence) {
      const evNode = await prisma.evidenceNode.create({ data: { profileId: profileVersion.id, kind: 'evidence', label: ev.slice(0, 60), dataJson: JSON.stringify({ text: ev }) } });
      await prisma.evidenceEdge.create({ data: { fromId: evNode.id, toId: compNode.id, relation: pc.strength === 'missing' ? 'requires-validation' : 'supports', weight: 1 } });
    }
  }

  await prisma.artifact.create({ data: { tenantId: req.auth!.tenantId, candidateId: candidate.id, kind: 'resume', filename, contentType: req.file?.mimetype ?? 'text/plain', storageKey: rawText, sizeBytes: rawText.length, retentionDays: 180 } });
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'candidate.parsed', entityType: 'Candidate', entityId: candidate.id });
  await emitEvent(req.auth!.tenantId, 'candidate.parsed', { candidateId: candidate.id, fit: fit.overall });

  res.status(201).json({ profile, fit, profileVersionId: profileVersion.id, filename });
}));

// Get candidate detail (profile + fit + evidence)
candidatesRouter.get('/:id', asyncHandler(async (req, res) => {
  const candidate = await getCandidate(req.auth!.tenantId, req.params.id);
  const profileVersion = await prisma.candidateProfileVersion.findFirst({ where: { candidateId: candidate.id }, orderBy: { version: 'desc' }, include: { evidenceNodes: true } });
  const interviews = await prisma.interviewSession.findMany({ where: { candidateId: candidate.id }, orderBy: { createdAt: 'desc' } });
  res.json({
    candidate: shape(candidate),
    profile: profileVersion ? parseJson(profileVersion.profileJson, {}) : null,
    fit: profileVersion ? parseJson(profileVersion.fitScoreJson, null) : null,
    rawText: profileVersion?.rawText ?? '',
    interviews: interviews.map((i) => ({ id: i.id, state: i.state, scheduledAt: i.scheduledAt, createdAt: i.createdAt })),
  });
}));

// Right to erasure: GDPR Art. 17, India DPDP s.8, Illinois AIVIA s.20 (which
// requires deletion within 30 days of request, including copies). Admin-only
// and irreversible; the audit trail records that it happened.
candidatesRouter.delete('/:id', requireRole('admin'), asyncHandler(async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(1).max(500) }).parse(req.body ?? {});
  await getCandidate(req.auth!.tenantId, req.params.id);
  const result = await eraseCandidate({
    tenantId: req.auth!.tenantId,
    candidateId: req.params.id,
    actorId: req.auth!.userId,
    reason,
  });
  res.json({ erased: true, ...result });
}));

async function getCandidate(tenantId: string, id: string) {
  const c = await prisma.candidate.findFirst({ where: { id, tenantId } });
  if (!c) throw new HttpError(404, 'Candidate not found');
  return c;
}
function shape(c: any) { return { id: c.id, fullName: c.fullName, email: c.email, phone: c.phone, roleId: c.roleId, createdAt: c.createdAt }; }
function emptyProfile(): RoleSuccessProfile {
  return { roleContext: '', outcomes: [], responsibilities: [], competencies: [], scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 65 }, policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' }, redFlags: [], seniority: '' };
}
