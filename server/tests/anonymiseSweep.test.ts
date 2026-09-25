import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import {
  anonymiseAfterDays,
  findCandidatesDueForAnonymisation,
  runAnonymisationSweep,
} from '../src/services/anonymise.js';
import { claimCandidateForAnonymisation } from '../src/services/anonymiseCascade.js';

/**
 * Anonymisation: keep the interview, sever the person.
 *
 * Questor keeps interviews because the interviews are the asset — they are what
 * quality and learning depend on. Keeping them forever with a name attached is
 * indefinite retention of personal data, whatever table it sits in. Removing
 * the person is what makes keeping them lawful: data that genuinely cannot be
 * traced to an individual is outside GDPR's scope.
 *
 * The property every test below exists to protect is IRREVERSIBILITY. If the
 * original identity can still be recovered — from a kept column, a mapping row,
 * an external id, a token the candidate holds — then this is pseudonymisation,
 * it is still personal data, and the word "anonymised" is a lie told with
 * confidence. The last test in this file is the one that matters most: it scans
 * every string column of every table for the person and expects to find none.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NAME = 'Priya Sharma';
const EMAIL = 'priya.sharma@example.com';
const PHONE = '+91 98765 43210';
const LINKEDIN = 'https://www.linkedin.com/in/priya-sharma-4417';
/** The id this person has in the customer's own ATS — a handle straight back to a named record. */
const ATS_ID = 'gh-88213';
/** Free text the candidate typed about themselves. No pattern we hold can find it. */
const REQUEST = 'I have a hearing impairment and will need captions throughout the interview, please.';
/** The candidate's own words for why they stopped an observed round. Same shape as REQUEST. */
const WITHDRAWAL = 'Stopping here, my medication makes the afternoons difficult and I cannot concentrate.';

const app = createApp();

const longAgo = () => new Date(Date.now() - (anonymiseAfterDays() + 1) * DAY_MS);
const recently = () => new Date(Date.now() - DAY_MS);

/**
 * The demo candidate, given the contact details a real one has, with an
 * interview that finished at `completedAt` and a transcript that says their
 * name out loud — which is what candidates do, unprompted, in the first turn.
 */
async function interviewedCandidate(completedAt: Date) {
  await wipe();
  const ids = await createDemoData();
  await prisma.candidate.update({
    where: { id: ids.candidateId },
    data: { phone: PHONE, linkedinUrl: LINKEDIN },
  });

  // Through the real endpoint, so the audit row and the consent record are the
  // ones production writes. A candidate accumulates history before their
  // interview, and that history is where the identity hides.
  await request(app).post(`/api/portal/${ids.token}/consent`).send({
    accepted: true, recordingConsent: true, accommodationRequest: REQUEST,
  });

  // The link into the customer's ATS: the clearest single route from an
  // anonymised row back to a named person.
  const connection = await prisma.atsConnection.create({
    data: { tenantId: ids.tenantId, provider: 'greenhouse', baseUrl: 'https://example.test', atsKey: 'ats-anonymise-fixture', status: 'ok' },
  });
  await prisma.candidateAtsLink.create({
    data: { tenantId: ids.tenantId, candidateId: ids.candidateId, connectionId: connection.id, externalCandidateId: ATS_ID },
  });

  // The calendar copy of this interview. It carries recipientName and
  // recipientEmail, is keyed by targetId with NO foreign key, and the session
  // it points at survives anonymisation by design. The scan could not see this
  // table because nothing seeded it.
  await prisma.calendarDelivery.create({
    data: {
      tenantId: ids.tenantId, targetType: 'interview', targetId: ids.sessionId,
      recipientEmail: EMAIL, recipientName: NAME, kind: 'booked', status: 'SENT',
    },
  });

  // A human round that was observed and that the candidate stopped, in their
  // own words. The pipeline is decided and the round completed long ago, or the
  // candidate would still have a live recruitment purpose and never be due.
  const pipeline = await prisma.candidatePipeline.create({
    data: {
      tenantId: ids.tenantId, candidateId: ids.candidateId, roleId: ids.roleId,
      stagesJson: '[]', currentStageKey: 'gold', status: 'DECIDED',
      decision: 'REJECTED', decidedAt: completedAt,
    },
  });
  const round = await prisma.interviewRound.create({
    data: {
      tenantId: ids.tenantId, pipelineId: pipeline.id, stageKey: 'gold',
      conductedBy: 'HUMAN', scheduledAt: completedAt, status: 'COMPLETED',
      completedAt,
    },
  });
  await prisma.roundObservation.create({
    data: {
      tenantId: ids.tenantId, roundId: round.id, candidateId: ids.candidateId,
      status: 'ENDED', noticeVersion: 'v1', interviewerId: ids.userId,
      stoppedBy: 'candidate', withdrawnReason: WITHDRAWAL,
    },
  });

  await prisma.interviewSession.update({
    where: { id: ids.sessionId },
    data: { state: 'COMPLETED', completedAt, legalHold: false },
  });
  await prisma.turn.createMany({
    data: [
      { sessionId: ids.sessionId, index: 0, speaker: 'agent', text: `Hello Priya, thanks for joining.` },
      { sessionId: ids.sessionId, index: 1, speaker: 'candidate', text: `I'm Priya Sharma — you can reach me on ${EMAIL} or 9876543210.` },
      { sessionId: ids.sessionId, index: 2, speaker: 'candidate', text: 'I cut p99 latency from 1200ms to 180ms by batching the writes and adding a covering index.' },
    ],
  });
  return ids;
}

