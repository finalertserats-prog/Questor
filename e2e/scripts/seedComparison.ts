// Seed one role with four assessed candidates, so the role page's comparison
// has something real to show. Usage:
//   DATABASE_URL=file:<abs>/data/questor.db npx tsx e2e/scripts/seedComparison.ts
//
// Development only: it writes candidates and assessments straight through
// Prisma. It never touches the demo tenant's existing rows beyond adding to them.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const COMPETENCIES = [
  { id: 'delivery', name: 'Delivery ownership', category: 'behavioral', required: 3 },
  { id: 'pipelines', name: 'Pipeline engineering', category: 'technical', required: 4 },
  { id: 'modelling', name: 'Data modelling', category: 'technical', required: 3 },
  { id: 'stakeholders', name: 'Stakeholder handling', category: 'communication', required: 3 },
  { id: 'incidents', name: 'Incident response', category: 'situational', required: 3 },
];

const PEOPLE = [
  { name: 'Ada Lovelace', levels: [5, 5, 4, 2, 4], score: 88, rec: 'PROCEED', minutes: 45 },
  { name: 'Grace Hopper', levels: [4, 4, 4, 4, 3], score: 81, rec: 'PROCEED', minutes: 45 },
  { name: 'Katherine Johnson', levels: [4, 3, null, 3, 2], score: 64, rec: 'CONSIDER', minutes: 45 },
  { name: 'Alan Turing', levels: [2, 3, 2, 1, null], score: 41, rec: 'DO_NOT_PROGRESS', minutes: 25 },
];

function profile() {
  return {
    roleContext: 'Builds and owns the analytics pipelines the business plans against.',
    seniority: 'senior',
    outcomes: ['Trustworthy warehouse data', 'Pipelines that recover without heroics'],
    responsibilities: ['Own batch and streaming pipelines', 'Partner with analytics and security'],
    redFlags: [],
    competencies: COMPETENCIES.map((c) => ({
      id: c.id, name: c.name, definition: `How well they ${c.name.toLowerCase()}.`, category: c.category,
      classification: 'essential', weight: 0.2, requiredLevel: c.required, targetLevel: Math.min(5, c.required + 1),
      indicators: [`Describes ${c.name.toLowerCase()} with a worked example`], evidenceModes: ['behavioral_example'],
    })),
    scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 70 },
    policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'in' },
  };
}

const QUOTES: Readonly<Record<string, string>> = {
  delivery: 'I owned the migration end to end and wrote the rollback plan before we started.',
  pipelines: 'We moved the nightly batch onto streaming and cut the lag from six hours to four minutes.',
  modelling: 'I rebuilt the fact table around the grain the finance team actually reports on.',
  stakeholders: 'I sat with the analysts for a week before I changed anything they depended on.',
  incidents: 'I led the incident, then wrote the postmortem and the two checks that would have caught it.',
};

function result(levels: readonly (number | null)[], score: number, rec: string) {
  return {
    assessmentVersion: 'v1', roleScorecardVersion: 'v1', recommendation: rec,
    confidence: 0.78, evidenceCoverage: 0.72, overallScore: score,
    competencies: COMPETENCIES.map((c, i) => ({
      id: c.id, name: c.name, level: levels[i], requiredLevel: c.required, confidence: 0.8,
      notEnoughEvidence: levels[i] === null,
      evidence: levels[i] === null ? [] : [{ turnId: `t-${c.id}`, quote: QUOTES[c.id], startMs: (i + 1) * 60_000, endMs: (i + 1) * 60_000 + 20_000 }],
      rationale: levels[i] === null ? 'The interview did not reach this.' : `Gave a worked example of ${c.name.toLowerCase()}.`,
      rubricVersion: 'v1',
    })),
    strengths: [], concerns: [], contradictions: [], openQuestions: [], limitations: [], summary: 'Assessed against the approved scorecard.',
  };
}

