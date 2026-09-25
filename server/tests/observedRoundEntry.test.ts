import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * The entry gate, end to end.
 *
 * Two questions, and the second is the one that matters. First: can a
 * subject-matter expert conduct a round that is recorded, holding nothing but
 * `observer:attend` on top of their own two grants — and is that capability
 * still useless for anything else? Second, and the whole weight of the design
 * now rests on it because there is no unrecorded fallback: is there ANY route
 * by which capture begins without an affirmative consent from every person
 * whose voice it captures?
 *
 * The second question is answered by trying each route a person could actually
 * arrive on rather than only the one the room uses: a direct URL, a rejoin, a
 * link opened after somebody declined, an HR user coming from another page,
 * and a colleague who is nobody here at all.
 */

const app = createApp();
const ROUND_AT = '2026-10-08T09:00:00.000Z';

interface Seeded {
  readonly tenantId: string;
  readonly candidateId: string;
  readonly userId: string;
  readonly auth: string;
}

async function seeded(): Promise<Seeded> {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { tenantId: ids.tenantId, candidateId: ids.candidateId, userId: ids.userId, auth: `Bearer ${login.body.token as string}` };
}

async function userWithRole(tenantId: string, role: string, handle: string) {
  const user = await prisma.user.create({
    data: { tenantId, email: `${handle}@demo.local`, name: handle, passwordHash: 'x', role },
  });
  return { id: user.id, auth: `Bearer ${signToken({ userId: user.id, tenantId, role, email: user.email })}` };
}

async function pipelineAtGold(auth: string, candidateId: string) {
  const created = await request(app).post('/api/pipelines').set('Authorization', auth).send({ candidateId });
  const id = created.body.pipeline.id as string;
  for (const toStageKey of ['bronze', 'silver', 'gold']) {
    await request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', auth).send({ toStageKey });
  }
  return id;
}

/** A Gold round conducted by `interviewerUserIds`, with the expert seated on it. */
async function seatedRound(ids: Seeded, interviewerUserIds: string[]) {
  const pipelineId = await pipelineAtGold(ids.auth, ids.candidateId);
  const res = await request(app).post(`/api/pipelines/${pipelineId}/rounds`).set('Authorization', ids.auth)
    .send({ stageKey: 'gold', scheduledAt: ROUND_AT, interviewerUserIds });
  return { pipelineId, roundId: res.body.round.id as string };
}

/** The expert's own assignment, which is what /api/sme scopes on. */
async function assignSme(candidateId: string, userId: string) {
  await prisma.candidateAssignment.create({ data: { candidateId, userId, relation: 'sme' } });
}

function room(auth: string, roundId: string) {
  return request(app).get(`/api/observer/rounds/${roundId}`).set('Authorization', auth);
}

function post(auth: string, roundId: string, path: string) {
  return request(app).post(`/api/observer/rounds/${roundId}/${path}`).set('Authorization', auth).send({});
}

function speak(auth: string, roundId: string, text = 'A sentence somebody said in the room.') {
  return request(app).post(`/api/observer/rounds/${roundId}/segments`).set('Authorization', auth)
    .send({ text, offsetMs: 0, durationMs: 1000 });
}

function tokenOf(body: { observation?: { candidateLink?: string | null } }): string {
  return (body.observation?.candidateLink ?? '').split('/').pop() ?? '';
}

// ---------------------------------------------------------------------------

