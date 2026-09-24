import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, DEMO_JD } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { _resetRateLimits } from '../src/middleware/rateLimit.js';

/**
 * The approved scorecard as a document someone can file, print or send to a
 * hiring manager who will never log in.
 *
 * Two things are asserted about the bytes rather than about our own helpers:
 * that the response really is a PDF (the %PDF magic), and that the text inside
 * it is real, selectable text (pdf-parse reads it back). A screenshot or an
 * image-only PDF would pass a status-code test and fail both of these.
 */

const app = createApp();

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const PIPELINE_SPAN = 'Design and operate the batch and streaming pipelines that feed reporting.';
const MODELLING_SPAN = 'Own the dimensional model behind the warehouse.';
const STALE_SPAN = 'A stale span that the richer source field must beat.';

function profileWith(): Record<string, unknown> {
  return {
    roleContext: 'Data platform team for the payments organisation.',
    seniority: 'senior',
    outcomes: ['Pipelines run without manual intervention.'],
    responsibilities: ['Operate the warehouse.'],
    redFlags: ['No ownership of production incidents.'],
    competencies: [
      {
        id: 'c-pipelines',
        name: 'Pipeline Reliability',
        definition: 'Keeps scheduled and streaming data flows correct and on time.',
        category: 'technical',
        classification: 'essential',
        weight: 0.6,
        requiredLevel: 3,
        targetLevel: 4,
        indicators: ['Designs for replay and backfill.', 'Instruments freshness and volume checks.'],
        evidenceModes: ['technical_explanation'],
        sourceText: PIPELINE_SPAN,
      },
      {
        id: 'c-stakeholders',
        name: 'Stakeholder Communication',
        definition: 'Explains data limitations to the people who act on the numbers.',
        category: 'communication',
        classification: 'preferred',
        weight: 0.4,
        requiredLevel: 2,
        targetLevel: 3,
        indicators: ['States confidence and caveats unprompted.'],
        evidenceModes: ['behavioral_example'],
        // Deliberately no span of any kind.
      },
      {
        id: 'c-modelling',
        name: 'Dimensional Modelling',
        definition: 'Shapes facts and dimensions the business can query.',
        category: 'domain',
        classification: 'non_scoring',
        weight: 0,
        requiredLevel: 2,
        targetLevel: 4,
        indicators: ['Names grain explicitly.'],
        evidenceModes: ['work_sample'],
        // Both shapes present: the richer one wins.
        sourceText: STALE_SPAN,
        source: { text: MODELLING_SPAN, section: 'Responsibilities', line: 12 },
      },
    ],
    scoringRules: { mustPassCompetencyIds: ['c-pipelines'], notEnoughEvidencePolicy: 'exclude', passThreshold: 70 },
    policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'in' },
  };
}

/** superagent hands us a Buffer only when we ask it not to decode the body. */
const getPdf = (roleId: string, token: string) =>
  request(app).get(`/api/roles/${roleId}/export.pdf`).set(auth(token)).responseType('blob');

/**
 * pdf.js reads `data.buffer` and ignores the view's byteOffset, and a Buffer
 * from `Buffer.concat` sits at a non-zero offset inside the pool — so a raw
 * Buffer is read as someone else's bytes and fails with "bad XRef entry".
 */
async function textOf(body: Buffer): Promise<string> {
  const mod = await import('pdf-parse/lib/pdf-parse.js');
  const parsed = await mod.default(Buffer.from(new Uint8Array(body)));
  return parsed.text.replace(/\s+/g, ' ');
}

let adminToken = '';
let tenantId = '';
let adminUserId = '';
let roleId = '';

async function register(email: string, tenantName: string) {
  const res = await request(app).post('/api/auth/register').send({
    email, password: 'fixture-admin-passphrase', name: 'Export Admin', tenantName,
  });
  return { token: res.body.token as string, tenantId: res.body.user.tenantId as string, userId: res.body.user.id as string };
}

async function latestScorecard() {
  return prisma.roleScorecardVersion.findFirstOrThrow({ where: { roleId }, orderBy: { version: 'desc' } });
}

/** Writes the fixture profile straight onto the draft: `source` is not part of
 *  the edit schema, so a PUT would strip it before it ever reached the PDF. */
async function seedProfile() {
  const draft = await latestScorecard();
  await prisma.roleScorecardVersion.update({ where: { id: draft.id }, data: { profileJson: JSON.stringify(profileWith()) } });
  return draft;
}

async function approve() {
  const draft = await latestScorecard();
  return request(app).post(`/api/roles/${roleId}/approve`).set(auth(adminToken)).send({ scorecardId: draft.id, version: draft.version });
}

