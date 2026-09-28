import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma, parseJson } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';

/**
 * An interview may not begin until consent is on the record.
 *
 * startInterview converged any pre-live state to ASSESSING without ever looking
 * at the consent record, so a caller could skip the disclosure entirely and
 * still reach a scored assessment. The transcript then exists, the score
 * exists, and there is nothing in the session that says the person agreed to
 * any of it — the exact evidence a GDPR or LL144 enquiry asks for first.
 */

const app = createApp();

/** The demo session, with the candidate's recorded consent removed. */
async function withoutConsent() {
  await wipe();
  const ids = await createDemoData();
  const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } });
  const consent = parseJson<Record<string, unknown>>(session.consentJson, {});
  const { consentedAt: _dropped, ...unconsented } = consent;
  await prisma.interviewSession.update({
    where: { id: ids.sessionId },
    data: { consentJson: JSON.stringify(unconsented) },
  });
  return ids;
}

describe('starting an interview nobody consented to', () => {
  it('is refused', async () => {
    const ids = await withoutConsent();

    const res = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(res.status).toBe(409);
  });

  it('is explained to the candidate without an internal state name', async () => {
    const ids = await withoutConsent();

    const res = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(res.body.error).toMatch(/consent/i);
  });

  it('leaves the session where it was', async () => {
    // The refusal must not be a half-start: a session dragged to ASSESSING and
    // then refused would accept turns on the next request.
    const ids = await withoutConsent();

    await request(app).post(`/api/portal/${ids.token}/start`).send({});

    const session = await prisma.interviewSession.findUnique({ where: { id: ids.sessionId } });
    expect(session?.state).toBe('ACCEPTED');
  });

  it('records no turn, so nothing was said to a candidate who had not agreed', async () => {
    const ids = await withoutConsent();

    await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(await prisma.turn.count({ where: { sessionId: ids.sessionId } })).toBe(0);
  });
});

describe('starting an interview the candidate consented to', () => {
  it('proceeds once consent has been recorded through the portal', async () => {
    const ids = await withoutConsent();
    await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: true, accepted: true });

    const res = await request(app).post(`/api/portal/${ids.token}/start`).send({});

    expect(res.status).toBe(200);
  });
});