async function candidateRow(id: string) {
  return prisma.candidate.findUniqueOrThrow({ where: { id } });
}

const original = process.env.ANONYMISE_AFTER_DAYS;
afterEach(() => {
  if (original === undefined) delete process.env.ANONYMISE_AFTER_DAYS;
  else process.env.ANONYMISE_AFTER_DAYS = original;
});

describe('the anonymisation window', () => {
  beforeEach(async () => { await wipe(); });

  it('is twelve months, long enough that a real hiring decision still works', () => {
    expect(anonymiseAfterDays()).toBe(365);
  });

  it('leaves an interview inside the window completely alone', async () => {
    const ids = await interviewedCandidate(recently());

    await runAnonymisationSweep(new Date());

    expect((await candidateRow(ids.candidateId)).fullName).toBe(NAME);
  });

  it('counts from the interview, so a candidate who comes back for another role starts the clock again', async () => {
    const ids = await interviewedCandidate(longAgo());
    // A second application on the same row, interviewed last week. The person
    // is plainly still in play; severing them now would be premature.
    await prisma.interviewSession.create({
      data: {
        tenantId: ids.tenantId, candidateId: ids.candidateId, roleId: ids.roleId, scorecardId: ids.scorecardId,
        state: 'COMPLETED', completedAt: recently(),
      },
    });

    expect(await findCandidatesDueForAnonymisation({ now: new Date() })).toEqual([]);
  });
});

