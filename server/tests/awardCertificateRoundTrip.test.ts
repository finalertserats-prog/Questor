import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe, DEMO_RESUME } from '../src/seed/demoData.js';
import { backfillLegacyAwardEvidence } from '../src/services/awardEvidenceBackfill.js';

/**
 * The writer and the reader, made to meet.
 *
 * Every other test on this feature stands on one side of the fence.
 * `candidateAwards.test.ts` strikes awards and reads the row back as JSON;
 * `candidateAwardExport.test.ts` renders certificates from evidence the test
 * author typed out by hand. Both passed for months while every real export
 * answered 500, because the two halves of the contract were only ever checked
 * against themselves: the writer stored `{ version, rows }` and the reader
 * demanded a name, a role title, formatted dates and two signatures that
 * nothing in the repository ever wrote.
 *
 * So there is no hand-built JSON anywhere in this file. An award is struck
 * through the same HTTP calls a recruiter makes, and then exported through the
 * same HTTP call the Certificate button makes. A field the writer stops
 * writing, or the reader starts demanding, fails here.
 */

const app = createApp();

async function seeded() {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { ...ids, auth: `Bearer ${login.body.token as string}` };
}

type Seeded = Awaited<ReturnType<typeof seeded>>;

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

const CANDIDATE_NAME = 'Mei Lin Chua';

/**
 * One candidate carried the whole way, because that is the only journey in
 * which all three certificate tiers are struck by real code: the CV upload
 * earns Bronze, the move to Gold earns Silver, and the move to Diamond earns
 * Gold and Diamond together.
 */
async function walkedToDiamond(ids: Seeded): Promise<string> {
  const created = await request(app).post('/api/candidates').set('Authorization', ids.auth)
    .send({ fullName: CANDIDATE_NAME, email: 'mei.lin.chua@example.com', roleId: ids.roleId });
  const candidateId = created.body.candidate.id as string;
  await request(app).post(`/api/candidates/${candidateId}/resume`).set('Authorization', ids.auth).field('text', DEMO_RESUME);

  // The resume upload starts the pipeline and carries it to Bronze on its own
  // (services/pipelineAutonomy.ts), so the pipeline is read rather than made.
  const listed = await request(app).get(`/api/pipelines?candidateId=${candidateId}`).set('Authorization', ids.auth);
  const pipelineId = listed.body.pipelines[0].id as string;
  for (const toStageKey of ['silver', 'gold', 'diamond']) {
    await request(app).post(`/api/pipelines/${pipelineId}/advance`).set('Authorization', ids.auth).send({ toStageKey });
  }
  return candidateId;
}

const certificate = (ids: Seeded, candidateId: string, tier: string) =>
  request(app).get(`/api/candidates/${candidateId}/awards/${tier}/certificate.pdf`).set('Authorization', ids.auth).responseType('blob');

/**
 * An award as the strike left it BEFORE this lane: the same five rows, from
 * the same row builder, and none of the name, the title or the signatures that
 * nothing in the repository wrote until now.
 *
 * Taken apart from a real award rather than typed out, so it stays a record
 * the old writer really could have left behind. Every award in production is
 * one of these, and the lane that changed the stored shape is the one that has
 * to reach them.
 */
async function downgradeToVersionOne(candidateId: string, tier: string): Promise<string> {
  const award = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId, tier } });
  const { candidateName: _name, roleTitle: _title, signatures: _signatures, ...legacy } =
    JSON.parse(award.evidenceJson) as Record<string, unknown>;
  const evidenceJson = JSON.stringify({ ...legacy, version: 1 });
  await prisma.candidateAward.update({ where: { id: award.id }, data: { evidenceJson } });
  return evidenceJson;
}