async function main() {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { name: 'Acme Corp' } });
  const user = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, role: 'admin' } });

  const title = 'Senior Analytics Engineer (comparison)';
  const existing = await prisma.role.findFirst({ where: { tenantId: tenant.id, title } });
  if (existing) {
    console.log(`Role already seeded: /roles/${existing.id}`);
    return;
  }

  const role = await prisma.role.create({
    data: {
      tenantId: tenant.id, title, level: 'Senior', location: 'Remote', employmentType: 'Full-time',
      sourceType: 'paste', sourceText: 'Seeded for the comparison screenshots.', status: 'approved', createdById: user.id,
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, userId: user.id, relation: 'owner' } });
  const scorecard = await prisma.roleScorecardVersion.create({
    data: { roleId: role.id, version: 2, status: 'approved', profileJson: JSON.stringify(profile()), approvedById: user.id, approvedAt: new Date() },
  });
  // One older version, so a candidate assessed against it is marked as not
  // strictly comparable rather than lined up silently beside the rest.
  const older = await prisma.roleScorecardVersion.create({
    data: { roleId: role.id, version: 1, status: 'approved', profileJson: JSON.stringify(profile()), approvedById: user.id, approvedAt: new Date() },
  });

  const stages = JSON.stringify([
    { key: 'participation', label: 'Participation', kind: 'intake' },
    { key: 'bronze', label: 'Bronze', kind: 'profile_review' },
    { key: 'silver', label: 'Silver', kind: 'ai_interview' },
    { key: 'gold', label: 'Gold', kind: 'human_interview' },
    { key: 'diamond', label: 'Diamond', kind: 'human_interview' },
  ]);

  for (const [index, person] of PEOPLE.entries()) {
    const email = `${person.name.split(' ')[0].toLowerCase()}.compare@example.com`;
    const candidate = await prisma.candidate.create({
      data: { tenantId: tenant.id, roleId: role.id, fullName: person.name, email, emailNormalized: email },
    });
    await prisma.candidateAssignment.create({ data: { candidateId: candidate.id, userId: user.id, relation: 'owner' } });
    await prisma.candidatePipeline.create({
      data: {
        tenantId: tenant.id, candidateId: candidate.id, roleId: role.id, stagesJson: stages,
        currentStageKey: ['gold', 'silver', 'silver', 'bronze'][index], createdById: user.id,
      },
    });
    // The last person was assessed on the older scorecard and in a shorter
    // interview: two things the comparison must mark rather than hide.
    const against = index === PEOPLE.length - 1 ? older : scorecard;
    const session = await prisma.interviewSession.create({
      data: {
        tenantId: tenant.id, candidateId: candidate.id, roleId: role.id, scorecardId: against.id,
        state: 'REVIEW_READY', durationMinutes: person.minutes, completedAt: new Date(Date.now() - index * 86_400_000),
      },
    });
    const assessment = await prisma.assessmentVersion.create({
      data: {
        sessionId: session.id, scorecardId: against.id, recommendation: person.rec,
        confidence: 0.78, evidenceCoverage: 0.72,
        resultJson: JSON.stringify(result(person.levels, person.score, person.rec)),
      },
    });
    // One candidate has been through a human review, so the grid can show a
    // row whose levels are the reviewer's rather than the AI's.
    if (index === 1) {
      await prisma.humanReview.create({
        data: {
          assessmentId: assessment.id, reviewerId: user.id, status: 'COMPLETED', disposition: 'PROCEED',
          activeForAssessmentId: assessment.id, completedAt: new Date(), reason: 'Re-read the transcript; stronger on modelling than the AI allowed.',
          overridesJson: JSON.stringify([{ competencyId: 'modelling', from: 4, to: 5, reason: 'Named the grain and why it changed.' }]),
        },
      });
    }
  }

  console.log(`Seeded comparison role: /roles/${role.id}`);
}

main().finally(() => prisma.$disconnect());