describe('what anonymisation removes', () => {
  beforeEach(async () => { await wipe(); });

  it('severs the identity on the candidate row and records when', async () => {
    const ids = await interviewedCandidate(longAgo());

    await runAnonymisationSweep(new Date());

    const row = await candidateRow(ids.candidateId);
    expect({
      fullName: row.fullName, email: row.email, emailNormalized: row.emailNormalized,
      phone: row.phone, linkedinUrl: row.linkedinUrl, anonymised: row.anonymisedAt !== null,
    }).toEqual({ fullName: 'Anonymised candidate', email: '', emailNormalized: '', phone: '', linkedinUrl: '', anonymised: true });
  });

  it('takes the name and the contact details out of the transcript', async () => {
    const ids = await interviewedCandidate(longAgo());

    await runAnonymisationSweep(new Date());

    const said = (await prisma.turn.findFirstOrThrow({ where: { sessionId: ids.sessionId, index: 1 } })).text;
    expect(said).toBe("I'm [name] — you can reach me on [email] or [phone].");
  });

  it('keeps the answer that carries the learning value, which is the whole point of keeping the interview', async () => {
    const ids = await interviewedCandidate(longAgo());

    await runAnonymisationSweep(new Date());

    const answer = (await prisma.turn.findFirstOrThrow({ where: { sessionId: ids.sessionId, index: 2 } })).text;
    expect(answer).toBe('I cut p99 latency from 1200ms to 180ms by batching the writes and adding a covering index.');
  });

  it('keeps the interview itself, rather than deleting it as the retention sweep would', async () => {
    const ids = await interviewedCandidate(longAgo());

    await runAnonymisationSweep(new Date());

    expect(await prisma.interviewSession.count({ where: { id: ids.sessionId } })).toBe(1);
    expect(await prisma.turn.count({ where: { sessionId: ids.sessionId } })).toBe(3);
  });

  it('deletes the CV, which cannot be anonymised — it is dates, employers and schools all the way down', async () => {
    const ids = await interviewedCandidate(longAgo());

    await runAnonymisationSweep(new Date());

    expect(await prisma.candidateProfileVersion.count({ where: { candidateId: ids.candidateId } })).toBe(0);
  });

  it('deletes the link to the customer ATS, which is a mapping straight back to a named record', async () => {
    const ids = await interviewedCandidate(longAgo());
    expect(await prisma.candidateAtsLink.count({ where: { candidateId: ids.candidateId } })).toBe(1);

    await runAnonymisationSweep(new Date());

    expect(await prisma.candidateAtsLink.count({ where: { candidateId: ids.candidateId } })).toBe(0);
  });

  it('deletes the invitation, because a link in the candidate’s inbox still opens their interview', async () => {
    const ids = await interviewedCandidate(longAgo());

    await runAnonymisationSweep(new Date());

    expect(await prisma.invitation.count({ where: { sessionId: ids.sessionId } })).toBe(0);
  });

  it('deletes awards, whose printed reference is an identifier the candidate is holding on paper', async () => {
    const ids = await interviewedCandidate(longAgo());
    await prisma.candidateAward.create({
      data: {
        tenantId: ids.tenantId, candidateId: ids.candidateId, roleId: ids.roleId, tier: 'silver',
        reference: 'QS-SLV-8F2K-4471', verifyToken: 'tok-anonymise-test',
        evidenceJson: JSON.stringify({ version: 1, rows: [{ what: 'Interview conducted, transcript on record', when: null }] }),
      },
    });

    await runAnonymisationSweep(new Date());

    expect(await prisma.candidateAward.count({ where: { candidateId: ids.candidateId } })).toBe(0);
  });
});

describe('what anonymisation must never touch', () => {
  beforeEach(async () => { await wipe(); });

  it('never anonymises an interview under legal hold — the identity is what makes it evidence', async () => {
    const ids = await interviewedCandidate(longAgo());
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { legalHold: true } });

    await runAnonymisationSweep(new Date());

    expect((await candidateRow(ids.candidateId)).fullName).toBe(NAME);
  });

  it('never anonymises when a single file is held, matching how the retention sweep reads a hold', async () => {
    const ids = await interviewedCandidate(longAgo());
    await prisma.artifact.create({
      data: { tenantId: ids.tenantId, candidateId: ids.candidateId, kind: 'resume', legalHold: true },
    });

    await runAnonymisationSweep(new Date());

    expect((await candidateRow(ids.candidateId)).fullName).toBe(NAME);
  });

  it('leaves a candidate still moving through a pipeline alone, because they still have a recruitment purpose', async () => {
    // The fixture's pipeline, reopened: one application has one pipeline, so
    // this reuses it rather than adding a second.
    const ids = await interviewedCandidate(longAgo());
    await prisma.candidatePipeline.updateMany({
      where: { candidateId: ids.candidateId },
      data: { status: 'ACTIVE', decision: null, decidedAt: null, currentStageKey: 'silver' },
    });

    await runAnonymisationSweep(new Date());

    expect((await candidateRow(ids.candidateId)).fullName).toBe(NAME);
  });

  it('ages an application that never reached an interview from when it was created', async () => {
    // There is no interview to count from, and a name and address sitting on a
    // row nobody ever got to is personal data all the same.
    await wipe();
    const ids = await createDemoData();
    await prisma.invitation.deleteMany({ where: { sessionId: ids.sessionId } });
    await prisma.interviewPlanVersion.deleteMany({ where: { sessionId: ids.sessionId } });
    await prisma.interviewSession.deleteMany({ where: { candidateId: ids.candidateId } });
    await prisma.candidate.update({ where: { id: ids.candidateId }, data: { createdAt: longAgo() } });

    await runAnonymisationSweep(new Date());

    expect((await candidateRow(ids.candidateId)).fullName).toBe('Anonymised candidate');
  });

  it('does not anonymise the same candidate twice, so a re-run is free rather than destructive', async () => {
    const ids = await interviewedCandidate(longAgo());

    const first = await runAnonymisationSweep(new Date());
    const second = await runAnonymisationSweep(new Date());

    expect([first.candidatesAnonymised, second.candidatesAnonymised]).toEqual([1, 0]);
  });
});

