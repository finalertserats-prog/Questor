import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { PEER_NOTES_WITHHELD } from '../src/domain/roundEvidence.js';

/**
 * Human interview rounds at Silver and Gold.
 *
 * The team books as many as it wants, each with its own date, its own
 * interviewer and its own record — the owner's "evidence all over the process".
 * Three things have to hold for that to be worth anything, and each is pinned
 * below: the rounds can actually be booked with a person conducting them, the
 * record names who wrote it, and two interviewers on the same candidate at the
 * same stage cannot read each other until the team has decided.
 */

const app = createApp();
const A_NOTES = 'Traced a production incident from the page to the post-mortem, naming what she would change.';
const B_NOTES = 'Talked through a schema migration she rolled back, and why the rollback was the right call.';

interface Seeded {
  readonly tenantId: string;
  readonly candidateId: string;
  readonly auth: string;
}

async function seeded(): Promise<Seeded> {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { tenantId: ids.tenantId, candidateId: ids.candidateId, auth: `Bearer ${login.body.token as string}` };
}

/** A recruiter in the same organisation: may schedule and conduct, may not decide. */
async function recruiter(tenantId: string, handle: string) {
  const user = await prisma.user.create({
    data: { tenantId, email: `${handle}@demo.local`, name: handle, passwordHash: 'x', role: 'recruiter' },
  });
  return { id: user.id, auth: `Bearer ${signToken({ userId: user.id, tenantId, role: 'recruiter', email: user.email })}` };
}

async function pipelineAt(auth: string, candidateId: string, stage: 'silver' | 'gold') {
  const created = await request(app).post('/api/pipelines').set('Authorization', auth).send({ candidateId });
  const id = created.body.pipeline.id as string;
  const path = stage === 'silver' ? ['bronze', 'silver'] : ['bronze', 'silver', 'gold'];
  for (const toStageKey of path) {
    await request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', auth).send({ toStageKey });
  }
  return id;
}

function book(auth: string, pipelineId: string, body: Record<string, unknown>) {
  return request(app).post(`/api/pipelines/${pipelineId}/rounds`).set('Authorization', auth).send(body);
}