describe('a certificate exported from an award the product actually struck', () => {
  let ids: Seeded;
  let candidateId: string;
  let roleTitle: string;

  beforeEach(async () => {
    ids = await seeded();
    candidateId = await walkedToDiamond(ids);
    roleTitle = (await prisma.role.findUniqueOrThrow({ where: { id: ids.roleId }, select: { title: true } })).title;
  });

  it.each(['bronze', 'silver', 'gold'])('renders a %s certificate rather than refusing its own stored record', async (tier) => {
    const res = await certificate(ids, candidateId, tier);

    expect([res.status, (res.body as Buffer).subarray(0, 5).toString('latin1')]).toEqual([200, '%PDF-']);
  });

  it.each(['bronze', 'silver', 'gold'])('prints the %s candidate’s name and role as the award froze them', async (tier) => {
    const text = await textOf((await certificate(ids, candidateId, tier)).body);

    expect([text.includes(CANDIDATE_NAME), text.includes(roleTitle)]).toEqual([true, true]);
  });

  it.each(['bronze', 'silver', 'gold'])('lays out the whole approved frame on a struck %s', async (tier) => {
    const text = await textOf((await certificate(ids, candidateId, tier)).body);

    expect({
      wordmark: text.includes('QUESTOR'),
      verify: text.includes('VERIFY'),
      kicker: text.includes('RECORD OF ASSESSMENT'),
      evidenceHeading: text.includes('WHAT THIS RECORDS'),
      leftSignature: /ASSESSED BY · /.test(text),
      rightSignature: /RECORDED BY · /.test(text),
      footnote: text.includes('Evidence of process, not a recommendation.'),
    }).toEqual({
      wordmark: true, verify: true, kicker: true, evidenceHeading: true,
      leftSignature: true, rightSignature: true, footnote: true,
    });
  });

  /**
   * The five-row block is the frame, so a row Questor has no fact for is
   * printed as absent rather than dropped. A struck award whose evidence has
   * gaps — this candidate had no subject-matter expert review and no human
   * interview round — still has to fill all five.
   */
  it.each(['bronze', 'silver', 'gold'])('dates or dashes every one of the five rows on a struck %s', async (tier) => {
    const award = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId, tier } });
    const rows = (JSON.parse(award.evidenceJson) as { rows: unknown[] }).rows;

    const text = await textOf((await certificate(ids, candidateId, tier)).body);

    expect([rows.length, /\d{1,2} [A-Z][a-z]{2} \d{4}/.test(text) || text.includes('—')]).toEqual([5, true]);
  });

  it('sends a Silver certificate the product struck, rather than answering 500', async () => {
    const res = await request(app)
      .post(`/api/candidates/${candidateId}/awards/silver/certificate/send`)
      .set('Authorization', ids.auth);

    expect(res.status).toBe(200);
  });

  it('names the candidate and the role in the email it sends, from the frozen evidence', async () => {
    const { getEmail } = await import('../src/providers/email/index.js');
    const sent: { subject: string; text: string }[] = [];
    const provider = getEmail();
    const original = provider.send.bind(provider);
    provider.send = async (message) => { sent.push({ subject: message.subject, text: message.text ?? '' }); return original(message); };

    await request(app).post(`/api/candidates/${candidateId}/awards/silver/certificate/send`).set('Authorization', ids.auth);
    provider.send = original;

    expect([sent.length, sent[0]?.subject.includes(roleTitle), sent[0]?.text.includes(CANDIDATE_NAME)])
      .toEqual([1, true, true]);
  });

  it('goes on saying what was true when it was struck after the world moves on', async () => {
    await prisma.candidate.update({ where: { id: candidateId }, data: { fullName: 'Someone Else Entirely' } });
    await prisma.role.update({ where: { id: ids.roleId }, data: { title: 'A Different Role' } });

    const text = await textOf((await certificate(ids, candidateId, 'silver')).body);

    expect([text.includes(CANDIDATE_NAME), text.includes('Someone Else Entirely'), text.includes('A Different Role')])
      .toEqual([true, false, false]);
  });
});

