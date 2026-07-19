import { Router } from 'express';
import { z } from 'zod';
import { prisma, parseJson } from '../db.js';
import { asyncHandler, authenticate, HttpError } from '../middleware/index.js';
import type { AssessmentResult } from '../domain/types.js';
import { renderReportMarkdown } from '../engines/reportWriter.js';
import { logAudit } from '../services/audit.js';
import { emitEvent } from '../services/webhooks.js';
import { getAts } from '../providers/ats/index.js';

export const assessmentsRouter = Router();
assessmentsRouter.use(authenticate);

async function getAssessment(tenantId: string, id: string) {
  const a = await prisma.assessmentVersion.findUnique({ where: { id }, include: { session: { include: { candidate: true, role: true } } } });
  if (!a || a.session.tenantId !== tenantId) throw new HttpError(404, 'Assessment not found');
  return a;
}

assessmentsRouter.get('/:id', asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!.tenantId, req.params.id);
  const reviews = await prisma.humanReview.findMany({ where: { assessmentId: a.id }, orderBy: { createdAt: 'desc' } });
  res.json({
    id: a.id,
    sessionId: a.sessionId,
    candidate: { id: a.session.candidateId, name: a.session.candidate.fullName },
    role: { id: a.session.roleId, title: a.session.role.title },
    result: parseJson<AssessmentResult>(a.resultJson, {} as AssessmentResult),
    reviews: reviews.map((r) => ({ id: r.id, status: r.status, disposition: r.disposition, reason: r.reason, overrides: parseJson(r.overridesJson, []), completedAt: r.completedAt })),
  });
}));

assessmentsRouter.get('/:id/report', asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!.tenantId, req.params.id);
  const result = parseJson<AssessmentResult>(a.resultJson, {} as AssessmentResult);
  const md = renderReportMarkdown({ candidateName: a.session.candidate.fullName, roleTitle: a.session.role.title, assessment: result });
  if (req.query.format === 'json') return res.json({ report: md, result });
  res.type('text/markdown').send(md);
}));

// Human review / override (FR-033)
const reviewSchema = z.object({
  disposition: z.enum(['PROCEED', 'CONSIDER', 'DO_NOT_PROGRESS']),
  reason: z.string().min(3),
  comments: z.string().optional(),
  overrides: z.array(z.object({ competencyId: z.string(), from: z.any(), to: z.any(), reason: z.string() })).default([]),
});
assessmentsRouter.post('/:id/review', asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!.tenantId, req.params.id);
  const body = reviewSchema.parse(req.body);
  const review = await prisma.humanReview.create({
    data: {
      assessmentId: a.id, reviewerId: req.auth!.userId, status: 'COMPLETED', disposition: body.disposition,
      reason: body.reason, comments: body.comments ?? '', overridesJson: JSON.stringify(body.overrides), completedAt: new Date(),
    },
  });
  // Session -> HUMAN_REVIEWED -> CLOSED
  if (a.session.state === 'REVIEW_READY') {
    await prisma.interviewSession.update({ where: { id: a.sessionId }, data: { state: 'HUMAN_REVIEWED' } });
  }
  await logAudit({
    tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'review.completed',
    entityType: 'AssessmentVersion', entityId: a.id,
    before: { recommendation: a.recommendation }, after: { disposition: body.disposition, reason: body.reason },
  });
  await emitEvent(req.auth!.tenantId, 'review.completed', { assessmentId: a.id, disposition: body.disposition });
  res.status(201).json({ review: { id: review.id, disposition: review.disposition } });
}));

// Export to ATS (FR-040)
assessmentsRouter.post('/:id/export', asyncHandler(async (req, res) => {
  const a = await getAssessment(req.auth!.tenantId, req.params.id);
  const result = parseJson<AssessmentResult>(a.resultJson, {} as AssessmentResult);
  const externalId = (req.body?.externalCandidateId as string) || a.session.candidateId;
  const out = await getAts().pushAssessment(externalId, {
    candidate: a.session.candidate.fullName, role: a.session.role.title,
    recommendation: result.recommendation, confidence: result.confidence, overallScore: result.overallScore,
    competencies: result.competencies.map((c) => ({ name: c.name, level: c.level })),
  });
  await logAudit({ tenantId: req.auth!.tenantId, actorId: req.auth!.userId, actorType: 'user', action: 'assessment.exported', entityType: 'AssessmentVersion', entityId: a.id, after: out });
  res.json(out);
}));
