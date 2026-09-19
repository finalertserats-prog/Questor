import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData, type DemoIds } from '../src/seed/demoData.js';
import { seedInterviewers, backfillLegacyInterviewers } from '../src/services/interviewers.js';
import { interviewerIntro } from '../src/domain/interviewerModel.js';

// Sessions created before the interviewer catalogue carry the retired default
// name. Those the candidate has not started get a real interviewer; finished
// ones keep the name they were conducted under.

const RETIRED = ['Schr', 'anders'].join('');
const LEGACY_DISCLOSURE = `Hello, I'm ${RETIRED}, an AI interviewer for this first-round conversation. Your voice is transcribed as we talk.`;
const app = createApp();
let ids: DemoIds;

beforeEach(async () => {
  await wipe();
  await prisma.aIInterviewer.deleteMany();
  await prisma.voiceProfile.deleteMany();
  await seedInterviewers('webspeech');
  ids = await createDemoData();
});

async function makeLegacy(state: string, consented: boolean): Promise<void> {
  const consent = { disclosureText: LEGACY_DISCLOSURE, ...(consented ? { consentedAt: '2026-09-01T10:00:00.000Z' } : {}) };
  await prisma.interviewSession.update({
    where: { id: ids.sessionId },
    data: { state, personaJson: JSON.stringify({ name: RETIRED, tone: 'formal' }), consentJson: JSON.stringify(consent) },
  });
}

async function stored(): Promise<{ persona: Record<string, unknown>; consent: Record<string, unknown> }> {
  const s = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } });
  return { persona: JSON.parse(s.personaJson) as Record<string, unknown>, consent: JSON.parse(s.consentJson) as Record<string, unknown> };
}

describe('backfillLegacyInterviewers', () => {
  it('assigns an interviewer to a session not yet started', async () => {
    await makeLegacy('INVITED', false);
    await backfillLegacyInterviewers(() => 1);
    expect((await stored()).persona).toMatchObject({ interviewerId: 'maya', name: 'Maya' });
  });

  it('keeps the stored tone untouched', async () => {
    await makeLegacy('INVITED', false);
    await backfillLegacyInterviewers(() => 1);
    expect((await stored()).persona.tone).toBe('formal');
  });

  it('re-introduces an unconsented disclosure with the new name', async () => {
    await makeLegacy('INVITED', false);
    await backfillLegacyInterviewers(() => 1);
    expect((await stored()).consent.disclosureText).toBe(`${interviewerIntro('Maya')} Your voice is transcribed as we talk.`);
  });

  it('leaves a disclosure the candidate already agreed to as it was', async () => {
    await makeLegacy('CONSENTED', true);
    await backfillLegacyInterviewers(() => 1);
    expect((await stored()).consent.disclosureText).toBe(LEGACY_DISCLOSURE);
  });

  it('keeps the recorded name on a finished interview', async () => {
    await makeLegacy('REVIEW_READY', true);
    await backfillLegacyInterviewers(() => 1);
    expect((await stored()).persona).toEqual({ name: RETIRED, tone: 'formal' });
  });

  it('keeps the recorded name on an interview in progress', async () => {
    await makeLegacy('ASSESSING', true);
    await backfillLegacyInterviewers(() => 1);
    expect((await stored()).persona.name).toBe(RETIRED);
  });

  it('is idempotent: a second run changes nothing', async () => {
    await makeLegacy('INVITED', false);
    await backfillLegacyInterviewers(() => 1);
    expect(await backfillLegacyInterviewers(() => 3)).toBe(0);
  });

  it('assigns on first read of the invitation link', async () => {
    await makeLegacy('INVITED', false);
    const res = await request(app).get(`/api/portal/${ids.token}`);
    expect(res.body.persona.name).not.toBe(RETIRED);
  });
});
