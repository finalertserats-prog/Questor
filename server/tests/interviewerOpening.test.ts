import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData, DEMO_JD, DEMO_RESUME, type DemoIds } from '../src/seed/demoData.js';
import { seedInterviewers } from '../src/services/interviewers.js';
import { interviewerIntro } from '../src/domain/interviewerModel.js';
import { extractRoleHeuristic } from '../src/engines/roleIntelligence.js';
import { normalizeProfile } from '../src/engines/resumeParser.js';
import { computeFitScore } from '../src/engines/fitScoring.js';
import { buildInterviewPlan } from '../src/engines/interviewPlanner.js';
import { directorDecide } from '../src/engines/interviewDirector.js';
import { nextUtterance, type Persona } from '../src/engines/conversationRuntime.js';
import type { TurnRecord } from '../src/domain/types.js';

// The interviewer opens with its own name, then the full disclosure; after
// that, who the interviewer is changes nothing about what is asked.

const app = createApp();
let ids: DemoIds;

beforeEach(async () => {
  await wipe();
  await prisma.aIInterviewer.deleteMany();
  await prisma.voiceProfile.deleteMany();
  await seedInterviewers('webspeech');
  ids = await createDemoData();
});

async function setSession(persona: Record<string, unknown>, disclosureText: string): Promise<void> {
  const session = await prisma.interviewSession.findUniqueOrThrow({ where: { id: ids.sessionId } });
  const consent = { ...(JSON.parse(session.consentJson) as Record<string, unknown>), disclosureText };
  await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { personaJson: JSON.stringify(persona), consentJson: JSON.stringify(consent) } });
}

async function openingLine(): Promise<string> {
  const res = await request(app).post(`/api/portal/${ids.token}/start`).send({});
  return res.body.turn.text as string;
}

const DISCLOSURE = 'Your voice is transcribed as we talk — no audio recording is kept, but the written transcript is, and a person on the hiring team reads it. You can ask me to repeat anything or request a pause at any time.';

describe('the spoken opening', () => {
  it('introduces the interviewer by name', async () => {
    await setSession({ interviewerId: 'maya', name: 'Maya', tone: 'warm' }, `${interviewerIntro('Maya')} ${DISCLOSURE}`);
    expect((await openingLine()).startsWith(interviewerIntro('Maya'))).toBe(true);
  });

  it('keeps the whole disclosure after the introduction', async () => {
    await setSession({ interviewerId: 'maya', name: 'Maya', tone: 'warm' }, `${interviewerIntro('Maya')} ${DISCLOSURE}`);
    expect(await openingLine()).toContain(DISCLOSURE);
  });

  it('speaks the session interviewer name over an older consented introduction', async () => {
    await setSession({ interviewerId: 'theo', name: 'Theo', tone: 'warm' }, `Hello, I'm Oldname, an AI interviewer for this first-round conversation. ${DISCLOSURE}`);
    expect(await openingLine()).toBe(`${interviewerIntro('Theo')} ${DISCLOSURE}`);
  });

  it('still opens with the AI disclosure when the session has no disclosure text', async () => {
    await setSession({ interviewerId: 'elena', name: 'Elena', tone: 'warm' }, '');
    const line = await openingLine();
    expect([line.startsWith(interviewerIntro('Elena')), line.includes('a person on the hiring team reads it')]).toEqual([true, true]);
  });
});

describe('the interviewer changes nothing but the name', () => {
  const ANSWERS = [
    'Yes, I can hear you clearly.',
    'I am a senior data engineer at FinEdge, owning the Snowflake platform for two hundred analysts.',
    'I designed the dimensional models and built Airflow and dbt pipelines processing four terabytes a day.',
    'I led the Redshift to Snowflake migration and cut warehouse cost by thirty five percent.',
    'I reduced pipeline failures by sixty percent through idempotent recovery and better detection.',
    'I optimised critical SQL from ninety seconds to under eight using partitioning and clustering.',
    'I set up observability, alerting and on-call runbooks with clear SLAs.',
    'When analysts disagreed with product on a metric, I brought both into one review and wrote the definition down.',
    'No further questions, thank you.',
  ];

  // Built once and shared: competency ids are minted per extraction, and the
  // same settings means the same plan.
  const extraction = extractRoleHeuristic(DEMO_JD, 'Senior Data Engineer');
  const resumeProfile = normalizeProfile(DEMO_RESUME);
  const { fit } = computeFitScore(resumeProfile, DEMO_RESUME, extraction.profile);
  const plan = buildInterviewPlan({ role: extraction.profile, fit, durationMinutes: 45, language: 'en', modules: [] });

  async function conduct(persona: Persona): Promise<string[]> {
    const turns: TurnRecord[] = [];
    const spoken: string[] = [];
    for (const answer of ANSWERS) {
      const signal = directorDecide({ plan, turns, elapsedMinutes: turns.length * 0.66 });
      const utter = await nextUtterance({ plan, signal, turns, role: extraction.profile, persona, disclosureText: '' });
      spoken.push(utter.text.split(persona.name).join('<NAME>'));
      turns.push({ id: `a${turns.length}`, index: turns.length, speaker: 'agent', text: utter.text, startMs: turns.length * 40_000, endMs: turns.length * 40_000 + 12_000, confidence: 1, competencyId: utter.competencyId });
      turns.push({ id: `c${turns.length}`, index: turns.length, speaker: 'candidate', text: answer, startMs: turns.length * 40_000, endMs: turns.length * 40_000 + 30_000, confidence: 0.9, competencyId: utter.competencyId });
    }
    return spoken;
  }

  it('asks exactly the same things of the candidate for two interviewers with the same settings', async () => {
    const maya = await conduct({ name: 'Maya', tone: 'formal' });
    const theo = await conduct({ name: 'Theo', tone: 'formal' });
    expect(maya).toEqual(theo);
  });
});
