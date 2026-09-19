import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

/**
 * The JD draft service end to end: the shared cache, the background generator's
 * recovery paths, the model path and its fallback, and "describe the role",
 * which must never land in the shared cache.
 */

const LLM_JD = [
  'Platform Engineer',
  '',
  'About the role',
  'As a Platform Engineer, you will build the internal platform our product teams ship on, and keep it fast, safe and pleasant to use.',
  '',
  'What you will do',
  '- Design and run the shared build, deploy and observability tooling.',
  '- Work with product teams to remove friction from their delivery.',
  '',
  'What you bring',
  '- A track record of running production platforms.',
  '',
  'Location',
  'India.',
].join('\n');

const generate = vi.fn(async () => ({ text: JSON.stringify({ title: 'Platform Engineer', text: LLM_JD }), model: 'fake-model', inputTokens: 1, outputTokens: 1, latencyMs: 1 }));

vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>();
  return { config: { ...actual.config, llm: { ...actual.config.llm, provider: 'anthropic', anthropicKey: 'test-key' } } };
});

vi.mock('../src/providers/llm/anthropic.js', () => ({
  AnthropicLlmProvider: class {
    name = 'anthropic';
    get enabled(): boolean { return true; }
    generate = generate;
  },
}));

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { wipe } = await import('../src/seed/demoData.js');
const { signToken } = await import('../src/services/auth.js');
const { _resetLlm } = await import('../src/providers/llm/index.js');
const { _resetRateLimits } = await import('../src/middleware/rateLimit.js');
const { generatePendingDrafts, getOrQueueDraft } = await import('../src/services/jdDrafts.js');

const app = createApp();
const LONG_AGO = new Date(Date.now() - 60 * 60_000);

async function fixture() {
  const tenant = await prisma.tenant.create({ data: { name: 'Tenant A' } });
  const user = await prisma.user.create({ data: { tenantId: tenant.id, email: `u${Date.now()}${Math.random()}@jd.local`, name: 'JD User', passwordHash: 'x', role: 'admin' } });
  const auth = `Bearer ${signToken({ userId: user.id, tenantId: tenant.id, role: user.role, email: user.email })}`;
  const domain = await prisma.catalogDomain.create({ data: { slug: `eng-${Math.random()}`, name: 'Engineering', sortOrder: 1 } });
  await prisma.catalogRegion.create({ data: { code: 'IN', name: 'India', sortOrder: 1 } });
  const role = await prisma.catalogRole.create({ data: { domainId: domain.id, title: 'Platform Engineer', normalizedTitle: `platform engineer ${Math.random()}`, summary: 'Build reliable internal platforms.', source: 'test' } });
  return { auth, domain, role };
}

const key = (catalogRoleId: string) => ({ catalogRoleId, experienceBand: 'senior', regionCode: 'IN' });

beforeEach(async () => {
  await wipe();
  await prisma.catalogJdDraft.deleteMany();
  await prisma.catalogRole.deleteMany();
  await prisma.catalogDomain.deleteMany();
  await prisma.catalogRegion.deleteMany();
  await prisma.rateLimitBucket.deleteMany();
  _resetRateLimits();
  _resetLlm();
  generate.mockClear();
});

describe('shared draft generation', () => {
  it('uses the model when one is configured and records which model wrote it', async () => {
    const { role } = await fixture();
    await getOrQueueDraft(key(role.id));

    await generatePendingDrafts({ limit: 5 });

    const row = await prisma.catalogJdDraft.findFirstOrThrow();
    expect({ status: row.status, generator: row.generator, usesModelText: row.text.includes('shared build, deploy') }).toEqual({ status: 'ready', generator: 'llm', usesModelText: true });
  });

  it('falls back to the built-in writer when the model returns something unusable', async () => {
    const { role } = await fixture();
    generate.mockResolvedValueOnce({ text: 'not json at all', model: 'fake-model', inputTokens: 1, outputTokens: 1, latencyMs: 1 });
    await getOrQueueDraft(key(role.id));

    await generatePendingDrafts({ limit: 5 });

    const row = await prisma.catalogJdDraft.findFirstOrThrow();
    expect({ status: row.status, generator: row.generator }).toEqual({ status: 'ready', generator: 'heuristic' });
  });

  it('recovers a draft left "generating" by a process that stopped part-way', async () => {
    const { role } = await fixture();
    const row = await getOrQueueDraft(key(role.id));
    await prisma.catalogJdDraft.update({ where: { id: row.id }, data: { status: 'generating', updatedAt: LONG_AGO } });

    await generatePendingDrafts({ limit: 5 });

    expect((await prisma.catalogJdDraft.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('ready');
  });

  it('marks a draft failed after three errors', async () => {
    const { role } = await fixture();
    const row = await getOrQueueDraft(key(role.id));
    // An unknown band makes generation throw on every attempt.
    await prisma.catalogJdDraft.update({ where: { id: row.id }, data: { experienceBand: 'not-a-band' } });

    for (let i = 0; i < 3; i += 1) await generatePendingDrafts({ limit: 5 });

    const after = await prisma.catalogJdDraft.findUniqueOrThrow({ where: { id: row.id } });
    expect({ status: after.status, attempts: after.attempts }).toEqual({ status: 'failed', attempts: 3 });
  });

  it('gives a failed draft a fresh set of attempts after the cool-down, so it is generated again', async () => {
    const { role } = await fixture();
    const row = await getOrQueueDraft(key(role.id));
    await prisma.catalogJdDraft.update({ where: { id: row.id }, data: { status: 'failed', attempts: 3, updatedAt: LONG_AGO } });

    await getOrQueueDraft(key(role.id));
    await generatePendingDrafts({ limit: 5 });

    expect((await prisma.catalogJdDraft.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('ready');
  });
});

describe('POST /api/jd-drafts/describe', () => {
  const body = {
    title: 'Payments Engineer',
    description: 'You will run our card payments platform. You will work with risk and finance. Success is fewer failed payments.',
    experienceBand: 'senior',
    regionCode: 'IN',
  };

  it('uses the model when one is configured', async () => {
    const { auth } = await fixture();

    const res = await request(app).post('/api/jd-drafts/describe').set('Authorization', auth).send(body);

    expect({ status: res.status, generator: res.body.generator }).toEqual({ status: 200, generator: 'llm' });
  });

  it('never writes the description draft to the shared cache', async () => {
    const { auth } = await fixture();

    await request(app).post('/api/jd-drafts/describe').set('Authorization', auth).send(body);

    expect(await prisma.catalogJdDraft.count()).toBe(0);
  });

  it('limits how often one person can ask', async () => {
    const { auth } = await fixture();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) statuses.push((await request(app).post('/api/jd-drafts/describe').set('Authorization', auth).send(body)).status);

    expect(statuses.at(-1)).toBe(429);
  });
});