describe('a subject-matter expert conducting a recorded round', () => {
  beforeEach(async () => { await wipe(); });

  it('lets the expert open the room of a round they are seated on', async () => {
    const ids = await seeded();
    const sme = await userWithRole(ids.tenantId, 'sme', 'expert-one');
    const { roundId } = await seatedRound(ids, [sme.id]);
    await assignSme(ids.candidateId, sme.id);

    const res = await room(sme.auth, roundId);

    expect(res.status).toBe(200);
    expect(res.body.you.party).toBe('interviewer');
  });

  it('lets the expert agree to be recorded and be captured in their own round', async () => {
    const ids = await seeded();
    const sme = await userWithRole(ids.tenantId, 'sme', 'expert-two');
    const { roundId } = await seatedRound(ids, [sme.id]);
    const gate = await post(sme.auth, roundId, 'consent');
    await request(app).post(`/api/observer-consent/${tokenOf(gate.body)}/consent`).send({});
    await post(sme.auth, roundId, 'join');

    const res = await speak(sme.auth, roundId);

    expect(res.status).toBe(201);
  });

  // The narrowness of the capability, tested as the absence of everything else
  // rather than trusted to the map. `observer:attend` must not be a way into
  // scheduling, booking, or moving a candidate between stages.
  it('does not let the expert book a round', async () => {
    const ids = await seeded();
    const sme = await userWithRole(ids.tenantId, 'sme', 'expert-three');
    const { pipelineId } = await seatedRound(ids, [sme.id]);

    const res = await request(app).post(`/api/pipelines/${pipelineId}/rounds`).set('Authorization', sme.auth)
      .send({ stageKey: 'gold', scheduledAt: ROUND_AT });

    expect(res.status).toBe(403);
  });

  it('does not let the expert move the candidate between stages', async () => {
    const ids = await seeded();
    const sme = await userWithRole(ids.tenantId, 'sme', 'expert-four');
    const { pipelineId } = await seatedRound(ids, [sme.id]);

    const res = await request(app).post(`/api/pipelines/${pipelineId}/advance`).set('Authorization', sme.auth)
      .send({ toStageKey: 'diamond' });

    expect(res.status).toBe(403);
  });

  it('does not let the expert read the pipeline the round sits on', async () => {
    const ids = await seeded();
    const sme = await userWithRole(ids.tenantId, 'sme', 'expert-five');
    const { pipelineId } = await seatedRound(ids, [sme.id]);

    const res = await request(app).get(`/api/pipelines/${pipelineId}`).set('Authorization', sme.auth);

    expect(res.status).toBe(403);
  });

  // The seat is the object scope, so a round they are not seated on is not
  // theirs — even for a candidate they were assigned.
  it('does not let the expert open a round they are not seated on', async () => {
    const ids = await seeded();
    const sme = await userWithRole(ids.tenantId, 'sme', 'expert-six');
    const other = await userWithRole(ids.tenantId, 'recruiter', 'someone-else');
    const { roundId } = await seatedRound(ids, [other.id]);
    await assignSme(ids.candidateId, sme.id);

    const res = await room(sme.auth, roundId);

    expect(res.status).toBe(404);
  });
});

describe('nobody is captured who has not agreed', () => {
  beforeEach(async () => { await wipe(); });

  /** A round where the expert has agreed but the candidate has not. */
  async function halfConsented() {
    const ids = await seeded();
    const sme = await userWithRole(ids.tenantId, 'sme', 'expert-gate');
    const { pipelineId, roundId } = await seatedRound(ids, [sme.id]);
    const gate = await post(sme.auth, roundId, 'consent');
    return { ids, sme, pipelineId, roundId, token: tokenOf(gate.body) };
  }

  it('refuses the room to the interviewer while the candidate has not agreed', async () => {
    const { sme, roundId } = await halfConsented();

    expect((await post(sme.auth, roundId, 'join')).status).toBe(409);
  });

  it('captures nothing from the interviewer while the candidate has not agreed', async () => {
    const { sme, roundId } = await halfConsented();
    await speak(sme.auth, roundId);

    const observation = await prisma.roundObservation.findUniqueOrThrow({ where: { roundId }, include: { segments: true } });
    expect(observation.segments).toHaveLength(0);
  });

  it('refuses a capture gap too, so a refused round cannot even log its own silence', async () => {
    const { sme, roundId } = await halfConsented();

    const res = await request(app).post(`/api/observer/rounds/${roundId}/capture-gap`).set('Authorization', sme.auth)
      .send({ offsetMs: 0, durationMs: 1000 });

    expect(res.status).toBe(403);
  });

  it('refuses the room to an HR user arriving from another page', async () => {
    const { ids, roundId } = await halfConsented();
    const hr = await userWithRole(ids.tenantId, 'admin', 'hr-elsewhere');

    expect((await post(hr.auth, roundId, 'join')).status).toBe(409);
  });

  it('refuses a colleague who is neither seated nor running the process', async () => {
    const { ids, roundId } = await halfConsented();
    const auditor = await userWithRole(ids.tenantId, 'auditor', 'compliance');

    expect((await room(auditor.auth, roundId)).status).toBe(403);
  });
});