describe('the record of an anonymisation', () => {
  beforeEach(async () => { await wipe(); });

  it('is audited, because you cannot demonstrate compliance with a change you did not record', async () => {
    const ids = await interviewedCandidate(longAgo());

    await runAnonymisationSweep(new Date());

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'candidate.anonymised', entityId: ids.candidateId },
    });
    expect(event.actorId).toBe('anonymisation-sweep');
  });

  it('holds no trace of who it was, or the audit trail would be the mapping table that undoes all of this', async () => {
    const ids = await interviewedCandidate(longAgo());

    await runAnonymisationSweep(new Date());

    const events = await prisma.auditEvent.findMany({ where: { entityId: ids.candidateId } });
    const written = events.map((e) => `${e.beforeJson} ${e.afterJson}`).join(' ');
    expect(written).not.toMatch(/Priya|Sharma|priya\.sharma|9876543210/i);
  });
});

/**
 * The test this lane exists for.
 *
 * Every other test here checks a place we remembered. This one checks the
 * places we did not: it walks every model in the schema, reads every row, and
 * looks at every string it finds for any spelling of the person. A leak in a
 * column nobody thought about is exactly how "anonymised" quietly becomes
 * "pseudonymised", and it is not something a hand-written list of tables can
 * ever catch.
 */
describe('irreversibility', () => {
  beforeEach(async () => { await wipe(); });

  /**
   * Everything that is a handle back to this person, not just their name.
   *
   * A name is the obvious one and the least dangerous. The address is this
   * system's own key for "the same human being"; the ATS id is a foreign key
   * into a system that still holds the name; and the accommodation request is
   * prose the candidate wrote about themselves that no pattern built from what
   * we hold could ever match — it has to be removed rather than scrubbed, and
   * this is what proves it was.
   */
  const HANDLES = [
    /priya|sharma/i,
    /priya\.sharma@example\.com/i,
    /9876543210|98765[\s-]?43210/,
    /linkedin\.com\/in\/priya/i,
    new RegExp(ATS_ID, 'i'),
    /hearing impairment|captions throughout/i,
    /medication makes the afternoons|cannot concentrate/i,
  ];

  /** Every string in every row of every model, and where it was found. */
  async function tracesOfTheCandidate(): Promise<string[]> {
    const client = prisma as unknown as Record<string, { findMany: () => Promise<Record<string, unknown>[]> }>;
    const traces = { test: (value: string) => HANDLES.some((h) => h.test(value)) };
    const found: string[] = [];
    for (const model of Prisma.dmmf.datamodel.models) {
      const accessor = model.name.charAt(0).toLowerCase() + model.name.slice(1);
      const rows = await client[accessor].findMany();
      for (const row of rows) {
        for (const [field, value] of Object.entries(row)) {
          if (typeof value === 'string' && traces.test(value)) found.push(`${model.name}.${field}`);
        }
      }
    }
    return [...new Set(found)].sort();
  }

  it('leaves no trace of the candidate anywhere in the database', async () => {
    await interviewedCandidate(longAgo());
    // The scan is only worth anything if it can fail. Before the sweep the same
    // walk must find the person in several places, or a green result below
    // would mean the scan is broken rather than the data clean.
    const before = await tracesOfTheCandidate();
    expect(before.length).toBeGreaterThan(3);

    await runAnonymisationSweep(new Date());

    expect(await tracesOfTheCandidate()).toEqual([]);
  });

  it.each([
    ['AuditEvent.afterJson', 'the table nothing else deletes'],
    ['CalendarDelivery.recipientEmail', 'a row with no foreign key, keyed to a session that survives'],
    ['RoundObservation.withdrawnReason', 'the candidate\u2019s own words for why they stopped'],
  ])('finds the candidate in %s before the sweep - %s', async (where) => {
    // A scan only catches what the fixture put in reach. It walked every model
    // and still could not see these three, because nothing seeded them - so it
    // stayed green while identity survived. Naming them individually means a
    // fixture that stops seeding one fails here rather than quietly narrowing
    // the scan back down.
    await interviewedCandidate(longAgo());

    expect(await tracesOfTheCandidate()).toContain(where);
  });

  it('finds the candidate in the audit log before the sweep, which is the leak this scan exists to catch', async () => {
    // Named separately because a scan that quietly stopped covering AuditEvent
    // would still pass the test above on the strength of the other tables. The
    // audit log is the table deliberately exempt from erasure and from the
    // retention sweep, which is exactly why identity survives there unnoticed.
    await interviewedCandidate(longAgo());

    expect(await tracesOfTheCandidate()).toContain('AuditEvent.afterJson');
  });
});

