import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe, DEMO_RESUME } from '../src/seed/demoData.js';

/**
 * The award engine, end to end.
 *
 * Two things are being pinned here, and they are the two a developer gets
 * wrong. First: a tier is earned when the candidate is promoted OUT of it, so
 * the Gold → Diamond move writes Gold AND Diamond, and a candidate sitting at
 * Silver holds no Silver badge however finished their interview is. Second:
 * the move and the badges it earns commit together — a journey showing a
 * candidate at Gold with no Silver badge has no way to say which half is right.
 */

const app = createApp();
const REASON = 'The evidence on the core competencies was clear and consistent.';

async function seeded() {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { ...ids, auth: `Bearer ${login.body.token as string}` };
}

type Seeded = Awaited<ReturnType<typeof seeded>>;

const STAGES = ['participation', 'bronze', 'silver', 'gold', 'diamond'];

/** A pipeline walked to `stage` with the Advance button, as HR walks it. */
async function pipelineAt(ids: Seeded, stage: string): Promise<string> {
  const created = await request(app).post('/api/pipelines').set('Authorization', ids.auth).send({ candidateId: ids.candidateId });
  const id = created.body.pipeline.id as string;
  for (const key of STAGES.slice(1, STAGES.indexOf(stage) + 1)) {
    await request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', ids.auth).send({ toStageKey: key });
  }
  return id;
}

