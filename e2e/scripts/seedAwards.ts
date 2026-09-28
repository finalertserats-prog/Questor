// Seed one candidate who has earned Bronze and Silver and is sitting at Gold,
// so the credential viewer has real badges and certificates to open. Usage:
//   DATABASE_URL=file:<abs>/data/questor.db npx tsx e2e/scripts/seedAwards.ts [run-id]
//
// Development only: it writes straight through Prisma and never touches the
// demo tenant's existing rows beyond adding to them. The awards carry
// evidence written by the award lane's own serialiser — never JSON typed out
// here — so what the viewer shows is what a real strike would have stored.
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { formatReference, referenceBlocks, serialiseEvidence, type AwardFacts, type AwardTier } from '../../server/src/domain/candidateAwards.js';

const prisma = new PrismaClient();

const STAGES = JSON.stringify([
  { key: 'participation', label: 'Participation', kind: 'intake' },
  { key: 'bronze', label: 'Bronze', kind: 'profile_review' },
  { key: 'silver', label: 'Silver', kind: 'ai_interview' },
  { key: 'gold', label: 'Gold', kind: 'human_interview' },
  { key: 'diamond', label: 'Diamond', kind: 'human_interview' },
]);

function facts(candidateName: string, roleTitle: string, recordedByName: string): AwardFacts {
  return {
    awardedAt: new Date('2026-09-24T09:00:00.000Z'),
    candidateName,
    roleTitle,
    recordedByName,
    candidateCreatedAt: new Date('2026-09-20T09:00:00.000Z'),
    profile: { readAt: new Date('2026-09-21T09:00:00.000Z'), scorecardVersion: 2, competenciesEvidenced: 4, competenciesTotal: 5 },
    aiInterview: { completedAt: new Date('2026-09-22T09:00:00.000Z'), minutes: 24, competencies: 5, quotedEvidence: true },
    humanReview: { at: new Date('2026-09-23T09:00:00.000Z'), reviewerName: 'Aparna Rao' },
    humanRounds: [],
    priorAwardAt: new Date('2026-09-21T09:00:00.000Z'),
    promotedTo: 'Gold',
    promotedByName: recordedByName,
  };
}

async function main() {
  const runId = process.argv[2] ?? `${Date.now()}`;
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { name: 'Acme Corp' } });
  const user = await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id, role: 'admin' } });

  const title = `Credentials Engineer (${runId})`;
  const role = await prisma.role.create({
    data: {
      tenantId: tenant.id, title, level: 'Senior', location: 'Remote', employmentType: 'Full-time',
      sourceType: 'paste', sourceText: 'Seeded for the credential viewer.', status: 'approved', createdById: user.id,
    },
  });
  await prisma.roleAssignment.create({ data: { roleId: role.id, userId: user.id, relation: 'owner' } });

  const name = `Award Holder ${runId}`;
  const email = `award-holder-${runId}@example.test`;
  const candidate = await prisma.candidate.create({
    data: { tenantId: tenant.id, roleId: role.id, fullName: name, email, emailNormalized: email },
  });
  await prisma.candidateAssignment.create({ data: { candidateId: candidate.id, userId: user.id, relation: 'owner' } });
  await prisma.candidatePipeline.create({
    data: { tenantId: tenant.id, candidateId: candidate.id, roleId: role.id, stagesJson: STAGES, currentStageKey: 'gold', createdById: user.id },
  });

  const struck = facts(name, title, user.name);
  for (const tier of ['bronze', 'silver'] as const satisfies readonly AwardTier[]) {
    const { block, digits } = referenceBlocks();
    await prisma.candidateAward.create({
      data: {
        tenantId: tenant.id, candidateId: candidate.id, roleId: role.id, tier,
        awardedAt: struck.awardedAt, awardedByUserId: tier === 'bronze' ? null : user.id,
        reference: formatReference(tier, block, digits),
        verifyToken: randomBytes(32).toString('base64url'),
        evidenceJson: serialiseEvidence(tier, struck),
      },
    });
  }

  console.log(`Seeded award holder: /candidates/${candidate.id}`);
}

main().finally(() => prisma.$disconnect());
