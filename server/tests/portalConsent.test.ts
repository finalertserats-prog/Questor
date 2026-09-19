import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';

/**
 * The consent step as the candidate experiences it. Two things HR's review of
 * the portal page turned up: a short accommodation request was silently
 * dropped and the candidate moved on as if they had asked for nothing, and the
 * voice-capture box was recorded but never enforced.
 */

const app = createApp();
let token = '';
let sessionId = '';

beforeEach(async () => {
  await wipe();
  const demo = await createDemoData();
  token = demo.token;
  sessionId = demo.sessionId;
});

const consent = (body: Record<string, unknown>) => request(app).post(`/api/portal/${token}/consent`).send(body);
const summary = () => request(app).get(`/api/portal/${token}`);

describe('a short accommodation request', () => {
  it('is refused with an explanation rather than dropped', async () => {
    const res = await consent({ recordingConsent: true, accepted: true, accommodationRequest: 'more time' });

    expect(res.status).toBe(400);
  });

  it('does not record consent on the way past', async () => {
    // The demo seed pre-fills consent; start from a session that has given none.
    await prisma.interviewSession.update({ where: { id: sessionId }, data: { consentJson: '{}' } });

    await consent({ recordingConsent: true, accepted: true, accommodationRequest: 'more time' });

    const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(JSON.parse(session.consentJson).consentedAt).toBeUndefined();
  });

  it('still hands off a request long enough to act on', async () => {
    const res = await consent({ recordingConsent: true, accepted: true, accommodationRequest: 'I need extra time because of a stammer' });

    expect(res.body.handoff).toBe(true);
  });
});

describe('what the portal tells the room about voice capture', () => {
  it('reports no voice consent before the candidate has answered', async () => {
    // The demo seed pre-fills consent for convenience; a real session starts without it.
    await prisma.interviewSession.update({ where: { id: sessionId }, data: { recordingConsent: false } });

    const res = await summary();

    expect(res.body.recordingConsented).toBe(false);
  });

  it('reports voice consent once the candidate gave it', async () => {
    await consent({ recordingConsent: true, accepted: true });

    expect((await summary()).body.recordingConsented).toBe(true);
  });

  it('keeps reporting no voice consent when the candidate declined it', async () => {
    await consent({ recordingConsent: false, accepted: true });

    expect((await summary()).body.recordingConsented).toBe(false);
  });
});

describe('the interviewer name the portal shows', () => {
  it('is the interviewer assigned to this session, not a built-in default', async () => {
    await prisma.interviewSession.update({ where: { id: sessionId }, data: { personaJson: JSON.stringify({ interviewerId: 'theo', name: 'Theo', tone: 'warm' }) } });

    const res = await summary();

    expect(res.body.persona.name).toBe('Theo');
  });

  it('assigns a catalogue interviewer when a not-yet-started session has none', async () => {
    await prisma.interviewSession.update({ where: { id: sessionId }, data: { personaJson: '{}' } });

    const res = await summary();

    expect(['Avery', 'Maya', 'Adrian', 'Elena', 'Theo']).toContain(res.body.persona.name);
  });

  it('invents no name for a finished interview that recorded none', async () => {
    await prisma.interviewSession.update({ where: { id: sessionId }, data: { personaJson: '{}', state: 'REVIEW_READY' } });

    const res = await summary();

    expect(res.body.persona.name).toBe(null);
  });
});
