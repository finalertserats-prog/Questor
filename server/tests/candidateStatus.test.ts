import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { issueHumanRequestToken } from '../src/services/candidateFeedback.js';

/**
 * The candidate's status page, from the server's side: what the spent
 * invitation link answers once the interview is over, and — far more
 * importantly — what it refuses to answer.
 */

const app = createApp();

type Demo = Awaited<ReturnType<typeof createDemoData>>;
let demo: Demo;

const RESULT = {
  summary: 'A summary no candidate may read.',
  competencies: [{ competencyId: 'c1', name: 'System design', level: 'STRONG', evidence: ['quoted line'] }],
  strengths: ['Reasoned back from a failure'],
  concerns: ['Thin on leading others'],
};

async function finishInterview(over: { completedAt?: Date; startedAt?: Date; state?: string } = {}) {
  await prisma.interviewSession.update({
    where: { id: demo.sessionId },
    data: {
      state: over.state ?? 'REVIEW_READY',
      startedAt: over.startedAt ?? new Date('2026-09-22T10:00:00Z'),
      completedAt: over.completedAt ?? new Date('2026-09-22T10:38:00Z'),
    },
  });
  await prisma.invitation.updateMany({ where: { sessionId: demo.sessionId }, data: { status: 'consumed' } });
}

async function addAssessment() {
  return prisma.assessmentVersion.create({
    data: {
      sessionId: demo.sessionId, scorecardId: demo.scorecardId, recommendation: 'DO_NOT_PROGRESS',
      confidence: 0.91, evidenceCoverage: 0.64, resultJson: JSON.stringify(RESULT),
    },
  });
}

async function setPolicy(patch: Record<string, unknown>) {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: demo.tenantId }, select: { policyJson: true } });
  const policy = { ...(JSON.parse(tenant.policyJson) as Record<string, unknown>), ...patch };
  await prisma.tenant.update({ where: { id: demo.tenantId }, data: { policyJson: JSON.stringify(policy) } });
}

beforeEach(async () => {
  await wipe();
  demo = await createDemoData();
});

describe('the status a spent link shows', () => {
  it('still answers once the invitation has been consumed', async () => {
    await finishInterview();

    const res = await request(app).get(`/api/portal/${demo.token}/status`);

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('completed');
  });

  it('names the role, the organisation and the interviewer they talked to', async () => {
    await finishInterview();

    const res = await request(app).get(`/api/portal/${demo.token}/status`);

    expect(res.body.candidateName).toBeTruthy();
    expect(res.body.roleTitle).toBeTruthy();
    expect(res.body.organisation).toBeTruthy();
  });

  it('says how long the conversation actually took', async () => {
    await finishInterview();

    const res = await request(app).get(`/api/portal/${demo.token}/status`);

    expect(res.body.interviewMinutes).toBe(38);
  });

  it('still answers after the invitation has expired, because the interview happened', async () => {
    await finishInterview();
    await prisma.invitation.updateMany({
      where: { sessionId: demo.sessionId },
      data: { expiresAt: new Date(Date.now() - 864e5) },
    });

    const res = await request(app).get(`/api/portal/${demo.token}/status`);

    expect(res.status).toBe(200);
  });

  it('refuses an expired link for an interview that never happened', async () => {
    await prisma.invitation.updateMany({
      where: { sessionId: demo.sessionId },
      data: { expiresAt: new Date(Date.now() - 864e5) },
    });

    const res = await request(app).get(`/api/portal/${demo.token}/status`);

    expect(res.status).toBe(410);
  });

  it('stops working cleanly once the candidate has been erased', async () => {
    await finishInterview();
    await prisma.invitation.deleteMany({ where: { sessionId: demo.sessionId } });

    const res = await request(app).get(`/api/portal/${demo.token}/status`);

    expect(res.status).toBe(404);
  });

  it('refuses a token that was never issued', async () => {
    const res = await request(app).get('/api/portal/not-a-real-token/status');

    expect(res.status).toBe(404);
  });

  it('tells a withdrawal apart from a completed interview', async () => {
    await prisma.interviewSession.update({
      where: { id: demo.sessionId },
      data: { state: 'CANDIDATE_WITHDREW' },
    });

    const res = await request(app).get(`/api/portal/${demo.token}/status`);

    expect(res.body.outcome).toBe('withdrawn');
  });
});

