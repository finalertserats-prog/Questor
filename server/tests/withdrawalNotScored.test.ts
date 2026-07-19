import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';

const app = createApp();

// The interviewer tells a withdrawing candidate "nothing you've said will count
// against you". Before this, the session finalised anyway: a real withdrawal
// produced state REVIEW_READY and an assessment reading CONSIDER 0/100, sitting
// in the recruiter's queue looking like a bad candidate rather than an
// unfinished interview. 0/100 is worse than no score — it reads as a judgement.
describe('a candidate who asks to stop is not scored', () => {
  it('closes the interview without producing an assessment', async () => {
    await wipe();
    const ids = await createDemoData();

    await request(app).post(`/api/portal/${ids.token}/accept`).send({});
    await request(app).post(`/api/portal/${ids.token}/consent`).send({ recordingConsent: true, accepted: true });
    await request(app).post(`/api/portal/${ids.token}/start`).send({});

    const res = await request(app).post(`/api/portal/${ids.token}/turn`)
      .send({ text: "No I'm done I don't wanna do this to you anymore" });

    expect(res.status).toBe(200);
    expect(res.body.turn.kind).toBe('withdrawn');
    expect(res.body.turn.done).toBe(true);
    expect(res.body.assessmentReady).toBeFalsy();

    const session = await prisma.interviewSession.findUnique({ where: { id: ids.sessionId } });
    expect(session?.state).toBe('CANDIDATE_WITHDREW');

    // The promise, pinned.
    expect(await prisma.assessmentVersion.count({ where: { sessionId: ids.sessionId } })).toBe(0);

    // The transcript survives — the candidate may resume, and a follow-up needs context.
    expect(await prisma.turn.count({ where: { sessionId: ids.sessionId } })).toBeGreaterThan(0);
  });
});
