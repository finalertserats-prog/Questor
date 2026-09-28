import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Competency, RoleSuccessProfile, TurnRecord } from '../src/domain/types.js';

/**
 * A grading outage is not a score of zero.
 *
 * When the provider is configured but cannot grade, every competency comes back
 * `gradingUnavailable` with no level. The weighted mean over an empty set then
 * produced overallScore 0, the report printed "Overall: 0/100", and the ATS
 * export shipped that 0 into the system of record for hiring decisions. A
 * candidate who answered perfectly well was recorded as having scored nothing
 * because our vendor was down.
 *
 * The suite runs with LLM_PROVIDER=heuristic, where the provider reports
 * enabled=false and the keyword fallback still produces a score. To reproduce
 * the outage we point config at Anthropic and swap the connector for one that
 * always fails, so the real evaluator path runs with grading unavailable.
 */

vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>();
  return { config: { ...actual.config, llm: { ...actual.config.llm, provider: 'anthropic', anthropicKey: 'test-key' } } };
});

vi.mock('../src/providers/llm/anthropic.js', () => ({
  AnthropicLlmProvider: class {
    name = 'anthropic';
    get enabled(): boolean { return true; }
    async generate() { throw new Error('provider unavailable'); }
  },
}));

const { evaluate } = await import('../src/engines/evaluator.js');
const { renderReportMarkdown } = await import('../src/engines/reportWriter.js');
const { _resetLlm } = await import('../src/providers/llm/index.js');
const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/db.js');
const { wipe, createDemoData } = await import('../src/seed/demoData.js');

const app = createApp();

function competency(id: string, name: string): Competency {
  return {
    id, name, definition: `Demonstrates ${name}.`, category: 'technical', classification: 'essential',
    weight: 0.5, requiredLevel: 3, targetLevel: 4, indicators: [`shows ${name}`], evidenceModes: ['behavioral_example'],
  };
}

const PIPELINES = competency('pipelines', 'Pipeline reliability');
const MODELLING = competency('modelling', 'Data modelling');

function role(): RoleSuccessProfile {
  return {
    roleContext: 'Senior Data Engineer', outcomes: [], responsibilities: [],
    competencies: [PIPELINES, MODELLING],
    scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
    policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
    redFlags: [], seniority: 'senior',
  };
}

function turn(id: string, text: string, competencyId: string): TurnRecord {
  return { id, index: 0, speaker: 'candidate', text, startMs: 0, endMs: 30_000, confidence: 0.9, competencyId };
}

const ANSWERS = [
  turn(
    'turn-1',
    'I owned the ledger pipeline end to end. When reconciliation drift appeared I built an idempotent '
    + 'replay so a failed run could be re-driven safely, and unmatched rows fell from two thousand a day '
    + 'to under thirty over the quarter.',
    'pipelines',
  ),
  turn(
    'turn-2',
    'I designed the finance star schema with slowly changing dimensions for account hierarchy, which cut '
    + 'the month-end close query from ninety seconds to under eight by partitioning on the load date.',
    'modelling',
  ),
];

async function assessWithGradingDown() {
  return evaluate({ role: role(), turns: ANSWERS, rubricVersion: 'v1', assessmentVersion: 'A-1' });
}

beforeEach(() => { _resetLlm(); });

describe('an assessment where nothing could be graded', () => {
  it('reports no overall score rather than a score of zero', async () => {
    const result = await assessWithGradingDown();

    expect(result.overallScore).toBeNull();
  });

  it('recommends nothing, because nothing was measured', async () => {
    const result = await assessWithGradingDown();

    expect(result.recommendation).toBe('SCORING_UNAVAILABLE');
  });

  it('still records that grading, not the candidate, is the reason', async () => {
    const result = await assessWithGradingDown();

    expect(result.competencies.every((c) => c.gradingUnavailable)).toBe(true);
  });
});

describe('the report for an assessment that could not be graded', () => {
  it('says scoring was unavailable', async () => {
    const result = await assessWithGradingDown();

    const md = renderReportMarkdown({ candidateName: 'Priya Sharma', roleTitle: 'Senior Data Engineer', assessment: result });

    expect(md).toMatch(/scoring (was )?unavailable/i);
  });

  it('never prints a number the reader could mistake for a result', async () => {
    // The report is what gets pasted into an ATS or forwarded to a hiring
    // manager. "Overall: 0/100" travels; the caveat underneath it does not.
    const result = await assessWithGradingDown();

    const md = renderReportMarkdown({ candidateName: 'Priya Sharma', roleTitle: 'Senior Data Engineer', assessment: result });

    expect(md).not.toContain('0/100');
  });
});

describe('exporting an assessment that has no score', () => {
  async function seedUnscoredAssessment() {
    await wipe();
    const ids = await createDemoData();
    const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
    const result = await assessWithGradingDown();
    const assessment = await prisma.assessmentVersion.create({
      data: {
        sessionId: ids.sessionId, scorecardId: ids.scorecardId,
        recommendation: result.recommendation, confidence: result.confidence,
        evidenceCoverage: result.evidenceCoverage, resultJson: JSON.stringify(result),
      },
    });
    return { assessmentId: assessment.id, token: login.body.token as string };
  }

  it('refuses to push it to the ATS', async () => {
    const { assessmentId, token } = await seedUnscoredAssessment();

    const res = await request(app).post(`/api/assessments/${assessmentId}/export`)
      .set('Authorization', `Bearer ${token}`).send({});

    expect(res.status).toBe(409);
  });

  it('explains why in plain words', async () => {
    const { assessmentId, token } = await seedUnscoredAssessment();

    const res = await request(app).post(`/api/assessments/${assessmentId}/export`)
      .set('Authorization', `Bearer ${token}`).send({});

    expect(res.body.error).toMatch(/could not be scored/i);
  });
});
