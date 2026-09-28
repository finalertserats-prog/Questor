import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, DEMO_JD } from '../src/seed/demoData.js';

/**
 * The scorecard editor used to accept anything (`z.any()`) and store it. Every
 * engine downstream reads that JSON assuming weights are fractions, the pass
 * threshold is points out of 100 and proficiency is 0..5. These tests pin the
 * boundary so a bad Save is refused rather than quietly poisoning interviews.
 */

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let adminToken = '';
let roleId = '';
// The profile exactly as the extractor drafted it, so a round trip can prove
// the schema accepts what the system itself produces.
let drafted: Record<string, unknown> = {};

beforeAll(async () => {
  await prisma.candidateAssignment.deleteMany();
  await prisma.roleAssignment.deleteMany();
  await wipe();
  const reg = await request(app).post('/api/auth/register').send({
    email: 'admin@scorecard.local', password: 'fixture-admin-passphrase', name: 'Scorecard Admin', tenantName: 'Scorecard Org',
  });
  adminToken = reg.body.token;
  const roleRes = await request(app).post('/api/roles').set(auth(adminToken))
    .send({ sourceType: 'paste', sourceText: DEMO_JD, title: 'Senior Data Engineer', useLlm: false });
  roleId = roleRes.body.role.id;
  drafted = roleRes.body.scorecard.profile;
});

const put = (profile: unknown) => request(app).put(`/api/roles/${roleId}/scorecard`).set(auth(adminToken)).send({ profile });
const stored = async () => {
  const res = await request(app).get(`/api/roles/${roleId}`).set(auth(adminToken));
  return res.body.scorecards[0].profile;
};

describe('saving a scorecard', () => {
  it('accepts the profile the extractor drafted, unchanged', async () => {
    const res = await put(drafted);

    expect(res.status).toBe(200);
  });

  it('accepts an edited pass threshold inside 0..100 and stores it as given', async () => {
    const res = await put({ ...drafted, scoringRules: { ...(drafted.scoringRules as object), passThreshold: 72 } });

    expect(res.status).toBe(200);
    expect((await stored()).scoringRules.passThreshold).toBe(72);
  });

  /**
   * The same scar the competency `source` field carries, on the field added
   * next to it: this schema strips what it does not name and re-runs on every
   * Save, so a role's licence requirement would survive extraction and die at
   * the first click of the button.
   */
  it('keeps the role\'s eligibility requirements across a save', async () => {
    const eligibility = [{ id: 'elig-7', kind: 'licence', text: 'An active RN licence is required.', line: 7 }];
    const res = await put({ ...drafted, eligibility });

    expect(res.status).toBe(200);
    expect((await stored()).eligibility).toEqual(eligibility);
  });

  it('refuses an eligibility requirement that cannot quote the advert', async () => {
    const res = await put({ ...drafted, eligibility: [{ id: 'elig-0', kind: 'licence', text: '', line: 0 }] });

    expect(res.status).toBe(400);
  });

  it('accepts a red flag a person added', async () => {
    const res = await put({ ...drafted, redFlags: ['Cannot describe their own contribution to a team result'] });

    expect((await stored()).redFlags).toContain('Cannot describe their own contribution to a team result');
    expect(res.status).toBe(200);
  });
});

describe('refusing a scorecard that would poison the engines', () => {
  it('refuses a pass threshold above 100', async () => {
    const res = await put({ ...drafted, scoringRules: { ...(drafted.scoringRules as object), passThreshold: 6500 } });

    expect(res.status).toBe(400);
  });

  it('leaves the stored profile untouched when a save is refused', async () => {
    const before = await stored();
    await put({ ...drafted, scoringRules: { ...(drafted.scoringRules as object), passThreshold: 6500 } });

    expect(await stored()).toEqual(before);
  });

  it('refuses a competency weight above 1', async () => {
    const competencies = (drafted.competencies as Array<Record<string, unknown>>).map((c, i) => (i === 0 ? { ...c, weight: 40 } : c));

    const res = await put({ ...drafted, competencies });

    expect(res.status).toBe(400);
  });

  it('refuses a red flag longer than a person could read mid-interview', async () => {
    const res = await put({ ...drafted, redFlags: ['x'.repeat(161)] });

    expect(res.status).toBe(400);
  });

  it('refuses more red flags than the editor allows', async () => {
    const res = await put({ ...drafted, redFlags: Array.from({ length: 21 }, (_, i) => `Flag ${i}`) });

    expect(res.status).toBe(400);
  });

  it('refuses a must-pass id that names no competency', async () => {
    const res = await put({ ...drafted, scoringRules: { ...(drafted.scoringRules as object), mustPassCompetencyIds: ['ghost'] } });

    expect(res.status).toBe(400);
  });

  it('refuses a profile with no competencies at all', async () => {
    const res = await put({ ...drafted, competencies: [] });

    expect(res.status).toBe(400);
  });

  it('refuses a profile that is not an object', async () => {
    const res = await put('drop everything');

    expect(res.status).toBe(400);
  });

  it('explains what was wrong without a stack trace', async () => {
    const res = await put({ ...drafted, scoringRules: { ...(drafted.scoringRules as object), passThreshold: 6500 } });

    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts:\d+/);
  });
});

describe('the weights as shares of one score', () => {
  it('refuses scored weights that do not total 100%', async () => {
    const competencies = (drafted.competencies as Array<Record<string, unknown>>).map((c) => ({ ...c, weight: 1 }));

    const res = await put({ ...drafted, competencies });

    expect(res.status).toBe(400);
  });

  it('names the total in the refusal so the editor can fix it', async () => {
    const competencies = (drafted.competencies as Array<Record<string, unknown>>).map((c) => ({ ...c, weight: 1 }));

    const res = await put({ ...drafted, competencies });

    expect(JSON.stringify(res.body)).toMatch(/must total 100%/);
  });

  it('ignores non-scoring competencies when totalling', async () => {
    const competencies = (drafted.competencies as Array<Record<string, unknown>>).map((c, i) => (
      i === 0 ? { ...c, classification: 'non_scoring', weight: 0.4 } : c
    ));
    const scored = competencies.filter((c) => c.classification !== 'non_scoring');
    const total = scored.reduce((sum, c) => sum + (c.weight as number), 0);
    const rebalanced = competencies.map((c) => (c.classification === 'non_scoring' ? c : { ...c, weight: (c.weight as number) / total }));
    // A non-scoring competency cannot stay must-pass; this test is about the total, not that rule.
    const scoringRules = drafted.scoringRules as { mustPassCompetencyIds: string[] };
    const mustPassCompetencyIds = scoringRules.mustPassCompetencyIds.filter((id) => id !== (competencies[0] as { id: string }).id);

    const res = await put({ ...drafted, competencies: rebalanced, scoringRules: { ...scoringRules, mustPassCompetencyIds } });

    expect(res.status).toBe(200);
  });
});