/**
 * The guard on the destructive work.
 *
 * Re-reading the hold inside the transaction narrows the window between check
 * and delete; it does not close it, because the read still happens before the
 * writes and nothing stops an administrator committing a hold in between. The
 * predicate therefore rides on a WRITE — the claim — so the database decides,
 * and the sweep runs Serializable so a hold committed after the claim aborts
 * the transaction rather than losing to it.
 */
describe('claiming a candidate', () => {
  beforeEach(async () => { await wipe(); });

  const eligible = (now: Date) => ({
    anonymisedAt: null,
    interviews: { none: { OR: [{ legalHold: true }, { artifacts: { some: { legalHold: true } } }] } },
    artifacts: { none: { legalHold: true } },
    pipelines: { none: { OR: [{ status: 'ACTIVE' }, { decidedAt: { gt: now } }] } },
  });

  it('refuses when a hold is in place, and changes nothing while refusing', async () => {
    const ids = await interviewedCandidate(longAgo());
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { legalHold: true } });

    const claim = await prisma.$transaction((tx) =>
      claimCandidateForAnonymisation(tx, { candidateId: ids.candidateId, now: new Date(), eligible: eligible(new Date()) }));

    expect(claim).toBeNull();
    expect((await candidateRow(ids.candidateId)).anonymisedAt).toBeNull();
  });

  it('can only be taken once, so two runs racing cannot both do the work', async () => {
    const ids = await interviewedCandidate(longAgo());
    const now = new Date();

    const first = await prisma.$transaction((tx) =>
      claimCandidateForAnonymisation(tx, { candidateId: ids.candidateId, now, eligible: eligible(now) }));
    const second = await prisma.$transaction((tx) =>
      claimCandidateForAnonymisation(tx, { candidateId: ids.candidateId, now, eligible: eligible(now) }));

    expect([first === null, second === null]).toEqual([false, true]);
  });

  it('hands back the identity it just took, so the work cannot be done without having claimed', async () => {
    const ids = await interviewedCandidate(longAgo());
    const now = new Date();

    const claim = await prisma.$transaction((tx) =>
      claimCandidateForAnonymisation(tx, { candidateId: ids.candidateId, now, eligible: eligible(now) }));

    // Asserted non-null first: `claim?.identity` against an object literal does
    // fail loudly when the claim is null, but it reads as though the comparison
    // is the point when what is actually being checked is that a claim happened
    // at all.
    expect(claim).not.toBeNull();
    expect(claim!.identity).toEqual({
      fullName: NAME, email: EMAIL, emailNormalized: EMAIL, phone: PHONE, linkedinUrl: LINKEDIN,
    });
  });
});
