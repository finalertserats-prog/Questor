// Seed enough interviews for the Analytics tab's outcome statistics to have
// something real to show — including cuts small enough that the page has to
// mark them as too few to read, which is the thing worth looking at. Usage:
//   DATABASE_URL=file:<abs>/data/questor.db npx tsx e2e/scripts/seedOutcomes.ts
//
// Development only: it writes candidates, sessions, turns, assessments and
// reviews straight through Prisma, into the demo tenant it finds.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const INTERVIEWERS = ['avery', 'maya', 'adrian', 'elena', 'theo'];
const COMPETENCIES = [
  { id: 'sql', name: 'SQL and data modelling' },
  { id: 'pipelines', name: 'Pipeline design' },
  { id: 'stakeholders', name: 'Stakeholder management' },
  { id: 'ownership', name: 'Ownership' },
];
const DAY = 86_400_000;
/** Enough that the whole-period rates are readable and the per-cut ones are not. */
const COUNT = 96;

function pick<T>(list: readonly T[], i: number): T {
  return list[i % list.length];
}

async function main() {
  const now = new Date();
  const tenant = await prisma.tenant.findFirstOrThrow({ orderBy: { createdAt: 'asc' }, select: { id: true } });
  const reviewer = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id }, select: { id: true } });
  const roles = await prisma.role.findMany({
    where: { tenantId: tenant.id },
    select: { id: true, scorecards: { select: { id: true }, orderBy: { version: 'desc' }, take: 1 } },
    take: 3,
  });
  if (roles.length === 0) throw new Error('Seed the demo data first: there is no role to attach interviews to.');

  for (let i = 0; i < COUNT; i += 1) {
    const role = pick(roles, i);
    const scorecardId = role.scorecards[0]?.id;
    if (!scorecardId) continue;

    // Spread over five months so the monthly cut has a shape, and vary the
    // drop-offs so the funnel is not a straight line.
    const createdAt = new Date(now.getTime() - (i % 5) * 30 * DAY - (i % 7) * DAY);
    const started = i % 9 !== 0;
    const completed = started && i % 11 !== 0;
    const assessed = completed && i % 13 !== 0;
    const reviewed = assessed && i % 4 !== 0;
    const score = 45 + ((i * 7) % 50);

    const candidate = await prisma.candidate.create({
      data: {
        tenantId: tenant.id, roleId: role.id, fullName: `Outcome Candidate ${i + 1}`,
        email: `outcome${i + 1}@example.test`, emailNormalized: `outcome${i + 1}@example.test`, createdAt,
      },
    });
    const session = await prisma.interviewSession.create({
      data: {
        tenantId: tenant.id, roleId: role.id, scorecardId, candidateId: candidate.id,
        state: completed ? 'HUMAN_REVIEWED' : started ? 'INCOMPLETE' : 'ACCEPTED',
        personaJson: JSON.stringify({ interviewerId: pick(INTERVIEWERS, i) }),
        startedAt: started ? createdAt : null,
        completedAt: completed ? new Date(createdAt.getTime() + (26 + (i % 20)) * 60_000) : null,
        createdAt,
      },
    });
    // No invitation token is minted: the funnel only asks whether one exists.
    await prisma.invitation.create({ data: { sessionId: session.id, sentAt: createdAt } });

    for (let t = 0; t < 8; t += 1) {
      await prisma.turn.create({
        data: {
          sessionId: session.id, index: t, speaker: t % 2 === 0 ? 'agent' : 'candidate',
          text: t % 2 === 0
            ? 'Tell me about a pipeline you owned end to end.'
            // Every ninth candidate turn says nothing, so the non-answer rate is not zero.
            : (i + t) % 9 === 0 ? 'no' : 'I rebuilt the ingestion layer and cut the nightly run to forty minutes.',
          metaJson: t % 2 === 0 && i % 17 === 0 ? JSON.stringify({ serving: { layer: 'local', degraded: true } }) : '{}',
        },
      });
    }

    if (!assessed) continue;
    const assessment = await prisma.assessmentVersion.create({
      data: {
        sessionId: session.id, scorecardId,
        recommendation: score >= 75 ? 'PROCEED' : score >= 60 ? 'CONSIDER' : 'DO_NOT_PROGRESS',
        confidence: 0.7, evidenceCoverage: 0.55 + (i % 40) / 100,
        resultJson: JSON.stringify({
          overallScore: score,
          competencies: COMPETENCIES.map((c, n) => ({ ...c, level: 1 + ((i + n) % 5), notEnoughEvidence: false })),
        }),
        createdAt,
      },
    });

    if (!reviewed) continue;
    // Deliberately a slightly different threshold from the AI's, so reviewers
    // and the model disagree on some of them.
    const disposition = score >= 78 ? 'PROCEED' : score >= 58 ? 'CONSIDER' : 'DO_NOT_PROGRESS';
    const review = await prisma.humanReview.create({
      data: {
        assessmentId: assessment.id, reviewerId: reviewer.id, status: 'COMPLETED', disposition,
        activeForAssessmentId: assessment.id, completedAt: createdAt, reason: 'Read the transcript.',
        overridesJson: JSON.stringify([{ competencyId: 'sql', from: 3, to: 4, reason: 'Evidence was stronger than scored.' }]),
      },
    });
    await prisma.reviewDifference.create({
      data: {
        tenantId: tenant.id, assessmentId: assessment.id, reviewId: review.id, reviewerId: reviewer.id,
        aiRecommendation: assessment.recommendation, humanDisposition: disposition,
        agreed: assessment.recommendation === disposition,
        changedCount: 1, competencyCount: COMPETENCIES.length,
        competenciesJson: JSON.stringify(COMPETENCIES.map((c, n) => ({
          competencyId: c.id, competencyName: c.name,
          aiLevel: 1 + ((i + n) % 5), humanLevel: 1 + ((i + n + (n === 0 ? 1 : 0)) % 5), changed: n === 0,
        }))),
        createdAt,
      },
    });

    if (disposition !== 'PROCEED') continue;
    await prisma.candidatePipeline.create({
      data: {
        tenantId: tenant.id, roleId: role.id, candidateId: candidate.id, stagesJson: '',
        currentStageKey: 'diamond', status: i % 3 === 0 ? 'DECIDED' : 'ACTIVE',
        ...(i % 3 === 0 ? { decision: 'APPROVED', decidedAt: createdAt } : {}),
      },
    });
  }

  console.log(`Seeded ${COUNT} interviews for outcome statistics: /admin/analytics`);
}

main().finally(() => prisma.$disconnect());
