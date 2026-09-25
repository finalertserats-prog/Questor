import { prisma } from '../src/db.js';
import { config } from '../src/config.js';
import { normalizeTitle } from '../src/domain/catalogText.js';
import { signToken } from '../src/services/auth.js';
import { _resetRateLimits } from '../src/middleware/rateLimit.js';
import { seedSmallCatalog, type SeededCatalog } from './catalogRefreshFixtures.js';

/** A platform owner, an ordinary admin, and proposals to review. */

export const OPERATOR_EMAIL = 'owner@questor.test';

export interface ReviewWorld {
  readonly catalog: SeededCatalog;
  readonly runId: string;
  readonly operator: { readonly id: string; readonly tenantId: string; readonly token: string };
  readonly admin: { readonly id: string; readonly token: string };
}

async function user(email: string) {
  const tenant = await prisma.tenant.create({ data: { name: `${email} org` } });
  const row = await prisma.user.create({ data: { tenantId: tenant.id, email, name: email, passwordHash: 'x', role: 'admin' } });
  return { id: row.id, tenantId: tenant.id, token: signToken({ userId: row.id, tenantId: tenant.id, role: 'admin', email }) };
}

export async function seedReviewWorld(): Promise<ReviewWorld> {
  _resetRateLimits();
  await prisma.rateLimitBucket.deleteMany();
  const catalog = await seedSmallCatalog();
  await prisma.auditEvent.deleteMany();
  await prisma.user.deleteMany({ where: { email: { endsWith: '@questor.test' } } });
  config.platformOperatorEmails = [OPERATOR_EMAIL];
  const operator = await user(OPERATOR_EMAIL);
  const admin = await user(`admin-${Date.now()}@questor.test`);
  const run = await prisma.catalogRefreshRun.create({ data: { trigger: 'manual', status: 'completed', finishedAt: new Date() } });
  return { catalog, runId: run.id, operator, admin };
}

export interface ProposalSeed {
  readonly kind?: 'new_role' | 'new_alias';
  readonly title: string;
  readonly status?: string;
  readonly domainId?: string | null;
  readonly familyId?: string | null;
  readonly targetRoleId?: string | null;
  readonly summary?: string;
  readonly sources?: readonly { source: string; ref: string; url?: string; label?: string }[];
  readonly confidence?: number;
  readonly createdAt?: Date;
}

export async function proposal(world: ReviewWorld, seed: ProposalSeed) {
  const kind = seed.kind ?? 'new_role';
  return prisma.catalogProposal.create({
    data: {
      runId: world.runId,
      kind,
      status: seed.status ?? 'pending',
      title: seed.title,
      normalizedTitle: normalizeTitle(seed.title),
      domainId: seed.domainId === undefined ? (kind === 'new_role' ? world.catalog.techId : null) : seed.domainId,
      familyId: seed.familyId ?? null,
      targetRoleId: seed.targetRoleId === undefined ? (kind === 'new_alias' ? world.catalog.sweId : null) : seed.targetRoleId,
      summary: seed.summary ?? '',
      sourcesJson: JSON.stringify(seed.sources ?? [{ source: 'onet', ref: '15-1252.00', url: 'https://www.onetonline.org/link/summary/15-1252.00', label: 'Software Developers' }]),
      confidence: seed.confidence ?? 0.7,
      ...(seed.createdAt ? { createdAt: seed.createdAt } : {}),
    },
  });
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}