function complete(auth: string, pipelineId: string, roundId: string, notes: string) {
  return request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/complete`).set('Authorization', auth).send({ notes });
}

interface RoundView {
  id: string;
  stageKey: string;
  conductedBy: string;
  aiObserver: boolean;
  hrMayObserve: boolean;
  notes: string;
  notesWithheld: string;
  panel: Array<{ userId: string; name: string; seat: string }>;
  recordedBy: { userId: string; name: string } | null;
  evidence: { kind: string; label: string; detail: string };
  evidenceEntries: Array<{ competencyId: string; competencyName: string; claim: string; quote: string }>;
}

async function roundsOf(auth: string, pipelineId: string): Promise<RoundView[]> {
  const res = await request(app).get(`/api/pipelines/${pipelineId}`).set('Authorization', auth);
  return res.body.pipeline.rounds as RoundView[];
}

describe('booking human rounds at Silver and Gold', () => {
  beforeEach(async () => { await wipe(); });

  it('books a person-conducted round at Silver, where the AI otherwise interviews', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'silver');

    const res = await book(ids.auth, pipelineId, {
      stageKey: 'silver', conductedBy: 'HUMAN', scheduledAt: '2026-10-06T09:00:00.000Z',
    });

    expect(res.body.round.conductedBy).toBe('HUMAN');
  });

  // A human round at the AI's stage is a human round, so it makes the human
  // round's promises: the AI may observe with both parties' agreement, and HR
  // gets no silent seat in a conversation nobody consented to.
  it('gives a human round at Silver the human round\'s promises, not the AI round\'s', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'silver');

    const res = await book(ids.auth, pipelineId, {
      stageKey: 'silver', conductedBy: 'HUMAN', scheduledAt: '2026-10-06T09:00:00.000Z',
    });

    expect(res.body.round).toMatchObject({ aiObserver: true, hrMayObserve: false });
  });

  it('still books the AI round at Silver when no conductor is named', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'silver');

    const res = await book(ids.auth, pipelineId, { stageKey: 'silver', scheduledAt: '2026-10-06T09:00:00.000Z' });

    expect(res.body.round.conductedBy).toBe('AI');
  });

  it('refuses an AI round at Gold, which nothing but a person conducts', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'gold');

    const res = await book(ids.auth, pipelineId, {
      stageKey: 'gold', conductedBy: 'AI', scheduledAt: '2026-10-08T09:00:00.000Z',
    });

    expect(res.status).toBe(409);
  });

  it('books several rounds at Gold, each on its own date', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'gold');
    await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z' });
    await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: '2026-10-12T09:00:00.000Z' });
    await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: '2026-10-15T09:00:00.000Z' });

    const rounds = await roundsOf(ids.auth, pipelineId);

    expect(rounds.map((r) => r.scheduledAt ?? '')).toHaveLength(3);
  });
});

describe('who conducts a round', () => {
  beforeEach(async () => { await wipe(); });

  it('names the Questor user conducting it, not only a typed name', async () => {
    const ids = await seeded();
    const sme = await recruiter(ids.tenantId, 'sme-one');
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'gold');

    const res = await book(ids.auth, pipelineId, {
      stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewerUserIds: [sme.id],
    });

    expect(res.body.round.panel).toEqual([expect.objectContaining({ userId: sme.id, seat: 'lead' })]);
  });

  it('makes the first person named the lead, whose name a certificate prints', async () => {
    const ids = await seeded();
    const lead = await recruiter(ids.tenantId, 'sme-lead');
    const second = await recruiter(ids.tenantId, 'sme-second');
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'gold');

    const res = await book(ids.auth, pipelineId, {
      stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewerUserIds: [lead.id, second.id],
    });

    const seats = (res.body.round.panel as RoundView['panel']).map((p) => [p.userId, p.seat]);
    expect(seats).toEqual([[lead.id, 'lead'], [second.id, 'panel']]);
  });

  // Booking someone to interview a candidate is what gives them the candidate:
  // an SME assigned a round they cannot open has not been assigned anything.
  it('gives the interviewer the candidate they are booked to interview', async () => {
    const ids = await seeded();
    const sme = await recruiter(ids.tenantId, 'sme-assigned');
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'gold');
    await book(ids.auth, pipelineId, {
      stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewerUserIds: [sme.id],
    });

    const res = await request(app).get(`/api/pipelines/${pipelineId}`).set('Authorization', sme.auth);

    expect(res.status).toBe(200);
  });

  it('refuses an interviewer from another organisation', async () => {
    const ids = await seeded();
    const otherTenant = await prisma.tenant.create({ data: { name: 'Other Org', region: 'in' } });
    const outsider = await prisma.user.create({
      data: { tenantId: otherTenant.id, email: 'outsider@other.local', name: 'Outsider', passwordHash: 'x', role: 'recruiter' },
    });
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'gold');

    const res = await book(ids.auth, pipelineId, {
      stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewerUserIds: [outsider.id],
    });

    expect(res.status).toBe(400);
  });

  it('books no round at all when one of the interviewers is not bookable', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'gold');
    await book(ids.auth, pipelineId, {
      stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewerUserIds: ['no-such-user'],
    });

    expect(await roundsOf(ids.auth, pipelineId)).toHaveLength(0);
  });
});

describe('the record a round leaves', () => {
  beforeEach(async () => { await wipe(); });

  it('names the person who wrote it', async () => {
    const ids = await seeded();
    const sme = await recruiter(ids.tenantId, 'sme-writer');
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'gold');
    const booked = await book(ids.auth, pipelineId, {
      stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewerUserIds: [sme.id],
    });
    await complete(sme.auth, pipelineId, booked.body.round.id, A_NOTES);

    const [round] = await roundsOf(ids.auth, pipelineId);

    expect(round.recordedBy).toMatchObject({ userId: sme.id });
  });

  // A round with no transcript must not be presented as though it had one; the
  // certificate reads this field to decide what it is allowed to claim.
  it('says the record is the interviewer\'s own account when nobody agreed to an observer', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'gold');
    const booked = await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z' });
    await complete(ids.auth, pipelineId, booked.body.round.id, A_NOTES);

    const [round] = await roundsOf(ids.auth, pipelineId);

    expect(round.evidence.kind).toBe('notes');
  });

  it('says nothing is recorded for a round still to happen', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'gold');
    await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z' });

    const [round] = await roundsOf(ids.auth, pipelineId);

    expect(round.evidence.kind).toBe('none');
  });

  it('records that the writer had no peer round in front of them', async () => {
    const ids = await seeded();
    const sme = await recruiter(ids.tenantId, 'sme-blind');
    const other = await recruiter(ids.tenantId, 'sme-other');
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'gold');
    const theirs = await book(ids.auth, pipelineId, {
      stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewerUserIds: [sme.id],
    });
    const peers = await book(ids.auth, pipelineId, {
      stageKey: 'gold', scheduledAt: '2026-10-09T09:00:00.000Z', interviewerUserIds: [other.id],
    });
    await complete(other.auth, pipelineId, peers.body.round.id, B_NOTES);
    await complete(sme.auth, pipelineId, theirs.body.round.id, A_NOTES);

    const saved = await prisma.interviewRound.findUniqueOrThrow({ where: { id: theirs.body.round.id as string } });

    expect(saved.peerNotesSeenBefore).toBe(false);
  });
});

describe('two interviewers on one candidate at one stage', () => {
  beforeEach(async () => { await wipe(); });

  interface Pair {
    readonly pipelineId: string;
    readonly a: { id: string; auth: string };
    readonly b: { id: string; auth: string };
    readonly roundA: string;
    readonly roundB: string;
    readonly hr: string;
  }

  /** Two SMEs, one Gold round each, A's round completed. */
  async function pair(): Promise<Pair> {
    const ids = await seeded();
    const a = await recruiter(ids.tenantId, 'sme-a');
    const b = await recruiter(ids.tenantId, 'sme-b');
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'gold');
    const bookedA = await book(ids.auth, pipelineId, {
      stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewerUserIds: [a.id],
    });
    const bookedB = await book(ids.auth, pipelineId, {
      stageKey: 'gold', scheduledAt: '2026-10-09T09:00:00.000Z', interviewerUserIds: [b.id],
    });
    const roundA = bookedA.body.round.id as string;
    await complete(a.auth, pipelineId, roundA, A_NOTES);
    return { pipelineId, a, b, roundA, roundB: bookedB.body.round.id as string, hr: ids.auth };
  }

  it('withholds the first interviewer\'s record from the second', async () => {
    const p = await pair();

    const rounds = await roundsOf(p.b.auth, p.pipelineId);

    expect(rounds.find((r) => r.id === p.roundA)?.notes).toBe('');
  });

  it('says why it is withheld rather than looking like an empty round', async () => {
    const p = await pair();

    const rounds = await roundsOf(p.b.auth, p.pipelineId);

    expect(rounds.find((r) => r.id === p.roundA)?.notesWithheld).toBe(PEER_NOTES_WITHHELD);
  });

  it('lets each interviewer read their own round', async () => {
    const p = await pair();

    const rounds = await roundsOf(p.a.auth, p.pipelineId);

    expect(rounds.find((r) => r.id === p.roundA)?.notes).toBe(A_NOTES);
  });

  it('shows both records to the person who decides', async () => {
    const p = await pair();
    await complete(p.b.auth, p.pipelineId, p.roundB, B_NOTES);

    const rounds = await roundsOf(p.hr, p.pipelineId);

    expect(rounds.map((r) => r.notes).sort()).toEqual([A_NOTES, B_NOTES].sort());
  });

  it('opens once the team has moved the candidate on', async () => {
    const p = await pair();
    await request(app).post(`/api/pipelines/${p.pipelineId}/advance`).set('Authorization', p.hr).send({ toStageKey: 'diamond' });

    const rounds = await roundsOf(p.b.auth, p.pipelineId);

    expect(rounds.find((r) => r.id === p.roundA)?.notes).toBe(A_NOTES);
  });

  // The transcript is the same evidence by another route. A gate that covered
  // only the notes would be a gate with a door beside it.
  it('withholds the first interviewer\'s transcript from the second as well', async () => {
    const p = await pair();

    const res = await request(app).get(`/api/observer/rounds/${p.roundA}`).set('Authorization', p.b.auth);

    expect(res.status).toBe(403);
  });

  it('lets the second interviewer open the observer on their own round', async () => {
    const p = await pair();

    const res = await request(app).get(`/api/observer/rounds/${p.roundB}`).set('Authorization', p.b.auth);

    expect(res.status).toBe(200);
  });
});

describe('who may record what a round showed', () => {
  beforeEach(async () => { await wipe(); });

  /**
   * A real subject-matter expert, as capabilities.ts ships one: they hold
   * `sme:assigned_read` and `sme:review` and nothing else — not
   * `candidate:read`, not `interview:schedule`. Every assertion below is about
   * that account, not a stand-in with a friendlier capability list.
   */
  async function expert(tenantId: string, handle: string) {
    const user = await prisma.user.create({
      data: { tenantId, email: `${handle}@demo.local`, name: handle, passwordHash: 'x', role: 'sme' },
    });
    return { id: user.id, auth: `Bearer ${signToken({ userId: user.id, tenantId, role: 'sme', email: user.email })}` };
  }

  async function roundFor(ids: Seeded, sme: { id: string }) {
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'gold');
    const booked = await book(ids.auth, pipelineId, {
      stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewerUserIds: [sme.id],
    });
    return { pipelineId, roundId: booked.body.round.id as string };
  }

  // The point of the lane. An expert is asked to conduct one round; scheduling
  // is not theirs and neither is the candidate list. A round only a scheduler
  // could close would leave the person who ran it unable to record what they
  // saw.
  it('lets the expert who conducted the round record it', async () => {
    const ids = await seeded();
    const sme = await expert(ids.tenantId, 'sme-conductor');
    const { pipelineId, roundId } = await roundFor(ids, sme);

    const res = await complete(sme.auth, pipelineId, roundId, A_NOTES);

    expect(res.status).toBe(200);
  });

  it('names them on the record they wrote', async () => {
    const ids = await seeded();
    const sme = await expert(ids.tenantId, 'sme-named');
    const { pipelineId, roundId } = await roundFor(ids, sme);
    await complete(sme.auth, pipelineId, roundId, A_NOTES);

    const [round] = await roundsOf(ids.auth, pipelineId);

    expect(round.recordedBy?.userId).toBe(sme.id);
  });

  it('gives them the scorecard their record is filed against', async () => {
    const ids = await seeded();
    const sme = await expert(ids.tenantId, 'sme-scorecard');
    const { pipelineId } = await roundFor(ids, sme);

    const res = await request(app).get(`/api/pipelines/${pipelineId}/competencies`).set('Authorization', sme.auth);

    expect(res.status).toBe(200);
  });

  it('lets them file claims against it', async () => {
    const ids = await seeded();
    const sme = await expert(ids.tenantId, 'sme-files');
    const { pipelineId, roundId } = await roundFor(ids, sme);
    const listed = await request(app).get(`/api/pipelines/${pipelineId}/competencies`).set('Authorization', sme.auth);
    const [first] = listed.body.competencies as Array<{ id: string }>;

    const res = await request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/complete`)
      .set('Authorization', sme.auth)
      .send({ notes: A_NOTES, evidence: [{ competencyId: first.id, claim: 'Owned the incident end to end.', quote: 'I paged myself at 2am and ran it.' }] });

    expect(res.status).toBe(200);
  });

  // The seat reaches this lane and nothing else. Their view of the candidate
  // arrives through /api/sme, which has its own assignment and capability.
  it('does not open the candidate\u2019s pipeline to them', async () => {
    const ids = await seeded();
    const sme = await expert(ids.tenantId, 'sme-no-pipeline');
    const { pipelineId } = await roundFor(ids, sme);

    const res = await request(app).get(`/api/pipelines/${pipelineId}`).set('Authorization', sme.auth);

    expect(res.status).toBe(403);
  });

  // The hazard services/access.ts documents: a CandidateAssignment outlives a
  // role change, so a row minted for an expert would still be there on the day
  // their account was re-roled to recruiter, silently handing them the full
  // candidate scope over someone they had only been asked to advise on.
  it('mints no candidate assignment for an expert, which a later role change would inherit', async () => {
    const ids = await seeded();
    const sme = await expert(ids.tenantId, 'sme-no-grant');
    await roundFor(ids, sme);

    const rows = await prisma.candidateAssignment.count({ where: { userId: sme.id } });

    expect(rows).toBe(0);
  });

  it('still gives the candidate to a colleague who works in candidate scope', async () => {
    const ids = await seeded();
    const colleague = await recruiter(ids.tenantId, 'recruiter-seated');
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'gold');
    await book(ids.auth, pipelineId, {
      stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewerUserIds: [colleague.id],
    });

    const res = await request(app).get(`/api/pipelines/${pipelineId}`).set('Authorization', colleague.auth);

    expect(res.status).toBe(200);
  });

  // A colleague entitled to the candidate but not in the room has nothing
  // first-hand to record, and a record they wrote would be attributed to them
  // as though they had been there.
  it('refuses an expert who was never seated on the round', async () => {
    const ids = await seeded();
    const sme = await expert(ids.tenantId, 'sme-in-room');
    const bystander = await expert(ids.tenantId, 'sme-bystander');
    const { pipelineId, roundId } = await roundFor(ids, sme);

    const res = await complete(bystander.auth, pipelineId, roundId, A_NOTES);

    expect(res.status).toBe(404);
  });

  // The sharp case. Being seated on ONE round reaches the pipeline, so the
  // per-round seat check is the only thing standing between an expert and
  // writing the record of a colleague's round — which would put their account
  // on evidence for a conversation they were not in, and is the same anchoring
  // problem the peer quarantine exists to prevent, from the writing end.
  it('refuses an expert closing a peer round at the same stage, though they are seated on their own', async () => {
    const ids = await seeded();
    const a = await expert(ids.tenantId, 'sme-peer-a');
    const b = await expert(ids.tenantId, 'sme-peer-b');
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'gold');
    const roundA = await book(ids.auth, pipelineId, {
      stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewerUserIds: [a.id],
    });
    await book(ids.auth, pipelineId, {
      stageKey: 'gold', scheduledAt: '2026-10-09T09:00:00.000Z', interviewerUserIds: [b.id],
    });

    const res = await complete(b.auth, pipelineId, roundA.body.round.id as string, A_NOTES);

    expect(res.status).toBe(403);
  });

  it('leaves that peer round open and unattributed', async () => {
    const ids = await seeded();
    const a = await expert(ids.tenantId, 'sme-peer-c');
    const b = await expert(ids.tenantId, 'sme-peer-d');
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'gold');
    const roundA = await book(ids.auth, pipelineId, {
      stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewerUserIds: [a.id],
    });
    await book(ids.auth, pipelineId, {
      stageKey: 'gold', scheduledAt: '2026-10-09T09:00:00.000Z', interviewerUserIds: [b.id],
    });
    await complete(b.auth, pipelineId, roundA.body.round.id as string, A_NOTES);

    const saved = await prisma.interviewRound.findUniqueOrThrow({ where: { id: roundA.body.round.id as string } });

    expect([saved.status, saved.recordedByUserId]).toEqual(['SCHEDULED', null]);
  });

  it('still lets a recruiter who schedules rounds close one they did not conduct', async () => {
    const ids = await seeded();
    const sme = await expert(ids.tenantId, 'sme-elsewhere');
    const { pipelineId, roundId } = await roundFor(ids, sme);

    const res = await complete(ids.auth, pipelineId, roundId, A_NOTES);

    expect(res.status).toBe(200);
  });

  it('refuses an auditor, who holds neither capability', async () => {
    const ids = await seeded();
    const sme = await expert(ids.tenantId, 'sme-audited');
    const { pipelineId, roundId } = await roundFor(ids, sme);
    const user = await prisma.user.create({
      data: { tenantId: ids.tenantId, email: 'auditor@demo.local', name: 'Auditor', passwordHash: 'x', role: 'auditor' },
    });
    const auth = `Bearer ${signToken({ userId: user.id, tenantId: ids.tenantId, role: 'auditor', email: user.email })}`;

    const res = await complete(auth, pipelineId, roundId, A_NOTES);

    expect(res.status).toBe(403);
  });
});