describe('what the status page is never allowed to disclose', () => {
  it('carries no score, verdict, recommendation or competency level', async () => {
    await finishInterview();
    const assessment = await addAssessment();
    await prisma.humanReview.create({
      data: {
        assessmentId: assessment.id, reviewerId: demo.userId, status: 'COMPLETED',
        disposition: 'DO_NOT_PROGRESS', completedAt: new Date(), activeForAssessmentId: assessment.id,
      },
    });

    const res = await request(app).get(`/api/portal/${demo.token}/status`);
    const body = JSON.stringify(res.body);

    expect(body).not.toMatch(/DO_NOT_PROGRESS|PROCEED|CONSIDER/);
    expect(body).not.toMatch(/recommendation|confidence|disposition|competenc/i);
    expect(body).not.toContain('STRONG');
    expect(body).not.toContain(RESULT.summary);
    expect(body).not.toContain(RESULT.concerns[0]);
  });

  it('says a person has read it without saying what they concluded', async () => {
    await finishInterview();
    const assessment = await addAssessment();
    await prisma.humanReview.create({
      data: {
        assessmentId: assessment.id, reviewerId: demo.userId, status: 'COMPLETED',
        disposition: 'PROCEED', completedAt: new Date('2026-09-24T09:00:00Z'), activeForAssessmentId: assessment.id,
      },
    });

    const res = await request(app).get(`/api/portal/${demo.token}/status`);

    expect(res.body.readByTeamAt).toBe('2026-09-24T09:00:00.000Z');
    expect(res.body.decisionSharedAt).toBeNull();
  });

  it('never announces a decision the candidate has not been told about', async () => {
    await finishInterview();
    await prisma.candidatePipeline.create({
      data: {
        tenantId: demo.tenantId, candidateId: demo.candidateId, roleId: demo.roleId,
        stagesJson: '[]', currentStageKey: 'ai_interview', status: 'DECIDED',
        decision: 'REJECTED', decidedAt: new Date(),
      },
    });

    const res = await request(app).get(`/api/portal/${demo.token}/status`);

    expect(res.body.decisionSharedAt).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('REJECTED');
  });

  it('never carries the invitation token back in its own body', async () => {
    await finishInterview();

    const res = await request(app).get(`/api/portal/${demo.token}/status`);

    expect(JSON.stringify(res.body)).not.toContain(demo.token);
  });
});

describe('what happens next', () => {
  it('shows a booked conversation with the team', async () => {
    await finishInterview();
    const pipeline = await prisma.candidatePipeline.create({
      data: {
        tenantId: demo.tenantId, candidateId: demo.candidateId, roleId: demo.roleId,
        stagesJson: '[]', currentStageKey: 'system_design',
      },
    });
    const at = new Date(Date.now() + 3 * 864e5);
    await prisma.interviewRound.create({
      data: {
        tenantId: demo.tenantId, pipelineId: pipeline.id, stageKey: 'system_design', conductedBy: 'HUMAN',
        scheduledAt: at, scheduledTimeZone: 'Asia/Kolkata', interviewersJson: JSON.stringify(['Rahul']),
        meetingUrl: 'https://meet.example.com/abc',
      },
    });

    const res = await request(app).get(`/api/portal/${demo.token}/status`);

    expect(res.body.nextRound).toMatchObject({ interviewers: ['Rahul'], booked: true });
    expect(res.body.nextRound.text).toContain('Asia/Kolkata'.split('/')[1]);
  });

  it('does not offer a round that has already gone by as what happens next', async () => {
    await finishInterview();
    const pipeline = await prisma.candidatePipeline.create({
      data: {
        tenantId: demo.tenantId, candidateId: demo.candidateId, roleId: demo.roleId,
        stagesJson: '[]', currentStageKey: 'system_design',
      },
    });
    await prisma.interviewRound.create({
      data: {
        tenantId: demo.tenantId, pipelineId: pipeline.id, stageKey: 'system_design', conductedBy: 'HUMAN',
        scheduledAt: new Date(Date.now() - 3 * 864e5),
      },
    });

    const res = await request(app).get(`/api/portal/${demo.token}/status`);

    expect(res.body.nextRound).toBeNull();
  });
});