/**
 * Withdrawal after capture has begun.
 *
 * The three holes a Codex review of this change found, each pinned here so it
 * cannot come back: a second seated interviewer who never agreed, a candidate
 * declining through their link while the observation sat at LISTENING, and an
 * HR colleague declining mid-round and going on being transcribed by somebody
 * else's device.
 */
describe('somebody withdrawing part-way through', () => {
  beforeEach(async () => { await wipe(); });

  async function running() {
    const ids = await seeded();
    const sme = await userWithRole(ids.tenantId, 'sme', 'expert-running');
    const { roundId } = await seatedRound(ids, [sme.id]);
    const gate = await post(sme.auth, roundId, 'consent');
    const token = tokenOf(gate.body);
    await request(app).post(`/api/observer-consent/${token}/consent`).send({});
    await post(sme.auth, roundId, 'join');
    return { ids, sme, roundId, token };
  }

  it('captures while everyone in the room still agrees', async () => {
    const { sme, roundId } = await running();

    expect((await speak(sme.auth, roundId)).status).toBe(201);
  });

  it('stops capture the moment the candidate withdraws through their link', async () => {
    const { sme, roundId, token } = await running();
    await request(app).post(`/api/observer-consent/${token}/decline`).send({});

    expect((await speak(sme.auth, roundId)).status).toBe(409);
  });

  it('stops capture on the OTHER devices too when an HR joiner withdraws', async () => {
    const { ids, sme, roundId } = await running();
    const hr = await userWithRole(ids.tenantId, 'admin', 'hr-withdraws');
    await post(hr.auth, roundId, 'consent');
    await post(hr.auth, roundId, 'join');

    await post(hr.auth, roundId, 'decline');

    // The interviewer's device hears the room, not only the interviewer, so a
    // withdrawal it cannot subtract has to stop the whole capture.
    expect((await speak(sme.auth, roundId)).status).toBe(409);
  });

  /**
   * The race itself, run in a loop rather than reasoned about.
   *
   * A withdrawal and a chunk of speech arrive together. Either may land first —
   * words already heard before somebody withdrew are theirs to keep — but the
   * two must never disagree: a request answered "captured" and a database with
   * nothing in it, or the reverse, would mean the gate was decided twice. The
   * observation row is what serialises them (services/roundObserver.ts,
   * declineEntry).
   */
  it('keeps the answer and the stored rows in step when a withdrawal races a chunk', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { sme, roundId, token } = await running();

      const [, said] = await Promise.all([
        request(app).post(`/api/observer-consent/${token}/decline`).send({}),
        speak(sme.auth, roundId),
      ]);

      const observation = await prisma.roundObservation.findUniqueOrThrow({ where: { roundId }, include: { segments: true } });
      expect(observation.segments).toHaveLength(said.status === 201 ? 1 : 0);
      expect(observation.status).toBe('STOPPED');
      // And whatever happened, nothing more is captured afterwards.
      expect((await speak(sme.auth, roundId)).status).toBe(409);
    }
  }, 120_000);

  // What was captured before the withdrawal stays — deleting it would rewrite
  // what happened — but nothing new is made out of it. Taking fresh quotes from
  // a conversation somebody has since said no to is new processing, and it
  // would put fragments of a withdrawn interview in front of the hiring team.
  it('extracts no quotes from a round whose recording was withdrawn', async () => {
    const { ids, sme, roundId, token } = await running();
    await speak(sme.auth, roundId);
    await request(app).post(`/api/observer-consent/${token}/decline`).send({});

    await post(ids.auth, roundId, 'end');

    const observation = await prisma.roundObservation.findUniqueOrThrow({ where: { roundId }, include: { segments: true } });
    expect(observation.status).toBe('ENDED');
    expect(observation.segments.length).toBeGreaterThan(0);
    expect(observation.quotesJson).toBe('[]');
  });

  it('does not let a withdrawn participant be re-admitted on the same consent', async () => {
    const { ids, roundId } = await running();
    const hr = await userWithRole(ids.tenantId, 'admin', 'hr-rejoins');
    await post(hr.auth, roundId, 'consent');
    await post(hr.auth, roundId, 'join');
    await post(hr.auth, roundId, 'decline');

    expect((await post(hr.auth, roundId, 'join')).status).toBe(409);
  });
});

