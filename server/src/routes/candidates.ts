import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma, parseJson } from '../db.js';
import { asyncHandler, authenticate, HttpError } from '../middleware/index.js';
import { extractResumeText, normalizeProfile } from '../engines/resumeParser.js';
import { computeFitScore } from '../engines/fitScoring.js';
import type { RoleSuccessProfile } from '../domain/types.js';
import { logAudit } from '../services/audit.js';
import { emitEvent } from '../services/webhooks.js';

export const candidatesRouter = Router();
candidatesRouter.use(authenticate);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

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
candidatesRouter.post('/:id/resume', upload.single('file'), asyncHandler(async (req, res) => {
  const candidate = await getCandidate(req.auth!.tenantId, req.params.id);
  let rawText = '';
  let filename = 'pasted.txt';
  if (req.file) {
    filename = req.file.originalname;
    try {
      rawText = await extractResumeText(req.file.buffer, req.file.originalname, req.file.mimetype);
    } catch {
      throw new HttpError(422, 'Could not read the uploaded file. Please upload a text-based PDF, DOCX, or paste the resume text.');
    }
  } else if (typeof req.body.text === 'string') {
    rawText = req.body.text;
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

async function getCandidate(tenantId: string, id: string) {
  const c = await prisma.candidate.findFirst({ where: { id, tenantId } });
  if (!c) throw new HttpError(404, 'Candidate not found');
  return c;
}
function shape(c: any) { return { id: c.id, fullName: c.fullName, email: c.email, phone: c.phone, roleId: c.roleId, createdAt: c.createdAt }; }
function emptyProfile(): RoleSuccessProfile {
  return { roleContext: '', outcomes: [], responsibilities: [], competencies: [], scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 65 }, policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' }, redFlags: [], seniority: '' };
}