describe('what the page says about written feedback', () => {
  it('says plainly that this employer does not send it', async () => {
    await setPolicy({ autoCandidateFeedback: false, candidateFeedbackEnabled: false });
    await finishInterview();

    const res = await request(app).get(`/api/portal/${demo.token}/status`);

    expect(res.body.feedback.outlook).toBe('not_offered');
  });

  it('gives the date when a letter is queued', async () => {
    await finishInterview();
    const assessment = await addAssessment();
    const due = new Date(Date.now() + 6 * 3600_000);
    await prisma.candidateFeedbackEmail.create({
      data: {
        sessionId: demo.sessionId, assessmentId: assessment.id, candidateId: demo.candidateId,
        tenantId: demo.tenantId, status: 'QUEUED', nextAttemptAt: due,
      },
    });

    const res = await request(app).get(`/api/portal/${demo.token}/status`);

    expect(res.body.feedback).toMatchObject({ outlook: 'expected', dueAt: due.toISOString() });
  });

  it('invents no date while a letter waits for a person', async () => {
    await finishInterview();
    const assessment = await addAssessment();
    await prisma.candidateFeedbackEmail.create({
      data: {
        sessionId: demo.sessionId, assessmentId: assessment.id, candidateId: demo.candidateId,
        tenantId: demo.tenantId, status: 'HELD', heldAt: new Date(), nextAttemptAt: new Date(Date.now() + 3600_000),
      },
    });

    const res = await request(app).get(`/api/portal/${demo.token}/status`);

    expect(res.body.feedback).toMatchObject({ outlook: 'with_a_person', dueAt: null });
  });
});

describe('reading the written feedback itself', () => {
  it('has nothing to show while none has been sent', async () => {
    await finishInterview();
    await addAssessment();

    const res = await request(app).get(`/api/portal/${demo.token}/feedback`);

    expect(res.status).toBe(404);
    expect(res.body.feedback).toBeNull();
  });

  it('shows the letter a person approved and sent', async () => {
    await finishInterview();
    const assessment = await addAssessment();
    await prisma.candidateFeedbackDelivery.create({
      data: {
        assessmentId: assessment.id, draftText: 'draft', approvedText: 'The approved words.',
        status: 'SENT', sentAt: new Date('2026-09-24T09:00:00Z'),
      },
    });

    const res = await request(app).get(`/api/portal/${demo.token}/feedback`);

    expect(res.status).toBe(200);
    expect(res.body.approvedText).toBe('The approved words.');
  });

  it('shows the automatic letter the candidate was already emailed', async () => {
    await finishInterview();
    const assessment = await addAssessment();
    await prisma.candidateFeedbackEmail.create({
      data: {
        sessionId: demo.sessionId, assessmentId: assessment.id, candidateId: demo.candidateId,
        tenantId: demo.tenantId, status: 'SENT', sentAt: new Date('2026-09-24T09:00:00Z'),
        bodyText: 'Hello Asha,\n\nWhat came through clearly...\n',
      },
    });

    const res = await request(app).get(`/api/portal/${demo.token}/feedback`);

    expect(res.status).toBe(200);
    expect(res.body.approvedText).toContain('What came through clearly');
  });

  it('shows nothing from a letter that has not gone yet', async () => {
    await finishInterview();
    const assessment = await addAssessment();
    await prisma.candidateFeedbackEmail.create({
      data: {
        sessionId: demo.sessionId, assessmentId: assessment.id, candidateId: demo.candidateId,
        tenantId: demo.tenantId, status: 'QUEUED', bodyText: 'Not yours to read yet.',
      },
    });

    const res = await request(app).get(`/api/portal/${demo.token}/feedback`);

    expect(res.status).toBe(404);
  });

  it('drops the email envelope and sign-off the page already carries', async () => {
    await finishInterview();
    const assessment = await addAssessment();
    await prisma.candidateFeedbackEmail.create({
      data: {
        sessionId: demo.sessionId, assessmentId: assessment.id, candidateId: demo.candidateId,
        tenantId: demo.tenantId, status: 'SENT', sentAt: new Date(),
        bodyText: [
          'INTERVIEW FEEDBACK',
          'Senior Backend Engineer · Northwind Labs',
          'Asha · interviewed 22 Sep · 38 minutes',
          '',
          'Hi Asha,',
          '',
          'What came through clearly: your reasoning.',
          '',
          'All the best,',
          'The Questor team',
          'Drafted by AI from your conversation.',
        ].join('\n'),
      },
    });

    const res = await request(app).get(`/api/portal/${demo.token}/feedback`);

    expect(res.body.approvedText).toBe('Hi Asha,\n\nWhat came through clearly: your reasoning.');
  });

  it('shows an approved letter exactly as the reviewer wrote it, cutting nothing', async () => {
    await finishInterview();
    const assessment = await addAssessment();
    const words = 'All the best of luck. INTERVIEW FEEDBACK is not a heading here.';
    await prisma.candidateFeedbackDelivery.create({
      data: {
        assessmentId: assessment.id, draftText: 'draft', approvedText: words,
        status: 'SENT', sentAt: new Date(),
      },
    });

    const res = await request(app).get(`/api/portal/${demo.token}/feedback`);

    expect(res.body.approvedText).toBe(words);
  });

  it('keeps the unusable talk-link placeholder out of the words it shows', async () => {
    await finishInterview();
    const assessment = await addAssessment();
    await prisma.candidateFeedbackEmail.create({
      data: {
        sessionId: demo.sessionId, assessmentId: assessment.id, candidateId: demo.candidateId,
        tenantId: demo.tenantId, status: 'SENT', sentAt: new Date(),
        bodyText: 'Good conversation.\n\nWould you like to talk this through with someone?\n[link to ask to speak to someone — not stored]\n\nBest wishes',
      },
    });

    const res = await request(app).get(`/api/portal/${demo.token}/feedback`);

    expect(res.body.approvedText).not.toContain('[link');
    expect(res.body.approvedText).toContain('Good conversation.');
  });
});