describe('a round booked with two people conducting it', () => {
  beforeEach(async () => { await wipe(); });

  it('does not open until both of them have agreed', async () => {
    const ids = await seeded();
    const lead = await userWithRole(ids.tenantId, 'sme', 'expert-lead');
    const second = await userWithRole(ids.tenantId, 'sme', 'expert-second');
    const { roundId } = await seatedRound(ids, [lead.id, second.id]);
    const gate = await post(lead.auth, roundId, 'consent');
    await request(app).post(`/api/observer-consent/${tokenOf(gate.body)}/consent`).send({});

    expect((await post(lead.auth, roundId, 'join')).status).toBe(409);
  });

  it('opens once the second has agreed too', async () => {
    const ids = await seeded();
    const lead = await userWithRole(ids.tenantId, 'sme', 'expert-lead-2');
    const second = await userWithRole(ids.tenantId, 'sme', 'expert-second-2');
    const { roundId } = await seatedRound(ids, [lead.id, second.id]);
    const gate = await post(lead.auth, roundId, 'consent');
    await request(app).post(`/api/observer-consent/${tokenOf(gate.body)}/consent`).send({});
    await post(second.auth, roundId, 'consent');

    expect((await post(lead.auth, roundId, 'join')).status).toBe(200);
  });
});

/**
 * A round that ends with nothing, or with one voice, must not pass as a normal
 * one. This is the guard on the other side of the consent gate: capture
 * failing cannot become a quieter route to an unobserved interview that still
 * counts.
 */
