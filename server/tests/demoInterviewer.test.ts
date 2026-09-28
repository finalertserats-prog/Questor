import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { provisionDemoTenant } from '../src/services/demoAccess.js';
import { seedInterviewers } from '../src/services/interviewers.js';

// The demo sandbox's sample interview is conducted by a random catalogue
// interviewer, exactly as a real interview created with the default would be.

beforeEach(async () => {
  await wipe();
  await prisma.aIInterviewer.deleteMany();
  await prisma.voiceProfile.deleteMany();
  await seedInterviewers('webspeech');
});

async function samplePersona(): Promise<Record<string, unknown>> {
  const { sessionId } = await provisionDemoTenant({ name: 'Dana Visitor', email: 'dana@example.com', company: 'Example Co' });
  const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: sessionId } });
  return JSON.parse(session.personaJson) as Record<string, unknown>;
}

describe('demo sandbox interviewer', () => {
  it('assigns an active catalogue interviewer to the sample interview', async () => {
    await prisma.aIInterviewer.updateMany({ where: { id: { not: 'maya' } }, data: { active: false } });
    expect(await samplePersona()).toMatchObject({ interviewerId: 'maya', name: 'Maya' });
  });

  it('keeps the default tone', async () => {
    expect((await samplePersona()).tone).toBe('warm');
  });
});
