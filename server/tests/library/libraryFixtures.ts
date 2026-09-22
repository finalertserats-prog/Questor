import { prisma } from '../../src/db.js';
import { config } from '../../src/config.js';
import { slugifyCatalogName } from '../../src/domain/catalogText.js';
import { signToken } from '../../src/services/auth.js';
import { _resetRateLimits } from '../../src/middleware/rateLimit.js';
import { _resetLifecycleCacheForTest } from '../../src/library/lifecycle.js';
import { GENERATOR_PROMPT_VERSION } from '../../src/library/generator.js';
import { stratumKeyOf } from '../../src/library/types.js';

/**
 * A world for the library tests: the platform owner, an ordinary organisation
 * admin, a catalog role in a family, and a tenant role with an approved
 * scorecard of two competencies at the "established" band.
 */

export const OPERATOR_EMAIL = 'owner@questor.test';
export const ROLE_TITLE = 'Payments Platform Engineer';
export const FAMILY_NAME = 'Engineering / Technical Delivery';
export const BAND = 'established';
export const COMPETENCIES = [
  { id: 'c1', name: 'Incident Ownership', definition: 'Runs production incidents on payment systems end to end.', indicators: ['Leads the incident call for a failed settlement run', 'Writes the postmortem within a day'] },
  { id: 'c2', name: 'Data Modelling', definition: 'Designs ledger and reconciliation schemas.', indicators: ['Models double-entry ledgers', 'Designs idempotent reconciliation jobs'] },
] as const;

export interface LibraryWorld {
  readonly operator: { readonly id: string; readonly tenantId: string; readonly token: string };
  readonly admin: { readonly id: string; readonly tenantId: string; readonly token: string };
  readonly demo: { readonly id: string; readonly tenantId: string; readonly token: string };
  readonly roleId: string;
  readonly roleSlug: string;
  readonly familySlug: string;
  readonly competencyKeys: readonly string[];
}

async function user(email: string, isDemo = false) {
  const tenant = await prisma.tenant.create({ data: { name: `${email} org`, isDemo } });
  const row = await prisma.user.create({ data: { tenantId: tenant.id, email, name: email, passwordHash: 'x', role: 'admin' } });
  return { id: row.id, tenantId: tenant.id, token: signToken({ userId: row.id, tenantId: tenant.id, role: 'admin', email }) };
}

function profileJson(): string {
  return JSON.stringify({
    roleContext: 'Payments platform',
    outcomes: [], responsibilities: [],
    competencies: COMPETENCIES.map((c) => ({ ...c, category: 'technical', classification: 'essential', weight: 0.5, requiredLevel: 3, targetLevel: 4, indicators: [...c.indicators], evidenceModes: [] })),
    scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 65 },
    policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: '' },
    redFlags: [], seniority: 'senior',
  });
}

export async function seedLibraryWorld(): Promise<LibraryWorld> {
  _resetRateLimits();
  _resetLifecycleCacheForTest();
  await prisma.rateLimitBucket.deleteMany();
  await prisma.libraryReview.deleteMany();
  await prisma.libraryUsage.deleteMany();
  await prisma.libraryEntry.deleteMany();
  await prisma.libraryStandard.deleteMany();
  await prisma.libraryPoolTarget.deleteMany();
  await prisma.libraryStratum.deleteMany();
  await prisma.libraryBudget.deleteMany();
  await prisma.libraryWorkerState.deleteMany();
  await prisma.jobLease.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.interviewSession.deleteMany();
  await prisma.roleScorecardVersion.deleteMany();
  await prisma.role.deleteMany();
  await prisma.user.deleteMany({ where: { email: { endsWith: '@questor.test' } } });
  config.platformOperatorEmails = [OPERATOR_EMAIL];
  const operator = await user(OPERATOR_EMAIL);
  const admin = await user(`admin-${Date.now()}@questor.test`);
  const demo = await user(`demo-${Date.now()}@questor.test`, true);

  const domain = await prisma.catalogDomain.upsert({ where: { slug: 'lib-test-domain' }, create: { slug: 'lib-test-domain', name: 'Library Test Domain', sortOrder: 99 }, update: {} });
  const family = await prisma.catalogJobFamily.upsert({ where: { name: FAMILY_NAME }, create: { name: FAMILY_NAME, sortOrder: 99 }, update: {} });
  const catalogRole = await prisma.catalogRole.upsert({
    where: { domainId_normalizedTitle: { domainId: domain.id, normalizedTitle: ROLE_TITLE.toLowerCase() } },
    create: { domainId: domain.id, familyId: family.id, title: ROLE_TITLE, normalizedTitle: ROLE_TITLE.toLowerCase(), source: 'seed' },
    // Reset every field a test may change: the row survives between tests in a file.
    update: { familyId: family.id, status: 'active', createdByTenantId: null, source: 'seed' },
  });
  const role = await prisma.role.create({
    data: {
      tenantId: admin.tenantId, catalogRoleId: catalogRole.id, experienceBand: BAND, title: ROLE_TITLE, status: 'approved',
      sourceText: 'We run card and bank-transfer payments for marketplaces; the team owns settlement, ledgers and reconciliation.',
      scorecards: { create: { version: 1, status: 'approved', profileJson: profileJson() } },
    },
  });
  return {
    operator, admin, demo, roleId: role.id,
    roleSlug: slugifyCatalogName(ROLE_TITLE), familySlug: slugifyCatalogName(FAMILY_NAME),
    competencyKeys: COMPETENCIES.map((c) => slugifyCatalogName(c.name)),
  };
}

export interface EntrySeed {
  readonly competencyKey?: string;
  readonly status?: string;
  readonly form?: string;
  readonly difficultyTag?: number;
  readonly questionText?: string;
  readonly scope?: 'global' | 'org';
  readonly tenantId?: string | null;
  readonly gateOutcome?: string;
  readonly supersedesId?: string | null;
  readonly createdAt?: Date;
  readonly band?: string;
}

let seq = 0;

export async function entry(world: LibraryWorld, seed: EntrySeed = {}) {
  seq += 1;
  const form = seed.form ?? 'star';
  const band = seed.band ?? BAND;
  return prisma.libraryEntry.create({
    data: {
      scope: seed.scope ?? 'global', tenantId: seed.tenantId ?? null,
      roleSlug: world.roleSlug, familySlug: world.familySlug, competencyKey: seed.competencyKey ?? world.competencyKeys[0], band,
      form, questionText: seed.questionText ?? `Seeded ${form} question ${seq} for the ${ROLE_TITLE} about settlement runs?`,
      bodyJson: JSON.stringify({ anchors: ['Names the failure mode', 'Says what changed after'] }),
      status: seed.status ?? 'live', gateOutcome: seed.gateOutcome ?? (seed.status === 'draft' ? 'unsure' : 'pass'),
      stratumKey: stratumKeyOf({ scope: seed.scope ?? 'global', roleSlug: world.roleSlug, band, form, generatorPromptVersion: GENERATOR_PROMPT_VERSION }),
      difficultyTag: seed.difficultyTag ?? ((seq % 3) + 1), supersedesId: seed.supersedesId ?? null,
      generatorPromptVersion: GENERATOR_PROMPT_VERSION, generatorModel: 'seed', criticModel: 'seed',
      criticVerdictJson: JSON.stringify({ realQuestion: true, rightBand: true, answerable: true, formCorrect: true, anchorsLeaked: false, roleSpecific: true, confidence: 0.9, notes: '' }),
      ...(seed.createdAt ? { createdAt: seed.createdAt } : {}),
    },
  });
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}
