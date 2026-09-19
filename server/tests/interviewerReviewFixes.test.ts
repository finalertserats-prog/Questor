import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData, type DemoIds } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { seedInterviewers } from '../src/services/interviewers.js';
import { provisionDemoTenant } from '../src/services/demoAccess.js';
import { consentIntro, hasConsentIntro } from '../src/domain/interviewerModel.js';
import { sweepIncompleteInterviews, INACTIVITY_MS } from '../src/services/incompleteInterviews.js';

// Review fixes for the AI interviewer work: every session a candidate can
// consent on carries the named AI disclosure (and consent fails closed when it
// does not), a retake of a pre-catalogue session gets a real interviewer, and
// the portal never breaks because no interviewer is active.

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
const RETIRED = ['Schr', 'anders'].join('');
let ids: DemoIds;

beforeEach(async () => {
  sent.messages = [];
  await wipe();
  await prisma.aIInterviewer.deleteMany();
  await prisma.voiceProfile.deleteMany();
  await seedInterviewers('webspeech');
  ids = await createDemoData();
});

async function setConsent(consent: Record<string, unknown>, state = 'INVITED'): Promise<void> {
  await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state, consentJson: JSON.stringify(consent) } });
}

describe('demo sandbox disclosure', () => {
  it('gives the sample interview the named AI disclosure', async () => {
    const { sessionId } = await provisionDemoTenant({ name: 'Dana Visitor', email: 'dana@example.com', company: 'Example Co' });
    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(hasConsentIntro((JSON.parse(session.consentJson) as { disclosureText?: string }).disclosureText ?? '')).toBe(true);
  });

  it('names the sandbox interviewer in that disclosure', async () => {
    const { sessionId } = await provisionDemoTenant({ name: 'Dana Visitor', email: 'dana@example.com', company: 'Example Co' });
    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: sessionId } });
    const name = (JSON.parse(session.personaJson) as { name: string }).name;
    expect((JSON.parse(session.consentJson) as { disclosureText: string }).disclosureText.startsWith(consentIntro(name))).toBe(true);
  });
});

describe('consent fails closed without the AI disclosure', () => {
  it('refuses consent when the stored disclosure is empty', async () => {
    await setConsent({ disclosureText: '' });
    const res = await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: false, accepted: true });
    expect(res.status).toBe(409);
  });

  it('refuses consent when the disclosure never names the AI interviewer', async () => {
    await setConsent({ disclosureText: 'Your voice is transcribed as we talk.' });
    const res = await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: false, accepted: true });
    expect(res.status).toBe(409);
  });

  it('records nothing when it refuses', async () => {
    await setConsent({ disclosureText: '' });
    await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: false, accepted: true });
    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } });
    expect((JSON.parse(session.consentJson) as { consentedAt?: string }).consentedAt).toBeUndefined();
  });

  it('accepts consent to a disclosure that names the AI interviewer', async () => {
    await setConsent({ disclosureText: `${consentIntro('Maya')} Your voice is transcribed.` });
    const res = await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: false, accepted: true });
    expect(res.status).toBe(200);
  });
});

describe('retake of a session from before the interviewer catalogue', () => {
  async function incompleteLegacySession(): Promise<string> {
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { personaJson: JSON.stringify({ name: RETIRED, tone: 'neutral' }) } });
    await request(app).post(`/api/portal/${ids.token}/start`).send({});
    await request(app).post(`/api/portal/${ids.token}/turn`).send({ text: 'I led the payments platform team for four years.' });
    await prisma.turn.updateMany({ where: { sessionId: ids.sessionId }, data: { createdAt: new Date(Date.now() - INACTIVITY_MS - 60_000) } });
    await sweepIncompleteInterviews();
    const bearer = `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}`;
    const retake = await request(app).post(`/api/interviews/${ids.sessionId}/retake`).set('Authorization', bearer)
      .send({ reason: 'Network dropped mid-interview, candidate asked to try again.' });
    await request(app).post(`/api/interviews/${retake.body.session.id}/invite`).set('Authorization', bearer).send({});
    return retake.body.session.id as string;
  }

  it('gives the retake a catalogue interviewer', async () => {
    const id = await incompleteLegacySession();
    const persona = JSON.parse((await prisma.interviewSession.findUniqueOrThrow({ where: { id } })).personaJson) as Record<string, unknown>;
    expect(['avery', 'maya', 'adrian', 'elena', 'theo']).toContain(persona.interviewerId);
  });

  it('keeps the original tone', async () => {
    const id = await incompleteLegacySession();
    const persona = JSON.parse((await prisma.interviewSession.findUniqueOrThrow({ where: { id } })).personaJson) as Record<string, unknown>;
    expect(persona.tone).toBe('neutral');
  });

  it('never emails the retired name', async () => {
    await incompleteLegacySession();
    expect(sent.messages.at(-1)?.text).not.toContain(RETIRED);
  });

  it('introduces the new interviewer in the retake disclosure', async () => {
    const id = await incompleteLegacySession();
    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id } });
    const name = (JSON.parse(session.personaJson) as { name: string }).name;
    expect((JSON.parse(session.consentJson) as { disclosureText: string }).disclosureText.startsWith(consentIntro(name))).toBe(true);
  });
});

describe('portal with no active interviewer', () => {
  it('still opens the invitation for a legacy session', async () => {
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'INVITED', personaJson: '{}' } });
    await prisma.aIInterviewer.updateMany({ data: { active: false } });
    const res = await request(app).get(`/api/portal/${ids.token}`);
    expect(res.status).toBe(200);
  });
});
