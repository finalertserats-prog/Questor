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
const { finishDraft, generatePendingDrafts, getOrQueueDraft } = await import('../src/services/jdDrafts.js');

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
  await prisma.jobLease.deleteMany();
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

describe('generation stays bounded (Codex release review)', () => {
  it('does not generate from the request while another instance holds the generation lease', async () => {
    const { auth, role } = await fixture();
    await prisma.jobLease.create({ data: { name: 'jd-draft-generate', holder: 'another-instance', expiresAt: new Date(Date.now() + 60_000) } });

    await request(app).get('/api/jd-drafts').query(key(role.id)).set('Authorization', auth);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect((await prisma.catalogJdDraft.findFirstOrThrow()).status).toBe('pending');
  });

  it('never lets a worker whose claim was taken over overwrite the draft', async () => {
    const { role } = await fixture();
    const row = await getOrQueueDraft(key(role.id));
    const staleClaim = new Date(Date.now() - 20 * 60_000);
    await prisma.catalogJdDraft.update({ where: { id: row.id }, data: { status: 'generating', updatedAt: new Date() } });

    const written = await finishDraft(row.id, staleClaim, { status: 'ready', text: 'late text', generator: 'llm', model: '', promptVersion: 'v', lintJson: '[]', lastError: '' });

    expect({ written, text: (await prisma.catalogJdDraft.findUniqueOrThrow({ where: { id: row.id } })).text }).toEqual({ written: false, text: '' });
  });

  it('leaves a live claim alone', async () => {
    const { role } = await fixture();
    const row = await getOrQueueDraft(key(role.id));
    await prisma.catalogJdDraft.update({ where: { id: row.id }, data: { status: 'generating', updatedAt: new Date() } });

    await generatePendingDrafts({ limit: 5 });

    expect((await prisma.catalogJdDraft.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('generating');
  });

  it('limits how many new shared drafts one person can ask for, while existing drafts stay readable', async () => {
    const { auth, domain } = await fixture();
    const roles = [];
    for (let i = 0; i < 6; i += 1) roles.push(await prisma.catalogRole.create({ data: { domainId: domain.id, title: `Role ${i}`, normalizedTitle: `role ${i} ${Math.random()}`, source: 'test' } }));
    const bands = ['emerging', 'developing', 'established', 'senior', 'principal', 'executive'];
    const statuses: number[] = [];
    for (const r of roles) for (const b of bands) {
      statuses.push((await request(app).get('/api/jd-drafts').query({ catalogRoleId: r.id, experienceBand: b, regionCode: 'IN' }).set('Authorization', auth)).status);
    }
    const again = await request(app).get('/api/jd-drafts').query({ catalogRoleId: roles[0].id, experienceBand: 'emerging', regionCode: 'IN' }).set('Authorization', auth);

    expect({ limited: statuses.includes(429), rereadOk: again.status !== 429 }).toEqual({ limited: true, rereadOk: true });
  });
});

describe('Global drafts stay location-agnostic', () => {
  const GLOBAL_JD = LLM_JD.replace('India.', 'Open to candidates in multiple regions; remote-friendly.');
  const globalKey = (catalogRoleId: string) => ({ catalogRoleId, experienceBand: 'senior', regionCode: 'GLOBAL' });

  async function globalFixture() {
    const made = await fixture();
    await prisma.catalogRegion.create({ data: { code: 'GLOBAL', name: 'Global (all regions)', sortOrder: 0 } });
    return made;
  }

  it('falls back to the built-in writer when the model ties a Global role to one country', async () => {
    const { role } = await globalFixture();
    await getOrQueueDraft(globalKey(role.id));

    await generatePendingDrafts({ limit: 5 });

    const row = await prisma.catalogJdDraft.findFirstOrThrow({ where: { regionCode: 'GLOBAL' } });
    expect({ generator: row.generator, namesIndia: row.text.includes('India') }).toEqual({ generator: 'heuristic', namesIndia: false });
  });

  it('keeps the model draft for a Global role when it names no place', async () => {
    const { role } = await globalFixture();
    generate.mockResolvedValueOnce({ text: JSON.stringify({ title: 'Platform Engineer', text: GLOBAL_JD }), model: 'fake-model', inputTokens: 1, outputTokens: 1, latencyMs: 1 });
    await getOrQueueDraft(globalKey(role.id));

    await generatePendingDrafts({ limit: 5 });

    expect((await prisma.catalogJdDraft.findFirstOrThrow({ where: { regionCode: 'GLOBAL' } })).generator).toBe('llm');
  });

  it('describes a Global role without the country the model named', async () => {
    const { auth } = await globalFixture();

    const res = await request(app).post('/api/jd-drafts/describe').set('Authorization', auth).send({
      title: 'Payments Engineer',
      description: 'You will run our card payments platform. You will work with risk and finance. Success is fewer failed payments.',
      experienceBand: 'senior',
      regionCode: 'GLOBAL',
    });

    expect({ status: res.status, generator: res.body.generator, namesIndia: String(res.body.text).includes('India') }).toEqual({ status: 200, generator: 'heuristic', namesIndia: false });
  });
});