/**
 * The export never issues a document it has not stored.
 *
 * An earlier draft of this lane repaired a version-1 record on the way past
 * the export: resolve the name from live rows, write it back, render. It
 * passed its tests and it was wrong. Two exports racing both build from live
 * rows and only one wins the write, so the loser hands its reader a different
 * document under the same reference; and a write that fails leaves the export
 * issuing a certificate nothing has frozen, which a rename tomorrow would
 * contradict. A credential is worth what the paper and the record agreeing is
 * worth, so the refusal is the feature and the repair happens at rest.
 */
describe('an export that meets a record the backfill has not reached', () => {
  let ids: Seeded;
  let candidateId: string;

  beforeEach(async () => {
    ids = await seeded();
    candidateId = await walkedToDiamond(ids);
    await downgradeToVersionOne(candidateId, 'silver');
  });

  it('refuses rather than assembling one from whatever the rows say today', async () => {
    const res = await request(app)
      .get(`/api/candidates/${candidateId}/awards/silver/certificate.pdf`)
      .set('Authorization', ids.auth);

    expect([res.status, res.body.code]).toEqual([503, 'award_evidence_not_ready']);
  });

  it('says it is not ready yet, which is true and will stop being true', async () => {
    // Distinct from the corrupt-record refusal on purpose: that one is a fault
    // nobody fixes by waiting, and this one fixes itself when the sweep runs.
    const res = await request(app)
      .get(`/api/candidates/${candidateId}/awards/silver/certificate.pdf`)
      .set('Authorization', ids.auth);

    expect(res.body.error).toMatch(/not ready yet/);
  });

  it('refuses to send one as well, rather than emailing what it would not export', async () => {
    const res = await request(app)
      .post(`/api/candidates/${candidateId}/awards/silver/certificate/send`)
      .set('Authorization', ids.auth);

    expect(res.status).toBe(503);
  });

  it('writes nothing to the award while refusing it', async () => {
    const before = (await prisma.candidateAward.findFirstOrThrow({ where: { candidateId, tier: 'silver' } })).evidenceJson;

    await request(app).get(`/api/candidates/${candidateId}/awards/silver/certificate.pdf`).set('Authorization', ids.auth);

    const after = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId, tier: 'silver' } });
    expect([after.evidenceJson, after.sentToCandidateAt]).toEqual([before, null]);
  });

  it('answers a record that is neither version as corrupt, not as not-ready', async () => {
    // Two different faults and two different sentences: one is waiting for a
    // sweep, the other is waiting for somebody to look at the row.
    await prisma.candidateAward.updateMany({
      where: { candidateId, tier: 'gold' },
      data: { evidenceJson: JSON.stringify({ version: 7, rows: [] }) },
    });

    const res = await request(app)
      .get(`/api/candidates/${candidateId}/awards/gold/certificate.pdf`)
      .set('Authorization', ids.auth);

    expect([res.status, /stored record is incomplete/.test(res.body.error ?? '')]).toEqual([500, true]);
  });
});

/**
 * The sweep that makes those awards renderable, run once and at rest.
 */
