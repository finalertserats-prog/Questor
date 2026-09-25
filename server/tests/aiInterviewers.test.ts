import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData, type DemoIds } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { seedInterviewers } from '../src/services/interviewers.js';
import { DEFAULT_DISCLOSURE_BODY, consentIntro } from '../src/domain/interviewerModel.js';
import { sweepIncompleteInterviews, INACTIVITY_MS } from '../src/services/incompleteInterviews.js';

// HR picks an AI interviewer (or Random) when setting up an interview. The
// choice decides the name and voice and nothing else; Tone stays a separate,
// untouched setting.

const sent = vi.hoisted(() => ({ messages: [] as Array<{ to: string; subject: string; text: string; html: string }> }));
vi.mock('../src/providers/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({
      name: 'test', configured: true, delivers: true,
      async send(msg: { to: string; subject: string; text: string; html: string }) {
        sent.messages.push(msg);
        return { status: 'sent', id: `test-${sent.messages.length}` };
      },
    }),
  };
});

const app = createApp();
let ids: DemoIds;
let bearer = '';

beforeEach(async () => {
  sent.messages = [];
  await wipe();
  await prisma.aIInterviewer.deleteMany();
  await prisma.voiceProfile.deleteMany();
  await seedInterviewers('openai');
  ids = await createDemoData();
  bearer = `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}`;
});

function createInterview(body: Record<string, unknown>) {
  return request(app).post('/api/interviews').set('Authorization', bearer).send({ candidateId: ids.candidateId, ...body });
}

async function storedPersona(sessionId: string): Promise<Record<string, unknown>> {
  const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: sessionId } });
  return JSON.parse(session.personaJson) as Record<string, unknown>;
}

describe('GET /api/interviewers', () => {
  it('requires a signed-in HR user', async () => {
    const res = await request(app).get('/api/interviewers');
    expect(res.status).toBe(401);
  });

  it('lists the five interviewers in order', async () => {
    const res = await request(app).get('/api/interviewers').set('Authorization', bearer);
    expect(res.body.interviewers.map((i: { name: string }) => i.name)).toEqual(['Avery', 'Maya', 'Adrian', 'Elena', 'Theo']);
  });

  it('never exposes provider, providerVoiceId or voiceProfileId', async () => {
    const res = await request(app).get('/api/interviewers').set('Authorization', bearer);
    expect(JSON.stringify(res.body)).not.toMatch(/provider|voiceProfileId|providerVoiceId|marin|cedar|voice_0/);
  });

  it('leaves out inactive interviewers', async () => {
    await prisma.aIInterviewer.update({ where: { id: 'avery' }, data: { active: false } });
    const res = await request(app).get('/api/interviewers').set('Authorization', bearer);
    expect(res.body.interviewers.map((i: { id: string }) => i.id)).not.toContain('avery');
  });
});

describe('POST /api/interviews — interviewer choice', () => {
  it('stores an explicit choice on the session', async () => {
    const res = await createInterview({ interviewer: 'maya' });
    expect(await storedPersona(res.body.session.id)).toMatchObject({ interviewerId: 'maya', name: 'Maya' });
  });

  it('assigns a random active interviewer by default', async () => {
    await prisma.aIInterviewer.updateMany({ where: { id: { not: 'elena' } }, data: { active: false } });
    const res = await createInterview({});
    expect(await storedPersona(res.body.session.id)).toMatchObject({ interviewerId: 'elena', name: 'Elena' });
  });

  it('assigns a random active interviewer when asked for Random', async () => {
    await prisma.aIInterviewer.updateMany({ where: { id: { not: 'adrian' } }, data: { active: false } });
    const res = await createInterview({ interviewer: 'random' });
    expect(await storedPersona(res.body.session.id)).toMatchObject({ interviewerId: 'adrian' });
  });

  it('refuses an unknown interviewer', async () => {
    const res = await createInterview({ interviewer: 'nobody' });
    expect(res.status).toBe(400);
  });

  it('refuses an inactive interviewer', async () => {
    await prisma.aIInterviewer.update({ where: { id: 'theo' }, data: { active: false } });
    const res = await createInterview({ interviewer: 'theo' });
    expect(res.status).toBe(400);
  });

  it('refuses a malformed interviewer value', async () => {
    const res = await createInterview({ interviewer: { id: 'maya' } });
    expect(res.status).toBe(400);
  });

  it('introduces the interviewer by name in the stored disclosure', async () => {
    const res = await createInterview({ interviewer: 'theo' });
    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: res.body.session.id } });
    expect((JSON.parse(session.consentJson) as { disclosureText: string }).disclosureText.startsWith(consentIntro('Theo'))).toBe(true);
  });

  it('keeps the tenant disclosure whole after the introduction', async () => {
    const res = await createInterview({ interviewer: 'theo' });
    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: res.body.session.id } });
    expect((JSON.parse(session.consentJson) as { disclosureText: string }).disclosureText).toContain('No recording of your voice is stored — the written transcript is what is kept, and it is what our hiring team reviews.');
  });

  it('uses the standard disclosure, whole, when the tenant has none', async () => {
    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: '{}' } });
    const res = await createInterview({ interviewer: 'theo' });
    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: res.body.session.id } });
    expect((JSON.parse(session.consentJson) as { disclosureText: string }).disclosureText).toBe(`${consentIntro('Theo')} ${DEFAULT_DISCLOSURE_BODY}`);
  });
});

