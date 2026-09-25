import { prisma, parseJsonOptional } from '../db.js';

/**
 * Which of a role's competencies an interview has already touched.
 *
 * Nothing enforces a foreign key from a turn, a plan block or an assessment
 * score to a competency: they carry the id inside JSON or a plain column. So
 * whether a competency may be deleted outright, or must be retired and kept
 * for the record, is answered by looking in all three places.
 */
export async function competencyIdsWithHistory(roleId: string): Promise<Set<string>> {
  const sessions = await prisma.interviewSession.findMany({ where: { roleId }, select: { id: true } });
  if (sessions.length === 0) return new Set();
  const sessionIds = sessions.map((s) => s.id);

  const [turns, plans, assessments] = await Promise.all([
    prisma.turn.findMany({
      where: { sessionId: { in: sessionIds }, competencyId: { not: '' } },
      distinct: ['competencyId'],
      select: { competencyId: true },
    }),
    prisma.interviewPlanVersion.findMany({ where: { sessionId: { in: sessionIds } }, select: { id: true, planJson: true } }),
    prisma.assessmentVersion.findMany({ where: { sessionId: { in: sessionIds } }, select: { id: true, resultJson: true } }),
  ]);

  const ids = new Set<string>();
  for (const t of turns) ids.add(t.competencyId);
  for (const p of plans) {
    const plan = parseJsonOptional<{ blocks?: Array<{ competencyId?: string }> }>(p.planJson, {}, { model: 'InterviewPlanVersion', id: p.id, field: 'planJson' });
    for (const block of plan.blocks ?? []) if (block.competencyId) ids.add(block.competencyId);
  }
  for (const a of assessments) {
    const result = parseJsonOptional<{ competencies?: Array<{ id?: string }> }>(a.resultJson, {}, { model: 'AssessmentVersion', id: a.id, field: 'resultJson' });
    for (const c of result.competencies ?? []) if (c.id) ids.add(c.id);
  }
  // The plan's own blocks (process, warmup, close) are not competencies.
  for (const id of [...ids]) if (id.startsWith('__')) ids.delete(id);
  return ids;
}
