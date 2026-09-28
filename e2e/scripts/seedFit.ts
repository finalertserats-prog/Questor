// Seed one candidate whose CV has been read against a real role, and whose
// interview then agreed with some of it and not the rest — so both fit panels
// have something honest to show. Usage:
//   DATABASE_URL=file:<abs>/data/questor.db npx tsx e2e/scripts/seedFit.ts
//
// Development only: it writes straight through Prisma and never touches the
// demo tenant's existing rows beyond adding to them.
import { PrismaClient } from '@prisma/client';
import { extractCvFacts } from '../../server/src/engines/cvFacts.js';
import { scoreFit } from '../../server/src/engines/fitScoring.js';
import { normalizeProfile } from '../../server/src/engines/resumeParser.js';
import type { RoleSuccessProfile } from '../../server/src/domain/types.js';
import type { TechStackItem } from '../../server/src/domain/techStack.js';

const prisma = new PrismaClient();

const COMPETENCIES = [
  { id: 'fit-pipelines', name: 'Pipeline Engineering', category: 'technical', classification: 'essential', weight: 0.3, required: 4, definition: 'Builds and operates batch and streaming ingestion that runs unattended.', indicators: ['Runs ingestion unattended', 'Handles backfill and replay', 'Owns pipeline alerting'] },
  { id: 'fit-modelling', name: 'Dimensional Modelling', category: 'domain', classification: 'essential', weight: 0.25, required: 3, definition: 'Designs warehouse schemas analysts can query without help.', indicators: ['Designs star schemas', 'Chooses grain deliberately', 'Documents lineage'] },
  { id: 'fit-stakeholder', name: 'Stakeholder Communication', category: 'communication', classification: 'essential', weight: 0.2, required: 3, definition: 'Explains technical trade-offs to people who do not write code.', indicators: ['Presents options to non-technical owners', 'Negotiates scope'] },
  { id: 'fit-mentoring', name: 'Mentoring', category: 'behavioral', classification: 'preferred', weight: 0.15, required: 3, definition: 'Grows engineers less experienced than themselves.', indicators: ['Reviews code as teaching', 'Pairs deliberately'] },
  { id: 'fit-cost', name: 'Cost Optimisation', category: 'domain', classification: 'preferred', weight: 0.1, required: 3, definition: 'Keeps cloud spend proportionate to the value of the work.', indicators: ['Measures spend per pipeline', 'Removes waste'] },
] as const;

const STACK: TechStackItem[] = [
  { name: 'Kafka', category: 'data', level: 'strong', required: true },
  { name: 'Airflow', category: 'data', level: 'working', required: true },
  { name: 'Snowflake', category: 'data', level: 'working', required: true },
  { name: 'Terraform', category: 'tooling', level: 'familiar', required: false },
];

/** A real CV: strong on the pipeline work, silent on stakeholder handling. */
const CV = `Priya Raman
priya.raman@example.com | +91 98765 43210
Date of Birth: 12 March 1988

Summary
Data engineer who keeps nightly warehouse loads boring.

Experience

Senior Data Engineer, Northwind Analytics (2021 - Present)
- Owned the streaming ingestion in Kafka, moving 40m events/day into Snowflake with replay and backfill handled without a human.
- Redesigned the warehouse into a star schema with a deliberate grain, so analysts stopped raising tickets to ask what a row meant.
- Rebuilt the nightly orchestration in Airflow and cut the failed-run rate from weekly to twice a year.
- Reduced warehouse cost by 38% by measuring spend per pipeline and removing three duplicated loads.
- Mentored a team of 4 junior engineers, pairing weekly and reviewing their code as teaching rather than gatekeeping.

Data Engineer, Kestrel Retail (2017 - 2021)
- Built batch ingestion in Airflow feeding a Snowflake warehouse used by the merchandising team.
- Modelled the sales fact table and documented its lineage.

Skills
Kafka, Airflow, Snowflake, Python, SQL, dbt, Terraform

Education
B.Tech Computer Science, Indian Institute of Technology Madras, 2013
`;

function profile(): RoleSuccessProfile {
  return {
    roleContext: 'Senior data engineer owning the nightly warehouse load.',
    seniority: 'senior',
    outcomes: [
      'Deliver reliable nightly pipelines the business can plan against',
      'Reduce warehouse cost without losing freshness',
      'Give analysts datasets they trust without asking questions first',
    ],
    responsibilities: ['Own the streaming ingestion', 'Model the warehouse', 'Mentor two junior engineers'],
    redFlags: [],
    competencies: COMPETENCIES.map((c) => ({
      id: c.id, name: c.name, definition: c.definition, category: c.category, classification: c.classification,
      weight: c.weight, requiredLevel: c.required, targetLevel: Math.min(5, c.required + 1),
      indicators: [...c.indicators], evidenceModes: ['behavioral_example'],
    })) as never,
    scoringRules: { mustPassCompetencyIds: ['fit-pipelines'], notEnoughEvidencePolicy: 'exclude', passThreshold: 70 },
    policyRules: { prohibitedTopics: ['age', 'nationality'], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'in' },
  };
}