describe('Tone is independent of the interviewer', () => {
  it('stores the chosen tone exactly as before', async () => {
    const res = await createInterview({ interviewer: 'maya', persona: { tone: 'formal' } });
    expect((await storedPersona(res.body.session.id)).tone).toBe('formal');
  });

  it('returns the tone on the session detail', async () => {
    const created = await createInterview({ interviewer: 'adrian', persona: { tone: 'neutral' } });
    const res = await request(app).get(`/api/interviews/${created.body.session.id}`).set('Authorization', bearer);
    expect(res.body.session.persona).toMatchObject({ tone: 'neutral', name: 'Adrian', interviewerId: 'adrian' });
  });

  it('defaults the tone to warm, as before, whoever the interviewer is', async () => {
    const res = await createInterview({ interviewer: 'theo' });
    expect((await storedPersona(res.body.session.id)).tone).toBe('warm');
  });

  it('still accepts an older client that sends persona name and tone', async () => {
    const res = await createInterview({ persona: { name: 'Legacy Name', tone: 'formal' } });
    expect([res.status, (await storedPersona(res.body.session.id)).tone]).toEqual([201, 'formal']);
  });

  it('builds the same interview plan for two different interviewers', async () => {
    const a = await createInterview({ interviewer: 'maya', persona: { tone: 'warm' } });
    const b = await createInterview({ interviewer: 'theo', persona: { tone: 'warm' } });
    expect(a.body.plan).toEqual(b.body.plan);
  });
});

describe('invitation and retake', () => {
  // The invitation reads as a note from the hiring team. The AI disclosure is
  // made on the page the link opens, before the interview and before consent.
  it('does not describe the interview as AI-led in the invitation email', async () => {
    const created = await createInterview({ interviewer: 'elena' });
    await request(app).post(`/api/interviews/${created.body.session.id}/invite`).set('Authorization', bearer).send({});
    expect(/\bAI\b/.test(sent.messages.at(-1)?.text ?? '')).toBe(false);
  });

  it('does not describe the interview as AI-led in the HTML invitation either', async () => {
    const created = await createInterview({ interviewer: 'elena' });
    await request(app).post(`/api/interviews/${created.body.session.id}/invite`).set('Authorization', bearer).send({});
    expect(/\bAI\b/.test(sent.messages.at(-1)?.html ?? '')).toBe(false);
  });

  it('keeps the original interviewer on a retake', async () => {
    await request(app).post(`/api/portal/${ids.token}/start`).send({});
    await request(app).post(`/api/portal/${ids.token}/turn`).send({ text: 'I led the payments platform team for four years.' });
    await prisma.turn.updateMany({ where: { sessionId: ids.sessionId }, data: { createdAt: new Date(Date.now() - INACTIVITY_MS - 60_000) } });
    await sweepIncompleteInterviews();
    const before = await storedPersona(ids.sessionId);

    const res = await request(app).post(`/api/interviews/${ids.sessionId}/retake`).set('Authorization', bearer)
      .send({ reason: 'Network dropped mid-interview, candidate asked to try again.' });
    expect(await storedPersona(res.body.session.id)).toEqual(before);
  });
});
