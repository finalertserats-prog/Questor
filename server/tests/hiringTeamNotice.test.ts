import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { issueHumanRequestToken } from '../src/services/candidateFeedback.js';
import { sweepIncompleteInterviews, INACTIVITY_MS } from '../src/services/incompleteInterviews.js';

/**
 * The three moments that need a person — an assessment ready for review, a
 * candidate asking to talk to someone, and an accommodation request — email the
 * candidate's owner (the tenant's admins when nobody owns them). The mail links
 * into the app and never carries a candidate's portal link.
 */

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; text: string; html: string }>);
vi.mock('../src/providers/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({
      name: 'test', configured: true, delivers: true,
      async send(msg: { to: string; subject: string; text: string; html: string }) {
        sent.push(msg);
        return { status: 'sent', id: `test-${sent.length}` };
      },
    }),
  };
});

const app = createApp();
type Demo = Awaited<ReturnType<typeof createDemoData>>;
let demo: Demo;

beforeEach(async () => {
  await wipe();
  sent.length = 0;
  demo = await createDemoData();
  // Someone in the same organisation who does not own the candidate.
  await prisma.user.create({ data: { tenantId: demo.tenantId, email: 'bystander@questor.local', name: 'Bystander', passwordHash: 'x', role: 'recruiter' } });
});

const recipients = () => sent.map((m) => m.to).sort();
const noPortalLinks = () => sent.every((m) => !/\/(portal|room)\//.test(m.text + m.html) && !m.text.includes(demo.token));

describe('accommodation request', () => {
  const REQUEST = 'I need extra time because of a stammer, please.';

  it('emails the candidate owner and nobody else', async () => {
    await request(app).post(`/api/portal/${demo.token}/consent`).send({ recordingConsent: false, accepted: true, accommodationRequest: REQUEST });
    expect(recipients()).toEqual([demo.email]);
  });

  it('links to the interview page, and keeps the request itself and the portal link out of the mail', async () => {
    await request(app).post(`/api/portal/${demo.token}/consent`).send({ recordingConsent: false, accepted: true, accommodationRequest: REQUEST });
    const mail = sent[0];
    expect([mail.text.includes(`/interviews/${demo.sessionId}`), mail.text.includes('stammer'), noPortalLinks()]).toEqual([true, false, true]);
  });

  it('goes to the admins when nobody owns the candidate', async () => {
    await prisma.candidateAssignment.deleteMany({ where: { candidateId: demo.candidateId } });
    const other = await prisma.user.create({ data: { tenantId: demo.tenantId, email: 'second-admin@questor.local', name: 'Second Admin', passwordHash: 'x', role: 'admin' } });
    await request(app).post(`/api/portal/${demo.token}/consent`).send({ recordingConsent: false, accepted: true, accommodationRequest: REQUEST });
    expect(recipients()).toEqual([demo.email, other.email].sort());
  });

  it('never emails an admin of another organisation', async () => {
    await prisma.candidateAssignment.deleteMany({ where: { candidateId: demo.candidateId } });
    const elsewhere = await prisma.tenant.create({ data: { name: 'Elsewhere' } });
    await prisma.user.create({ data: { tenantId: elsewhere.id, email: 'admin@elsewhere.local', name: 'Elsewhere Admin', passwordHash: 'x', role: 'admin' } });
    await request(app).post(`/api/portal/${demo.token}/consent`).send({ recordingConsent: false, accepted: true, accommodationRequest: REQUEST });
    expect(recipients()).toEqual([demo.email]);
  });
});

describe('candidate asks to talk to a person', () => {
  it('emails the owner a link to the candidate, once', async () => {
    const token = await issueHumanRequestToken({ sessionId: demo.sessionId, candidateId: demo.candidateId, tenantId: demo.tenantId });
    await request(app).post(`/api/feedback-request/${token}/confirm`).send({});
    await request(app).post(`/api/feedback-request/${token}/confirm`).send({});
    expect(sent.map((m) => [m.to, m.text.includes(`/candidates/${demo.candidateId}`)])).toEqual([[demo.email, true]]);
  });
});

describe('assessment ready for review', () => {
  it('emails the owner a link to the assessment', async () => {
    await request(app).post(`/api/portal/${demo.token}/accept`).send({});
    await request(app).post(`/api/portal/${demo.token}/consent`).send({ recordingConsent: true, accepted: true });
    // Mail is delivered here, so consent brings the one-time identity code with it.
    await request(app).post(`/api/portal/${demo.token}/identity/code`).send({});
    const code = /\b(\d{6})\b/.exec(sent[sent.length - 1]?.text ?? '')?.[1] ?? '';
    await request(app).post(`/api/portal/${demo.token}/identity/verify`).send({ code });
    await request(app).post(`/api/portal/${demo.token}/start`).send({});
    await request(app).post(`/api/portal/${demo.token}/turn`).send({ text: 'I led the payments platform team and owned the ledger service end to end.' });
    await prisma.turn.updateMany({ where: { sessionId: demo.sessionId }, data: { createdAt: new Date(Date.now() - INACTIVITY_MS - 60_000) } });
    await sweepIncompleteInterviews();
    const user = await prisma.user.findFirstOrThrow({ where: { email: demo.email } });
    const adminToken = signToken({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email });
    sent.length = 0;

    const res = await request(app).post(`/api/interviews/${demo.sessionId}/assess-partial`)
      .set({ Authorization: `Bearer ${adminToken}` })
      .send({ reason: 'Reviewer read the transcript and decided it is fair to assess.' });

    const toOwner = sent.filter((m) => m.to === demo.email && m.text.includes(`/assessments/${res.body.assessmentId}`));
    expect([toOwner.length, noPortalLinks()]).toEqual([1, true]);
  });
});