describe('the structured record a round leaves', () => {
  beforeEach(async () => { await wipe(); });

  async function competencies(auth: string, pipelineId: string) {
    const res = await request(app).get(`/api/pipelines/${pipelineId}/competencies`).set('Authorization', auth);
    return res.body.competencies as Array<{ id: string; name: string }>;
  }

  async function goldRound(ids: Seeded) {
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'gold');
    const booked = await book(ids.auth, pipelineId, { stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z' });
    return { pipelineId, roundId: booked.body.round.id as string };
  }

  const CLAIM = 'Owned the incident end to end.';
  const QUOTE = 'I paged myself at 2am and ran it.';

  function closeWith(ids: Seeded, pipelineId: string, roundId: string, evidence: unknown) {
    return request(app).post(`/api/pipelines/${pipelineId}/rounds/${roundId}/complete`)
      .set('Authorization', ids.auth).send({ notes: A_NOTES, evidence });
  }

  it('offers the interviewer the competencies the role is assessed on', async () => {
    const ids = await seeded();
    const { pipelineId } = await goldRound(ids);

    expect((await competencies(ids.auth, pipelineId)).length).toBeGreaterThan(0);
  });

  it('records a claim with the words it rests on', async () => {
    const ids = await seeded();
    const { pipelineId, roundId } = await goldRound(ids);
    const [first] = await competencies(ids.auth, pipelineId);
    await closeWith(ids, pipelineId, roundId, [{ competencyId: first.id, claim: CLAIM, quote: QUOTE }]);

    const [round] = await roundsOf(ids.auth, pipelineId);

    expect(round.evidenceEntries).toEqual([expect.objectContaining({ competencyName: first.name, quote: QUOTE })]);
  });

  it('calls that round a structured record rather than a written account', async () => {
    const ids = await seeded();
    const { pipelineId, roundId } = await goldRound(ids);
    const [first] = await competencies(ids.auth, pipelineId);
    await closeWith(ids, pipelineId, roundId, [{ competencyId: first.id, claim: CLAIM, quote: QUOTE }]);

    const [round] = await roundsOf(ids.auth, pipelineId);

    expect(round.evidence.kind).toBe('structured');
  });

  // The honesty the certificate depends on: a typed quote is the interviewer's
  // recollection, and nothing in the product may let it read as a recording.
  it('never lets a typed quote read as a recording', async () => {
    const ids = await seeded();
    const { pipelineId, roundId } = await goldRound(ids);
    const [first] = await competencies(ids.auth, pipelineId);
    await closeWith(ids, pipelineId, roundId, [{ competencyId: first.id, claim: CLAIM, quote: QUOTE }]);

    const [round] = await roundsOf(ids.auth, pipelineId);

    expect(round.evidence.detail).toContain('not a recording of it');
  });

  it('refuses a quote that merely repeats the claim', async () => {
    const ids = await seeded();
    const { pipelineId, roundId } = await goldRound(ids);
    const [first] = await competencies(ids.auth, pipelineId);

    const res = await closeWith(ids, pipelineId, roundId, [{ competencyId: first.id, claim: CLAIM, quote: CLAIM }]);

    expect(res.status).toBe(400);
  });

  it('leaves the round open when its record was refused', async () => {
    const ids = await seeded();
    const { pipelineId, roundId } = await goldRound(ids);
    const [first] = await competencies(ids.auth, pipelineId);
    await closeWith(ids, pipelineId, roundId, [{ competencyId: first.id, claim: CLAIM, quote: CLAIM }]);

    const [round] = await roundsOf(ids.auth, pipelineId);

    expect(round.status).toBe('SCHEDULED');
  });

  it('refuses a competency the role is not assessed on', async () => {
    const ids = await seeded();
    const { pipelineId, roundId } = await goldRound(ids);

    const res = await closeWith(ids, pipelineId, roundId, [{ competencyId: 'invented-by-the-client', claim: CLAIM, quote: QUOTE }]);

    expect(res.status).toBe(400);
  });

  // A role with no approved scorecard has no competencies to file under, and a
  // round conducted for it must still be closeable.
  it('still closes a round with prose alone', async () => {
    const ids = await seeded();
    const { pipelineId, roundId } = await goldRound(ids);
    await complete(ids.auth, pipelineId, roundId, A_NOTES);

    const [round] = await roundsOf(ids.auth, pipelineId);

    expect(round.evidence.kind).toBe('notes');
  });

  it('withholds the quotes from a peer interviewer along with the prose', async () => {
    const ids = await seeded();
    const a = await recruiter(ids.tenantId, 'sme-quote-a');
    const b = await recruiter(ids.tenantId, 'sme-quote-b');
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'gold');
    const bookedA = await book(ids.auth, pipelineId, {
      stageKey: 'gold', scheduledAt: '2026-10-08T09:00:00.000Z', interviewerUserIds: [a.id],
    });
    await book(ids.auth, pipelineId, {
      stageKey: 'gold', scheduledAt: '2026-10-09T09:00:00.000Z', interviewerUserIds: [b.id],
    });
    const [first] = await competencies(ids.auth, pipelineId);
    await request(app).post(`/api/pipelines/${pipelineId}/rounds/${bookedA.body.round.id as string}/complete`)
      .set('Authorization', a.auth)
      .send({ notes: A_NOTES, evidence: [{ competencyId: first.id, claim: CLAIM, quote: QUOTE }] });

    const rounds = await roundsOf(b.auth, pipelineId);

    expect(rounds.find((r) => r.id === bookedA.body.round.id)?.evidenceEntries).toEqual([]);
  });

  it('clears the quotes when retention clears the round', async () => {
    const ids = await seeded();
    const { pipelineId, roundId } = await goldRound(ids);
    const [first] = await competencies(ids.auth, pipelineId);
    await closeWith(ids, pipelineId, roundId, [{ competencyId: first.id, claim: CLAIM, quote: QUOTE }]);
    // What the retention sweep does to the row (services/dataRights.ts).
    await prisma.interviewRound.update({ where: { id: roundId }, data: { notes: '', evidenceJson: '[]' } });

    const [round] = await roundsOf(ids.auth, pipelineId);

    expect(round.evidenceEntries).toEqual([]);
  });
});