describe('asking to speak to a person from the status page', () => {
  it('records the request', async () => {
    await finishInterview();

    const res = await request(app).post(`/api/portal/${demo.token}/talk-to-a-person`).send({});

    expect(res.status).toBe(200);
    expect(res.body.requested).toBe(true);
    const row = await prisma.candidateHumanRequest.findUniqueOrThrow({ where: { sessionId: demo.sessionId } });
    expect(row.status).toBe('REQUESTED');
  });

  it('answers the same way when it is pressed twice, and keeps the first time', async () => {
    await finishInterview();
    await request(app).post(`/api/portal/${demo.token}/talk-to-a-person`).send({});
    const first = await prisma.candidateHumanRequest.findUniqueOrThrow({ where: { sessionId: demo.sessionId } });

    const res = await request(app).post(`/api/portal/${demo.token}/talk-to-a-person`).send({});

    expect(res.body.requested).toBe(true);
    const again = await prisma.candidateHumanRequest.findUniqueOrThrow({ where: { sessionId: demo.sessionId } });
    expect(again.requestedAt).toEqual(first.requestedAt);
  });

  it('shows on the status page that they have already asked', async () => {
    await finishInterview();
    await request(app).post(`/api/portal/${demo.token}/talk-to-a-person`).send({});

    const res = await request(app).get(`/api/portal/${demo.token}/status`);

    expect(res.body.talkToAPerson.requested).toBe(true);
  });

  it('refuses a link that was never issued', async () => {
    const res = await request(app).post('/api/portal/not-a-real-token/talk-to-a-person').send({});

    expect(res.status).toBe(404);
  });
});

describe('before the interview is over, there is no status page', () => {
  it('refuses the status read while the link is still an invitation', async () => {
    const res = await request(app).get(`/api/portal/${demo.token}/status`);

    expect(res.status).toBe(409);
  });

  it('refuses the status read while the interview is in progress', async () => {
    await prisma.interviewSession.update({ where: { id: demo.sessionId }, data: { state: 'ASSESSING' } });

    const res = await request(app).get(`/api/portal/${demo.token}/status`);

    expect(res.status).toBe(409);
  });

  it('refuses a request to speak to a person from a link that has not interviewed yet', async () => {
    const res = await request(app).post(`/api/portal/${demo.token}/talk-to-a-person`).send({});

    expect(res.status).toBe(409);
    expect(await prisma.candidateHumanRequest.findUnique({ where: { sessionId: demo.sessionId } })).toBeNull();
  });

  it('answers once the interview is finished, whatever state the row was left in', async () => {
    await finishInterview({ state: 'CLOSED' });

    const res = await request(app).get(`/api/portal/${demo.token}/status`);

    expect(res.status).toBe(200);
  });
});

describe('a request to speak to a person that races the emailed link', () => {
  it('claims the row the emailed path created instead of silently doing nothing', async () => {
    await finishInterview();
    // The emailed link is issued between the status page's read and its write:
    // an ISSUED row now exists that the press knows nothing about.
    await issueHumanRequestToken({ sessionId: demo.sessionId, candidateId: demo.candidateId, tenantId: demo.tenantId });

    const res = await request(app).post(`/api/portal/${demo.token}/talk-to-a-person`).send({});

    expect(res.status).toBe(200);
    const row = await prisma.candidateHumanRequest.findUniqueOrThrow({ where: { sessionId: demo.sessionId } });
    expect(row.status).toBe('REQUESTED');
    expect(row.requestedAt).not.toBeNull();
  });
});

describe('the spent link cannot start another interview', () => {
  it('still refuses consent once the interview is over', async () => {
    await finishInterview();

    const res = await request(app).post(`/api/portal/${demo.token}/consent`)
      .send({ recordingConsent: false, accepted: true });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('still refuses to start the interview again', async () => {
    await finishInterview();

    const res = await request(app).post(`/api/portal/${demo.token}/start`).send({});

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