/**
 * The interview, deliberately disagreeing with the CV in both directions: it
 * did not reach the modelling the CV leads with, and it found the stakeholder
 * work the CV never mentions. That pair is the whole point of the comparison.
 */
const GRADED: Array<{ id: string; level: number | null; quote: string; rationale: string }> = [
  { id: 'fit-pipelines', level: 5, quote: 'I rebuilt the Kafka consumer so a replay could not double-write, and we backfilled two years without taking the warehouse down.', rationale: 'Worked example with the failure mode named.' },
  { id: 'fit-modelling', level: 2, quote: 'Honestly I mostly follow whatever schema is already there and add columns when someone asks.', rationale: 'Could not describe choosing a grain.' },
  { id: 'fit-stakeholder', level: 4, quote: 'I ran the monthly data review with the commercial team for two years, and I wrote up every decision we took in it.', rationale: 'Sustained ownership of a non-technical audience.' },
  { id: 'fit-mentoring', level: null, quote: '', rationale: 'The interview did not reach this.' },
  { id: 'fit-cost', level: 4, quote: 'We tagged every pipeline so we could see spend per load, then deleted the three nobody read.', rationale: 'Measured, then acted.' },
];

async function main() {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { name: 'Acme Corp' } });
  const user = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, role: 'admin' } });

  const title = 'Senior Data Engineer (fit)';
  const existing = await prisma.role.findFirst({ where: { tenantId: tenant.id, title }, include: { candidates: true } });
  if (existing) {
    console.log(`CANDIDATE_ID=${existing.candidates[0]?.id ?? ''}`);
    return;
  }

  const role = await prisma.role.create({
    data: {
      tenantId: tenant.id, title, level: 'Senior', location: 'Remote', employmentType: 'Full-time',
      sourceType: 'paste', sourceText: 'Seeded for the fit screenshots.', status: 'approved',
      createdById: user.id, techStackJson: JSON.stringify(STACK),
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, userId: user.id, relation: 'owner' } });
  const scorecard = await prisma.roleScorecardVersion.create({
    data: { roleId: role.id, version: 2, status: 'approved', profileJson: JSON.stringify(profile()), approvedById: user.id, approvedAt: new Date() },
  });

  const email = 'priya.fit@example.com';
  const candidate = await prisma.candidate.create({
    data: { tenantId: tenant.id, roleId: role.id, fullName: 'Priya Raman', email, emailNormalized: email },
  });
  await prisma.candidateAssignment.create({ data: { candidateId: candidate.id, userId: user.id, relation: 'owner' } });

  const facts = extractCvFacts(CV);
  const { fit } = scoreFit(facts, profile(), STACK, { scorecardVersion: scorecard.version });
  const version = await prisma.candidateProfileVersion.create({
    data: {
      candidateId: candidate.id, version: 1, rawText: CV,
      profileJson: JSON.stringify(normalizeProfile(CV)),
      fitScoreJson: JSON.stringify(fit),
      cvFactsJson: JSON.stringify(facts),
    },
  });

  for (const read of fit.competencies ?? []) {
    const node = await prisma.evidenceNode.create({
      data: { profileId: version.id, kind: 'competency', label: read.name, dataJson: JSON.stringify({ competencyId: read.competencyId, strength: read.strength }) },
    });
    for (const e of read.evidence) {
      const evidence = await prisma.evidenceNode.create({
        data: { profileId: version.id, kind: 'evidence', label: e.quote.slice(0, 60), dataJson: JSON.stringify({ text: e.quote, line: e.line, section: e.section }) },
      });
      await prisma.evidenceEdge.create({ data: { fromId: evidence.id, toId: node.id, relation: 'supports', weight: 1 } });
    }
  }

  const session = await prisma.interviewSession.create({
    data: {
      tenantId: tenant.id, candidateId: candidate.id, roleId: role.id, scorecardId: scorecard.id,
      state: 'REVIEW_READY', durationMinutes: 45, completedAt: new Date(),
    },
  });
  await prisma.assessmentVersion.create({
    data: {
      sessionId: session.id, scorecardId: scorecard.id, recommendation: 'CONSIDER', confidence: 0.76, evidenceCoverage: 0.8,
      resultJson: JSON.stringify({
        assessmentVersion: 'v1', roleScorecardVersion: 'v2', recommendation: 'CONSIDER',
        confidence: 0.76, evidenceCoverage: 0.8, overallScore: 72,
        competencies: GRADED.map((g, i) => {
          const c = COMPETENCIES.find((x) => x.id === g.id)!;
          return {
            id: g.id, name: c.name, level: g.level, requiredLevel: c.required, confidence: 0.8,
            notEnoughEvidence: g.level === null,
            evidence: g.quote ? [{ turnId: `t-${g.id}`, quote: g.quote, startMs: (i + 1) * 60_000, endMs: (i + 1) * 60_000 + 20_000 }] : [],
            rationale: g.rationale, rubricVersion: 'v1',
          };
        }),
        strengths: [], concerns: [], contradictions: [], openQuestions: [], limitations: [],
        summary: 'Assessed against the approved scorecard.',
      }),
    },
  });

  console.log(`CANDIDATE_ID=${candidate.id}`);
}

main().finally(() => prisma.$disconnect());