describe('the stage summary', () => {
  beforeEach(async () => { await wipe(); });

  // A team that puts an SME in the room at Silver has evidence for Silver, and
  // being told it has none would say the round it ran does not count.
  it('counts a completed human round at Silver as evidence for Silver', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'silver');
    const booked = await book(ids.auth, pipelineId, {
      stageKey: 'silver', conductedBy: 'HUMAN', scheduledAt: '2026-10-06T09:00:00.000Z',
    });
    await complete(ids.auth, pipelineId, booked.body.round.id, A_NOTES);

    const res = await request(app).get(`/api/pipelines/${pipelineId}/summary`).set('Authorization', ids.auth);
    const silver = (res.body.summary.stages as Array<{ key: string; hasEvidence: boolean }>).find((s) => s.key === 'silver');

    expect(silver?.hasEvidence).toBe(true);
  });

  it('still says the AI interview has not been assessed', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids.auth, ids.candidateId, 'silver');
    const booked = await book(ids.auth, pipelineId, {
      stageKey: 'silver', conductedBy: 'HUMAN', scheduledAt: '2026-10-06T09:00:00.000Z',
    });
    await complete(ids.auth, pipelineId, booked.body.round.id, A_NOTES);

    const res = await request(app).get(`/api/pipelines/${pipelineId}/summary`).set('Authorization', ids.auth);
    const silver = (res.body.summary.stages as Array<{ key: string; detail: string }>).find((s) => s.key === 'silver');

    expect(silver?.detail).toContain('No assessed AI interview yet');
  });
});

describe('what the candidate can see of a human round', () => {
  beforeEach(async () => { await wipe(); });

  // The notes are written ABOUT the candidate, for the hiring team. The status
  // page is the one surface they reach, so it is the one that has to be pinned.
  it('never carries what an interviewer recorded', async () => {
    await wipe();
    const ids = await createDemoData();
    const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
    const auth = `Bearer ${login.body.token as string}`;
    const pipelineId = await pipelineAt(auth, ids.candidateId, 'gold');
    const booked = await book(auth, pipelineId, { stageKey: 'gold', scheduledAt: '2036-10-08T09:00:00.000Z' });
    await complete(auth, pipelineId, booked.body.round.id, A_NOTES);

    const res = await request(app).get(`/api/portal/${ids.token}/status`);

    expect(JSON.stringify(res.body)).not.toContain('post-mortem');
  });
});