describe('a round the recording did not properly hear', () => {
  beforeEach(async () => { await wipe(); });

  async function endedWithNothing() {
    const ids = await seeded();
    const sme = await userWithRole(ids.tenantId, 'sme', 'expert-deaf');
    const { pipelineId, roundId } = await seatedRound(ids, [sme.id]);
    const gate = await post(sme.auth, roundId, 'consent');
    await request(app).post(`/api/observer-consent/${tokenOf(gate.body)}/consent`).send({});
    await post(sme.auth, roundId, 'join');
    await post(sme.auth, roundId, 'end');
    return { ids, sme, pipelineId, roundId };
  }

  it('says plainly that nothing was captured', async () => {
    const { ids, roundId } = await endedWithNothing();

    const res = await room(ids.auth, roundId);

    expect(res.body.observation.captureReport.coverage).toBe('none');
  });

  it('does not let it claim a transcript on the pipeline', async () => {
    const { ids, pipelineId } = await endedWithNothing();

    const res = await request(app).get(`/api/pipelines/${pipelineId}`).set('Authorization', ids.auth);

    expect(res.body.pipeline.rounds[0].evidence.kind).not.toBe('transcript');
  });

  it('tells HR what the recording got, on the round itself', async () => {
    const { ids, pipelineId } = await endedWithNothing();

    const res = await request(app).get(`/api/pipelines/${pipelineId}`).set('Authorization', ids.auth);

    expect(res.body.pipeline.rounds[0].captureReport.sentence).toContain('Nothing was captured');
  });

  // The headset case, forced: a round whose stored speech is only the
  // interviewer's share of the talking. It must be marked, and it must stop
  // being a transcript — a record of one person is not evidence of two.
  it('downgrades a one-sided recording from a transcript', async () => {
    const { ids, pipelineId, roundId } = await endedWithNothing();
    await prisma.roundObservation.update({ where: { roundId }, data: { oneSided: true } });
    await prisma.observationSegment.create({
      data: {
        tenantId: ids.tenantId, index: 0, kind: 'SPEECH', offsetMs: 0, durationMs: 1000, text: 'Tell me about a time you owned an outage.',
        observationId: (await prisma.roundObservation.findUniqueOrThrow({ where: { roundId } })).id,
      },
    });

    const res = await request(app).get(`/api/pipelines/${pipelineId}`).set('Authorization', ids.auth);

    expect(res.body.pipeline.rounds[0].evidence.kind).not.toBe('transcript');
    expect(res.body.pipeline.rounds[0].captureReport.coverage).toBe('one_sided');
  });

  it('tells the reader why, as a fact about the recording', async () => {
    const { ids, pipelineId, roundId } = await endedWithNothing();
    const observation = await prisma.roundObservation.update({ where: { roundId }, data: { oneSided: true } });
    // A one-sided round has speech in it — the interviewer's. A round with
    // none at all is the other failure, and says so instead.
    await prisma.observationSegment.create({
      data: {
        tenantId: ids.tenantId, observationId: observation.id, index: 0, kind: 'SPEECH',
        offsetMs: 0, durationMs: 1000, text: 'So tell me how you approached it.',
      },
    });

    const res = await request(app).get(`/api/pipelines/${pipelineId}`).set('Authorization', ids.auth);

    const sentence = res.body.pipeline.rounds[0].captureReport.sentence as string;
    expect(sentence).toMatch(/headset|earpiece/i);
    expect(sentence).not.toMatch(/fault|failed to|should have/i);
  });
});

describe('quotes are only taken from a real transcript', () => {
  beforeEach(async () => { await wipe(); });

  it('refuses a quotes retry on a round that captured one voice', async () => {
    const ids = await seeded();
    const sme = await userWithRole(ids.tenantId, 'sme', 'expert-retry');
    const { roundId } = await seatedRound(ids, [sme.id]);
    const gate = await post(sme.auth, roundId, 'consent');
    await request(app).post(`/api/observer-consent/${tokenOf(gate.body)}/consent`).send({});
    await post(sme.auth, roundId, 'join');
    await speak(sme.auth, roundId);
    await post(sme.auth, roundId, 'end');
    // A retry is a second attempt at extraction, not a second opinion on
    // whether extraction is allowed at all.
    await prisma.roundObservation.update({
      where: { roundId }, data: { oneSided: true, quotesStatus: 'UNAVAILABLE' },
    });

    const res = await post(ids.auth, roundId, 'quotes');

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('did not produce a transcript');
  });

  it('refuses a quotes retry on a round whose recording was withdrawn', async () => {
    const ids = await seeded();
    const sme = await userWithRole(ids.tenantId, 'sme', 'expert-retry-2');
    const { roundId } = await seatedRound(ids, [sme.id]);
    const gate = await post(sme.auth, roundId, 'consent');
    const token = tokenOf(gate.body);
    await request(app).post(`/api/observer-consent/${token}/consent`).send({});
    await post(sme.auth, roundId, 'join');
    await speak(sme.auth, roundId);
    await request(app).post(`/api/observer-consent/${token}/decline`).send({});
    await post(ids.auth, roundId, 'end');
    await prisma.roundObservation.update({ where: { roundId }, data: { quotesStatus: 'UNAVAILABLE' } });

    const res = await post(ids.auth, roundId, 'quotes');

    expect(res.status).toBe(409);
  });
});