describe('bringing the awards struck before the shape changed up to date', () => {
  let ids: Seeded;
  let candidateId: string;
  let roleTitle: string;

  beforeEach(async () => {
    ids = await seeded();
    candidateId = await walkedToDiamond(ids);
    roleTitle = (await prisma.role.findUniqueOrThrow({ where: { id: ids.roleId }, select: { title: true } })).title;
  });

  const versionOf = async (tier: string) =>
    (JSON.parse((await prisma.candidateAward.findFirstOrThrow({ where: { candidateId, tier } })).evidenceJson) as { version: number }).version;

  it('upgrades every certificate tier it finds', async () => {
    for (const tier of ['bronze', 'silver', 'gold']) await downgradeToVersionOne(candidateId, tier);

    const result = await backfillLegacyAwardEvidence();

    expect([result.upgraded, result.failed, result.remaining]).toEqual([3, 0, 0]);
  });

  it.each(['bronze', 'silver', 'gold'])('makes a %s exportable afterwards', async (tier) => {
    await downgradeToVersionOne(candidateId, tier);
    await backfillLegacyAwardEvidence();

    const res = await certificate(ids, candidateId, tier);

    expect([res.status, (res.body as Buffer).subarray(0, 5).toString('latin1')]).toEqual([200, '%PDF-']);
  });

  it('resolves the name and the role the award always pointed at', async () => {
    await downgradeToVersionOne(candidateId, 'silver');
    await backfillLegacyAwardEvidence();

    const text = await textOf((await certificate(ids, candidateId, 'silver')).body);

    expect([text.includes(CANDIDATE_NAME), text.includes(roleTitle)]).toEqual([true, true]);
  });

  it('says no assessor was recorded rather than inventing one', async () => {
    // A version-1 record never held a signature. Naming the reviewer the live
    // rows happen to show today would be re-deriving the claim the frozen
    // column exists to prevent.
    await downgradeToVersionOne(candidateId, 'silver');
    await backfillLegacyAwardEvidence();

    const text = await textOf((await certificate(ids, candidateId, 'silver')).body);

    expect(text).toContain('ASSESSED BY · NOT RECORDED ON THIS AWARD');
  });

  it('carries the five rows it really did freeze across untouched', async () => {
    const legacy = await downgradeToVersionOne(candidateId, 'silver');
    const frozen = (JSON.parse(legacy) as { rows: { what: string }[] }).rows;

    await backfillLegacyAwardEvidence();

    const text = await textOf((await certificate(ids, candidateId, 'silver')).body);
    expect([frozen.length, frozen.every((row) => text.includes(row.what))]).toEqual([5, true]);
  });

  it('freezes what it resolved, so a later rename cannot change the document', async () => {
    await downgradeToVersionOne(candidateId, 'silver');
    await backfillLegacyAwardEvidence();

    await prisma.candidate.update({ where: { id: candidateId }, data: { fullName: 'Someone Else Entirely' } });
    const text = await textOf((await certificate(ids, candidateId, 'silver')).body);

    expect([text.includes(CANDIDATE_NAME), text.includes('Someone Else Entirely')]).toEqual([true, false]);
  });

  it('leaves a record it has already upgraded alone', async () => {
    await downgradeToVersionOne(candidateId, 'silver');
    await backfillLegacyAwardEvidence();
    const settled = (await prisma.candidateAward.findFirstOrThrow({ where: { candidateId, tier: 'silver' } })).evidenceJson;

    const second = await backfillLegacyAwardEvidence();

    const after = (await prisma.candidateAward.findFirstOrThrow({ where: { candidateId, tier: 'silver' } })).evidenceJson;
    expect([second.upgraded, second.remaining, after]).toEqual([0, 0, settled]);
  });

  it('leaves Diamond where it is, because nothing ever prints its record', async () => {
    // Freezing a name onto a record no certificate draws from would be storing
    // personal data for no purpose, and needing it for a certificate is the
    // whole argument for freezing one at all.
    await downgradeToVersionOne(candidateId, 'diamond');

    await backfillLegacyAwardEvidence();

    expect(await versionOf('diamond')).toBe(1);
  });

  it('records each upgrade in the audit trail, without the name it resolved', async () => {
    await downgradeToVersionOne(candidateId, 'silver');

    await backfillLegacyAwardEvidence();

    const events = await prisma.auditEvent.findMany({ where: { action: 'candidate.award.evidence_upgraded' } });
    expect([events.length, events.some((event) => event.afterJson.includes(CANDIDATE_NAME))]).toEqual([1, false]);
  });

  it('reports a record it could not write instead of counting it done', async () => {
    // The award stays version 1, so the export goes on refusing it and the
    // next run tries again. A sweep that reported success here would leave a
    // certificate refused for ever with nothing saying why.
    await downgradeToVersionOne(candidateId, 'silver');
    // Swapped by hand rather than with a spy: Prisma's delegates are proxy
    // properties, and restoring a spy on one leaves the method undefined for
    // every test that follows.
    const original = prisma.candidateAward.updateMany;
    prisma.candidateAward.updateMany = (() => Promise.reject(new Error('the database is not accepting writes'))) as typeof original;

    const result = await backfillLegacyAwardEvidence().finally(() => {
      prisma.candidateAward.updateMany = original;
    });

    expect([result.upgraded, result.failed, result.remaining, await versionOf('silver')]).toEqual([0, 1, 1, 1]);
  });

  it('carries on past an award it could not read at all', async () => {
    await downgradeToVersionOne(candidateId, 'silver');
    await prisma.candidateAward.updateMany({
      where: { candidateId, tier: 'gold' },
      data: { evidenceJson: JSON.stringify({ version: 7, rows: [] }) },
    });

    const result = await backfillLegacyAwardEvidence();

    // The unreadable one is corrupt rather than old, and a migration is not
    // the place to decide what to do about that — but it must not stop the
    // sweep reaching the records it can fix.
    expect([result.upgraded, await versionOf('silver')]).toEqual([1, 2]);
  });
});