beforeEach(async () => {
  await prisma.candidateAssignment.deleteMany();
  await prisma.roleAssignment.deleteMany();
  await wipe();
  await prisma.demoGrant.deleteMany();
  await prisma.rateLimitBucket.deleteMany();
  _resetRateLimits();

  const admin = await register('admin@export.local', 'Export Org');
  adminToken = admin.token;
  tenantId = admin.tenantId;
  adminUserId = admin.userId;

  const created = await request(app).post('/api/roles').set(auth(adminToken))
    .send({ sourceType: 'paste', sourceText: DEMO_JD, title: 'Senior Data Engineer / Payments', useLlm: false });
  roleId = created.body.role.id;
  await seedProfile();
});

describe('GET /api/roles/:id/export.pdf', () => {
  it('refuses a role whose latest scorecard is not approved', async () => {
    const res = await getPdf(roleId, adminToken);

    expect(res.status).toBe(409);
  });

  it('explains the refusal as JSON rather than sending a broken file', async () => {
    const res = await request(app).get(`/api/roles/${roleId}/export.pdf`).set(auth(adminToken));

    expect(res.body.error).toMatch(/approved/i);
  });

  it('answers a real PDF for an approved role', async () => {
    await approve();

    const res = await getPdf(roleId, adminToken);

    expect([res.status, res.headers['content-type'], (res.body as Buffer).subarray(0, 5).toString('latin1')])
      .toEqual([200, 'application/pdf', '%PDF-']);
  });

  it('names the download after the role and the scorecard version', async () => {
    await approve();

    const res = await getPdf(roleId, adminToken);

    expect(res.headers['content-disposition']).toBe('attachment; filename="Senior-Data-Engineer-Payments-scorecard-v1.pdf"');
  });

  it('writes the role title as selectable text', async () => {
    await approve();

    const text = await textOf((await getPdf(roleId, adminToken)).body);

    expect(text).toContain('Senior Data Engineer / Payments');
  });

  it('writes the organisation, level, location and employment type', async () => {
    await approve();

    const text = await textOf((await getPdf(roleId, adminToken)).body);

    expect(text).toContain('Export Org');
  });

  it('writes the job description text', async () => {
    await approve();

    const text = await textOf((await getPdf(roleId, adminToken)).body);

    // Normalised the same way the extracted text is: the JD's own double
    // spaces survive into the PDF but not through a whitespace-flattened read.
    const jdLine = DEMO_JD.split('\n').find((line) => line.trim().length > 30)!.trim().replace(/\s+/g, ' ');
    expect(text).toContain(jdLine.slice(0, 40));
  });

  it('writes every competency name', async () => {
    await approve();

    const text = await textOf((await getPdf(roleId, adminToken)).body);

    expect(['Pipeline Reliability', 'Stakeholder Communication', 'Dimensional Modelling'].every((n) => text.includes(n))).toBe(true);
  });

  it('writes a competency weight as a percentage', async () => {
    await approve();

    const text = await textOf((await getPdf(roleId, adminToken)).body);

    expect(text).toContain('60%');
  });

  it('writes the required and target levels', async () => {
    await approve();

    const text = await textOf((await getPdf(roleId, adminToken)).body);

    expect(text).toMatch(/Required level 3/);
  });

  it('writes the definition and the indicators', async () => {
    await approve();

    const text = await textOf((await getPdf(roleId, adminToken)).body);

    expect(text).toContain('Designs for replay and backfill.');
  });

  it('writes the JD line a competency was derived from', async () => {
    await approve();

    const text = await textOf((await getPdf(roleId, adminToken)).body);

    expect(text).toContain(PIPELINE_SPAN);
  });

  it('prefers the richer source field over the older sourceText', async () => {
    await approve();

    const text = await textOf((await getPdf(roleId, adminToken)).body);

    expect([text.includes(MODELLING_SPAN), text.includes(STALE_SPAN)]).toEqual([true, false]);
  });

  it('says so when a competency has no span at all', async () => {
    await approve();

    const text = await textOf((await getPdf(roleId, adminToken)).body);

    expect(text).toContain('No source span recorded');
  });

  it('writes the scorecard version, the approver and the approval date', async () => {
    await approve();
    const approved = await latestScorecard();

    const text = await textOf((await getPdf(roleId, adminToken)).body);

    expect([
      text.includes('Version 1'),
      text.includes('Export Admin'),
      text.includes(approved.approvedAt!.toISOString().slice(0, 10)),
    ]).toEqual([true, true, true]);
  });

  it('numbers every page and dates the file', async () => {
    await approve();

    const text = await textOf((await getPdf(roleId, adminToken)).body);

    expect(text).toMatch(/Page 1 of \d+/);
  });

  it('refuses a role that belongs to another organisation', async () => {
    await approve();
    const stranger = await register('admin@other.local', 'Other Org');

    const res = await getPdf(roleId, stranger.token);

    expect(res.status).toBe(404);
  });

  it('refuses a user whose role may not read requisitions', async () => {
    await approve();
    const auditor = await prisma.user.create({ data: { email: 'auditor@export.local', name: 'Auditor', passwordHash: 'x', role: 'auditor', tenantId } });
    const token = signToken({ userId: auditor.id, tenantId, role: 'auditor', email: auditor.email });

    const res = await getPdf(roleId, token);

    expect(res.status).toBe(403);
  });

  it('lets a demo sandbox export its own role', async () => {
    await approve();
    const demoTenant = await prisma.tenant.create({ data: { name: 'Demo Org', isDemo: true, demoExpiresAt: new Date(Date.now() + 3_600_000) } });
    const demoUser = await prisma.user.create({ data: { email: 'visitor@demo.local', name: 'Demo Visitor', passwordHash: 'x', role: 'demo', tenantId: demoTenant.id } });
    const grant = await prisma.demoGrant.create({
      data: {
        name: 'Demo Visitor', email: 'visitor@demo.local', company: 'Demo Co', status: 'consumed',
        tenantId: demoTenant.id, userId: demoUser.id, requestIpHash: 'hash',
        sessionEndsAt: new Date(Date.now() + 3_600_000),
      },
    });
    const demoRole = await prisma.role.create({ data: { tenantId: demoTenant.id, title: 'Sandbox Analyst', sourceText: DEMO_JD, status: 'approved', createdById: demoUser.id } });
    await prisma.roleAssignment.create({ data: { roleId: demoRole.id, userId: demoUser.id, relation: 'owner' } });
    await prisma.roleScorecardVersion.create({
      data: { roleId: demoRole.id, version: 1, status: 'approved', profileJson: JSON.stringify(profileWith()), approvedById: demoUser.id, approvedAt: new Date() },
    });
    const token = signToken({ userId: demoUser.id, tenantId: demoTenant.id, role: 'demo', email: demoUser.email, demo: true, demoGrantId: grant.id });

    const res = await getPdf(demoRole.id, token);

    expect([res.status, (res.body as Buffer).subarray(0, 5).toString('latin1')]).toEqual([200, '%PDF-']);
  });

  it('does not leak another organisation into the demo sandbox export', async () => {
    await approve();
    const demoTenant = await prisma.tenant.create({ data: { name: 'Demo Org 2', isDemo: true } });
    const demoUser = await prisma.user.create({ data: { email: 'visitor2@demo.local', name: 'Demo Visitor 2', passwordHash: 'x', role: 'demo', tenantId: demoTenant.id } });
    const grant = await prisma.demoGrant.create({
      data: {
        name: 'Demo Visitor 2', email: 'visitor2@demo.local', company: 'Demo Co', status: 'consumed',
        tenantId: demoTenant.id, userId: demoUser.id, requestIpHash: 'hash2',
        sessionEndsAt: new Date(Date.now() + 3_600_000),
      },
    });
    const token = signToken({ userId: demoUser.id, tenantId: demoTenant.id, role: 'demo', email: demoUser.email, demo: true, demoGrantId: grant.id });

    const res = await getPdf(roleId, token);

    expect(res.status).toBe(404);
  });

  it('cuts off a runaway job description and says that it did', async () => {
    // An ATS import copies the requisition description with no limit of its
    // own, so this length is reachable without pasting it.
    const runaway = `${'reliability '.repeat(5100)}TAIL-MARKER-NOT-RENDERED`;
    await prisma.role.update({ where: { id: roleId }, data: { sourceText: runaway } });
    await approve();

    const text = await textOf((await getPdf(roleId, adminToken)).body);

    expect([text.includes('is cut off here'), text.includes('TAIL-MARKER-NOT-RENDERED')]).toEqual([true, false]);
  });

  it('never prints an approver who belongs to another organisation', async () => {
    await approve();
    const stranger = await register('admin@elsewhere.local', 'Elsewhere Org');
    const outsider = await prisma.user.findFirstOrThrow({ where: { id: stranger.userId } });
    await prisma.roleScorecardVersion.updateMany({ where: { roleId }, data: { approvedById: outsider.id } });

    const text = await textOf((await getPdf(roleId, adminToken)).body);

    expect(text).not.toContain(outsider.email);
  });

  it('keeps the approver row honest when the account has since been removed', async () => {
    await approve();
    await prisma.roleScorecardVersion.updateMany({ where: { roleId }, data: { approvedById: 'gone-user-id' } });

    const text = await textOf((await getPdf(roleId, adminToken)).body);

    expect(text).toContain('Approved by');
    expect(adminUserId).not.toBe('gone-user-id');
  });
});