describe('a round the candidate has not agreed to', () => {
  beforeEach(async () => { await wipe(); });

  async function declined() {
    const ids = await seeded();
    const sme = await userWithRole(ids.tenantId, 'sme', 'expert-declined');
    const { pipelineId, roundId } = await seatedRound(ids, [sme.id]);
    await assignSme(ids.candidateId, sme.id);
    const gate = await post(sme.auth, roundId, 'consent');
    const token = tokenOf(gate.body);
    await request(app).post(`/api/observer-consent/${token}/decline`).send({});
    return { ids, sme, pipelineId, roundId, token };
  }

  it('does not happen: the room refuses the person conducting it', async () => {
    const { sme, roundId } = await declined();

    expect((await post(sme.auth, roundId, 'join')).status).toBe(409);
  });

  it('refuses a rejoin, which is the same door opened twice', async () => {
    const { sme, roundId } = await declined();
    await post(sme.auth, roundId, 'join');

    expect((await post(sme.auth, roundId, 'join')).status).toBe(409);
  });

  it('refuses an HR user opening it directly from another page', async () => {
    const { ids, roundId } = await declined();
    const hr = await userWithRole(ids.tenantId, 'admin', 'hr-direct');
    await post(hr.auth, roundId, 'consent');

    expect((await post(hr.auth, roundId, 'join')).status).toBe(409);
  });

  it('captures nothing posted straight at the segments URL', async () => {
    const { sme, roundId } = await declined();

    expect((await speak(sme.auth, roundId)).status).toBe(403);
  });

  it('refuses the candidate a second, contradicting answer on the same link', async () => {
    const { token } = await declined();

    const res = await request(app).post(`/api/observer-consent/${token}/consent`).send({});

    expect(res.status).toBe(409);
  });

  it('stops offering the candidate link, so a stale copy reaches nothing', async () => {
    const { ids, roundId } = await declined();

    const res = await room(ids.auth, roundId);

    expect(res.body.observation.candidateLink).toBeNull();
  });

  it('says why it cannot go ahead, in a sentence rather than a status', async () => {
    const { ids, roundId } = await declined();

    const res = await room(ids.auth, roundId);

    expect(res.body.observation.blocked.reason).toContain('has not agreed to this round being recorded');
  });

  it('offers something that can be done next, rather than a dead end', async () => {
    const { ids, roundId } = await declined();

    const res = await room(ids.auth, roundId);

    expect(res.body.observation.blocked.nextSteps.length).toBeGreaterThan(0);
  });

  it('shows HR the blocker on the pipeline, where they look', async () => {
    const { ids, pipelineId } = await declined();

    const res = await request(app).get(`/api/pipelines/${pipelineId}`).set('Authorization', ids.auth);

    expect(res.body.pipeline.rounds[0].observerBlocked.reason).toContain('recorded');
  });

  it('puts it in the needs-you queue, so nobody discovers it at the scheduled time', async () => {
    const { ids } = await declined();

    const res = await request(app).get('/api/dashboard/needs-you').set('Authorization', ids.auth);

    expect(res.body.needsYou.items.some((row: { kind: string }) => row.kind === 'round_not_recordable')).toBe(true);
  });

  it('shows the expert their own blocked round on their workbench', async () => {
    const { sme, roundId } = await declined();

    const res = await request(app).get('/api/sme/assignments').set('Authorization', sme.auth);

    const blocked = res.body.assignments.flatMap((a: { blockedRounds: Array<{ roundId: string }> }) => a.blockedRounds);
    expect(blocked.map((b: { roundId: string }) => b.roundId)).toContain(roundId);
  });

  it('tells the candidate the round is not going ahead, without blaming them', async () => {
    const { token } = await declined();

    const res = await request(app).get(`/api/observer-consent/${token}`);

    expect(res.body.decision).toBe('declined');
    // The candidate is told the round is not going ahead. What they are not
    // told is that it is their fault, because it is not: declining to be
    // recorded is a legitimate choice and Questor does not editorialise.
    expect(`${res.body.notice} ${res.body.consequence}`).not.toMatch(/fault|unwilling|unfortunately/i);
  });
});