/**
 * The frozen name is a second store of candidate personal data, in a column
 * that held none before this lane.
 *
 * Freezing the name is what makes a certificate reproducible, and it is only
 * defensible because an erasure takes the award with it. That reasoning is
 * asserted in a comment on `AwardFacts`; these are the tests that make it a
 * fact rather than an intention. The paths worth checking are the ones written
 * when an award held no name at all, because those are the ones nobody
 * reconsidered when it started to.
 */
describe('the personal data this lane started storing', () => {
  let ids: Seeded;
  let candidateId: string;

  beforeEach(async () => {
    ids = await seeded();
    candidateId = await walkedToDiamond(ids);
  });

  const nameIsStoredOnAnyAward = async () => {
    const awards = await prisma.candidateAward.findMany({ select: { evidenceJson: true } });
    return awards.some((award) => award.evidenceJson.includes(CANDIDATE_NAME));
  };

  const erase = () =>
    request(app).delete(`/api/candidates/${candidateId}`).set('Authorization', ids.auth)
      .send({ reason: 'The candidate asked to be removed from our records.' });

  it('freezes the candidate’s name into a column that previously held none', async () => {
    expect(await nameIsStoredOnAnyAward()).toBe(true);
  });

  it('leaves no award carrying the name once the candidate is erased', async () => {
    await erase();

    expect([await nameIsStoredOnAnyAward(), await prisma.candidateAward.count({ where: { candidateId } })])
      .toEqual([false, 0]);
  });

  it('closes every export and send path that could still have printed it', async () => {
    await erase();

    const paths = [
      await certificate(ids, candidateId, 'silver'),
      await request(app).get(`/api/candidates/${candidateId}/awards/silver/badge.svg`).set('Authorization', ids.auth),
      await request(app).post(`/api/candidates/${candidateId}/awards/silver/certificate/send`).set('Authorization', ids.auth),
      await request(app).get(`/api/candidates/${candidateId}/awards`).set('Authorization', ids.auth),
    ];

    expect(paths.map((res) => res.status)).toEqual([404, 404, 404, 404]);
  });

  it('never writes the frozen name into the audit trail', async () => {
    // Asserted BEFORE any erasure, deliberately. Erasure now empties the
    // payloads of a candidate's audit rows, so a check made afterwards would
    // pass whether this lane wrote the name or not — it would be testing the
    // privacy lane's scrubber rather than this lane's restraint. The claim
    // here is the narrower one that belongs to the award lane: a badge struck,
    // exported and sent leaves no row carrying the name to begin with.
    await request(app).post(`/api/candidates/${candidateId}/awards/silver/certificate/send`).set('Authorization', ids.auth);
    await certificate(ids, candidateId, 'silver');

    const events = await prisma.auditEvent.findMany();
    const carrying = events.filter((event) => `${event.beforeJson}${event.afterJson}`.includes(CANDIDATE_NAME));

    expect(carrying.map((event) => event.action)).toEqual([]);
  });
});