/** A fresh applicant on the seeded role, with a CV read against its approved scorecard. */
async function applicantWithCv(ids: Seeded, name: string): Promise<string> {
  const created = await request(app).post('/api/candidates').set('Authorization', ids.auth)
    .send({ fullName: name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`, roleId: ids.roleId });
  const candidateId = created.body.candidate.id as string;
  await request(app).post(`/api/candidates/${candidateId}/resume`).set('Authorization', ids.auth).field('text', DEMO_RESUME);
  return candidateId;
}

const advance = (ids: Seeded, pipelineId: string, toStageKey: string) =>
  request(app).post(`/api/pipelines/${pipelineId}/advance`).set('Authorization', ids.auth).send({ toStageKey });

/**
 * The tiers held, in ladder order rather than in the order they were written.
 * Two tiers struck by one promotion share a timestamp — they were earned at
 * the same moment — so time cannot order them and the ladder has to.
 */
async function tiersHeld(candidateId: string): Promise<string[]> {
  const rows = await prisma.candidateAward.findMany({ where: { candidateId }, select: { tier: true } });
  const ladder = ['bronze', 'silver', 'gold', 'diamond'];
  return rows.map((row) => row.tier).sort((a, b) => ladder.indexOf(a) - ladder.indexOf(b));
}

describe('a tier is earned on the way out of it', () => {
  beforeEach(async () => { await wipe(); });

  it('strikes Silver when the candidate is moved from Silver to Gold', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'silver');

    await advance(ids, pipelineId, 'gold');

    expect(await tiersHeld(ids.candidateId)).toContain('silver');
  });

  it('strikes nothing for a candidate who has arrived at Silver and gone no further', async () => {
    const ids = await seeded();
    await pipelineAt(ids, 'silver');

    expect(await tiersHeld(ids.candidateId)).not.toContain('silver');
  });

  it('strikes both Gold and Diamond on the single move from Gold to Diamond', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'gold');

    await advance(ids, pipelineId, 'diamond');

    const held = await tiersHeld(ids.candidateId);
    expect(held).toContain('gold');
    expect(held).toContain('diamond');
  });

  it('reports the two tiers that one promotion earned', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'gold');

    const res = await advance(ids, pipelineId, 'diamond');

    expect(res.body.awards.map((a: { tier: string }) => a.tier)).toEqual(['gold', 'diamond']);
  });

  it('strikes nothing for the move into Silver', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'bronze');

    const res = await advance(ids, pipelineId, 'silver');

    expect(res.body.awards).toEqual([]);
  });

  it('records the person who made the move on every tier it earned', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'gold');

    await advance(ids, pipelineId, 'diamond');

    const rows = await prisma.candidateAward.findMany({ where: { candidateId: ids.candidateId, tier: { in: ['gold', 'diamond'] } } });
    expect(rows.map((row) => row.awardedByUserId)).toEqual([ids.userId, ids.userId]);
  });

  it('strikes the tiers an approval earns, the same as the Advance button', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'silver');

    await request(app).post(`/api/pipelines/${pipelineId}/decision`).set('Authorization', ids.auth)
      .send({ decision: 'APPROVED', reason: REASON, stageKey: 'silver' });

    expect(await tiersHeld(ids.candidateId)).toContain('silver');
  });

  it('strikes nothing when a decision closes the pipeline instead of moving it', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'silver');

    await request(app).post(`/api/pipelines/${pipelineId}/decision`).set('Authorization', ids.auth)
      .send({ decision: 'REJECTED', reason: REASON, stageKey: 'silver' });

    // A candidate turned down at Silver was never promoted out of Silver, so
    // there is nothing to certify — the interview happening is not the earning.
    expect(await tiersHeld(ids.candidateId)).toEqual([]);
  });

  it('strikes Diamond and the tier below it when Finalise carries the candidate there', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'gold');

    await request(app).post(`/api/pipelines/${pipelineId}/finalize`).set('Authorization', ids.auth).send({});

    // Silver was struck on the way up, by the move out of Silver into Gold.
    expect(await tiersHeld(ids.candidateId)).toEqual(['silver', 'gold', 'diamond']);
  });

  // Nobody interviewed them at Gold, so a Gold certificate would claim rounds
  // that never happened.
  it('skips Gold when a finalisation carries the candidate straight past it', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'silver');

    await request(app).post(`/api/pipelines/${pipelineId}/finalize`).set('Authorization', ids.auth).send({});

    expect(await tiersHeld(ids.candidateId)).toEqual(['silver', 'diamond']);
  });

  // The operator's repair case: a candidate moved to Diamond, put back because
  // the move was a mistake, and promoted again once it was not. The second
  // promotion must not mint a second Gold — the first certificate is out there
  // and a duplicate reference for the same tier makes both unverifiable.
  it('does not mint a second Gold when a candidate is moved back and promoted again', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'gold');
    await advance(ids, pipelineId, 'diamond');
    const first = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId: ids.candidateId, tier: 'gold' } });

    // Only an operator can do this; the API moves candidates forward only.
    await prisma.candidatePipeline.update({ where: { id: pipelineId }, data: { currentStageKey: 'gold' } });
    const res = await advance(ids, pipelineId, 'diamond');

    expect(res.status).toBe(200);
    const gold = await prisma.candidateAward.findMany({ where: { candidateId: ids.candidateId, tier: 'gold' } });
    expect(gold).toHaveLength(1);
    expect(gold[0].reference).toBe(first.reference);
    expect(gold[0].evidenceJson).toBe(first.evidenceJson);
    expect(res.body.awards).toEqual([]);
  });

  it('does not re-strike a tier the candidate already holds', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'gold');
    await advance(ids, pipelineId, 'diamond');
    const first = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId: ids.candidateId, tier: 'diamond' } });

    // A second pipeline for the same person and role is refused, so the retry
    // that matters is the same move arriving twice; the stage is already past.
    await advance(ids, pipelineId, 'diamond');

    const rows = await prisma.candidateAward.findMany({ where: { candidateId: ids.candidateId, tier: 'diamond' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].reference).toBe(first.reference);
  });
});

describe('Bronze, which no person awards', () => {
  beforeEach(async () => { await wipe(); });

  it('is struck when the CV has been read against an approved scorecard', async () => {
    const ids = await seeded();

    const candidateId = await applicantWithCv(ids, 'Mei Lin Chua');

    expect(await tiersHeld(candidateId)).toEqual(['bronze']);
  });

  // The absence of a person is the fact the Bronze certificate exists to make
  // visible; a user id here would put someone's name on a reading nobody made.
  it('carries no person, because nobody assessed it', async () => {
    const ids = await seeded();
    const candidateId = await applicantWithCv(ids, 'Mei Lin Chua');

    const award = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId, tier: 'bronze' } });

    expect(award.awardedByUserId).toBeNull();
  });

  it('says on the certificate that no human assessed the profile', async () => {
    const ids = await seeded();
    const candidateId = await applicantWithCv(ids, 'Mei Lin Chua');

    const award = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId, tier: 'bronze' } });
    const rows = (JSON.parse(award.evidenceJson) as { rows: { what: string }[] }).rows;

    expect(rows).toHaveLength(5);
    expect(rows.some((row) => row.what.includes('no human assessment'))).toBe(true);
  });

  it('is not struck a second time when the CV is uploaded again', async () => {
    const ids = await seeded();
    const candidateId = await applicantWithCv(ids, 'Mei Lin Chua');
    const first = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId, tier: 'bronze' } });

    await request(app).post(`/api/candidates/${candidateId}/resume`).set('Authorization', ids.auth).field('text', DEMO_RESUME);

    const rows = await prisma.candidateAward.findMany({ where: { candidateId, tier: 'bronze' } });
    expect(rows).toHaveLength(1);
    // The first certificate said what was true when it was struck; a re-read
    // of the CV must not rewrite it.
    expect(rows[0].evidenceJson).toBe(first.evidenceJson);
  });

  it('is not struck when the scorecard behind the reading was never approved', async () => {
    const ids = await seeded();
    // A role whose scorecard nobody has approved: the fit is a guess about a
    // guess, and a certificate is exactly the record services/scorecards.ts
    // forbids a provisional reading from standing in for.
    const role = await prisma.role.create({
      data: { tenantId: ids.tenantId, title: 'Unchecked Role', sourceType: 'paste', sourceText: 'Draft only', status: 'approved', createdById: ids.userId },
    });
    await prisma.roleScorecardVersion.create({ data: { roleId: role.id, version: 1, status: 'draft', profileJson: '{"competencies":[]}' } });
    const created = await request(app).post('/api/candidates').set('Authorization', ids.auth)
      .send({ fullName: 'Draft Applicant', email: 'draft.applicant@example.com', roleId: role.id });
    const candidateId = created.body.candidate.id as string;

    await request(app).post(`/api/candidates/${candidateId}/resume`).set('Authorization', ids.auth).field('text', DEMO_RESUME);

    expect(await tiersHeld(candidateId)).toEqual([]);
  });
});

describe('what is written onto an award', () => {
  beforeEach(async () => { await wipe(); });

  it('prints a reference in the form the certificate shows', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'silver');

    await advance(ids, pipelineId, 'gold');

    const award = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId: ids.candidateId, tier: 'silver' } });
    expect(award.reference).toMatch(/^QS-SLV-[2-9A-HJ-NP-Z]{4}-[0-9]{4}$/);
  });

  // The verify URL is public and the reference is printed on paper anyone may
  // be handed. One must not open the other.
  it('mints a verification token that cannot be derived from the printed reference', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'gold');

    await advance(ids, pipelineId, 'diamond');

    const rows = await prisma.candidateAward.findMany({ where: { candidateId: ids.candidateId } });
    for (const row of rows) {
      const referenceCharacters = row.reference.replace(/[^A-Z0-9]/g, '');
      expect(row.verifyToken).not.toContain(referenceCharacters);
      expect(row.verifyToken.length).toBeGreaterThanOrEqual(32);
    }
    expect(new Set(rows.map((row) => row.verifyToken)).size).toBe(rows.length);
  });

  it('freezes the evidence at award time instead of re-deriving it later', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'silver');
    await advance(ids, pipelineId, 'gold');
    const struck = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId: ids.candidateId, tier: 'silver' } });

    // The world moves on: the candidate is renamed and their profile deleted.
    await prisma.candidate.update({ where: { id: ids.candidateId }, data: { fullName: 'Someone Else' } });
    await prisma.evidenceEdge.deleteMany({});
    await prisma.evidenceNode.deleteMany({});
    await prisma.candidateProfileVersion.deleteMany({ where: { candidateId: ids.candidateId } });

    const now = await prisma.candidateAward.findFirstOrThrow({ where: { id: struck.id } });
    expect(now.evidenceJson).toBe(struck.evidenceJson);
  });

  it('writes five evidence rows, which is the certificate structure', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'silver');

    await advance(ids, pipelineId, 'gold');

    const award = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId: ids.candidateId, tier: 'silver' } });
    expect((JSON.parse(award.evidenceJson) as { rows: unknown[] }).rows).toHaveLength(5);
  });

  it('records each struck badge in the audit trail without its verification token', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'gold');

    await advance(ids, pipelineId, 'diamond');

    const awards = await prisma.candidateAward.findMany({ where: { candidateId: ids.candidateId } });
    const events = await prisma.auditEvent.findMany({ where: { action: 'award.struck' } });
    // One event per badge: Silver on the way up, then Gold and Diamond together.
    expect(events.map((event) => event.entityId).sort()).toEqual(awards.map((award) => award.id).sort());
    expect(events.some((event) => awards.some((award) => event.afterJson.includes(award.verifyToken)))).toBe(false);
  });
});

describe('the journey, one row per tier', () => {
  beforeEach(async () => { await wipe(); });

  const journey = (ids: Seeded) =>
    request(app).get(`/api/candidates/${ids.candidateId}/awards`).set('Authorization', ids.auth);

  it('shows an unearned tier as a reason and nothing else', async () => {
    const ids = await seeded();
    await pipelineAt(ids, 'silver');

    const res = await journey(ids);

    const silver = res.body.awards.find((row: { tier: string }) => row.tier === 'silver');
    expect(silver).toMatchObject({ earned: false, reason: 'Awarded when they move to Gold' });
    expect(silver.reference).toBeUndefined();
    expect(silver.exports).toBeUndefined();
  });

  it('gives an earned tier its badge exports and its certificate', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'silver');
    await advance(ids, pipelineId, 'gold');

    const res = await journey(ids);

    const silver = res.body.awards.find((row: { tier: string }) => row.tier === 'silver');
    expect(silver.earned).toBe(true);
    expect(silver.exports).toEqual({
      badgeSvg: `/api/candidates/${ids.candidateId}/awards/silver/badge.svg`,
      badgePng: `/api/candidates/${ids.candidateId}/awards/silver/badge.png`,
      certificatePdf: `/api/candidates/${ids.candidateId}/awards/silver/certificate.pdf`,
    });
  });

  it('offers Diamond a badge and no certificate', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'gold');
    await advance(ids, pipelineId, 'diamond');

    const res = await journey(ids);

    const diamond = res.body.awards.find((row: { tier: string }) => row.tier === 'diamond');
    expect(diamond).toMatchObject({ hasCertificate: false });
    expect(diamond.exports.certificatePdf).toBeNull();
  });

  // The seeded candidate's CV was scored before scorecard approval was stamped
  // on a fit, so they hold no Bronze — and the journey is a record of what was
  // earned plus the one thing about to be, not a checklist of what was not.
  it('shows what was earned and the tier being worked towards, and nothing else', async () => {
    const ids = await seeded();
    await pipelineAt(ids, 'silver');

    const res = await journey(ids);

    expect(res.body.awards.map((row: { tier: string }) => row.tier)).toEqual(['silver']);
  });

  it('shows the Bronze a candidate holds beside the Silver they are working towards', async () => {
    const ids = await seeded();
    const candidateId = await applicantWithCv(ids, 'Mei Lin Chua');
    // The resume upload already started their pipeline and carried them to
    // Bronze on its own (services/pipelineAutonomy.ts), so it is read, not made.
    const listed = await request(app).get(`/api/pipelines?candidateId=${candidateId}`).set('Authorization', ids.auth);
    const pipelineId = listed.body.pipelines[0].id as string;
    await request(app).post(`/api/pipelines/${pipelineId}/advance`).set('Authorization', ids.auth).send({ toStageKey: 'silver' });

    const res = await request(app).get(`/api/candidates/${candidateId}/awards`).set('Authorization', ids.auth);

    expect(res.body.awards.map((row: { tier: string; earned: boolean }) => [row.tier, row.earned]))
      .toEqual([['bronze', true], ['silver', false]]);
  });

  it('never puts the verification token on the journey', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'gold');
    await advance(ids, pipelineId, 'diamond');
    const award = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId: ids.candidateId, tier: 'gold' } });

    const res = await journey(ids);

    expect(JSON.stringify(res.body)).not.toContain(award.verifyToken);
  });

  it('is refused to a caller who is not signed in', async () => {
    const ids = await seeded();
    const res = await request(app).get(`/api/candidates/${ids.candidateId}/awards`);
    expect(res.status).toBe(401);
  });
});

describe('erasing a candidate takes their badges with them', () => {
  beforeEach(async () => { await wipe(); });

  it('leaves no award behind', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'gold');
    await advance(ids, pipelineId, 'diamond');
    expect(await tiersHeld(ids.candidateId)).toEqual(['silver', 'gold', 'diamond']);

    await request(app).delete(`/api/candidates/${ids.candidateId}`).set('Authorization', ids.auth)
      .send({ reason: 'The candidate asked to be removed from our records.' });

    expect(await prisma.candidateAward.findMany({ where: { candidateId: ids.candidateId } })).toEqual([]);
  });
});
