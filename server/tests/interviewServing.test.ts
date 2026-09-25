import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { servingMeta, summariseServing } from '../src/services/interviewServing.js';

/**
 * Which turns of an interview ran below the primary model is recorded on the
 * turn and shown with the assessment, so a reviewer does not judge the
 * candidate as if every probe had been full quality.
 */

const app = createApp();

describe('servingMeta', () => {
  it('adds nothing to a turn no model was asked about', () => {
    expect(servingMeta([])).toEqual({});
  });

  it('marks a turn served by the primary as not degraded', () => {
    expect(servingMeta([{ fn: 'live_interviewer', layer: 'primary', provider: 'openai' }]))
      .toEqual({ serving: { layer: 'primary', degraded: false } });
  });

  it('marks a turn the local model wrote as degraded', () => {
    expect(servingMeta([{ fn: 'live_interviewer', layer: 'local', provider: 'ollama' }]))
      .toEqual({ serving: { layer: 'local', degraded: true } });
  });

  it('marks a turn left to the built-in writer by an outage as degraded, with the reason', () => {
    expect(servingMeta([{ fn: 'live_interviewer', layer: 'built-in', provider: 'built-in', failure: 'quota' }]))
      .toEqual({ serving: { layer: 'built-in', degraded: true, failure: 'quota' } });
  });

  it('does not call an ordinary built-in turn degraded (the model reply was screened out, as always)', () => {
    expect(servingMeta([{ fn: 'live_interviewer', layer: 'built-in', provider: 'built-in' }]))
      .toEqual({ serving: { layer: 'built-in', degraded: false } });
  });

  it('reports the lowest layer when a turn made several calls', () => {
    expect(servingMeta([
      { fn: 'candidate_question', layer: 'primary', provider: 'openai' },
      { fn: 'live_interviewer', layer: 'local', provider: 'ollama' },
    ])).toEqual({ serving: { layer: 'local', degraded: true } });
  });
});

describe('summariseServing', () => {
  const row = (index: number, meta: unknown) => ({ index, speaker: 'agent', metaJson: JSON.stringify(meta) });

  it('is not degraded when no turn recorded a step down', () => {
    expect(summariseServing([row(0, { kind: 'opening' }), row(2, { serving: { layer: 'primary', degraded: false } })]))
      .toEqual({ degraded: false, turns: [], counts: { primary: 1, local: 0, builtIn: 0 } });
  });

  it('lists the degraded turns by transcript index', () => {
    expect(summariseServing([
      row(2, { serving: { layer: 'primary', degraded: false } }),
      row(4, { serving: { layer: 'local', degraded: true } }),
      row(6, { serving: { layer: 'built-in', degraded: true, failure: 'network' } }),
    ])).toEqual({
      degraded: true,
      turns: [{ index: 4, layer: 'local' }, { index: 6, layer: 'built-in', failure: 'network' }],
      counts: { primary: 1, local: 1, builtIn: 1 },
    });
  });

  it('skips a damaged metadata record rather than failing the page', () => {
    expect(summariseServing([{ index: 1, speaker: 'agent', metaJson: '{not json' }]).degraded).toBe(false);
  });
});

describe('GET /api/assessments/:id', () => {
  beforeEach(async () => { await wipe(); });

  it('shows the reviewer which turns ran on a fallback', async () => {
    const ids = await createDemoData();
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'REVIEW_READY', completedAt: new Date() } });
    const top = await prisma.turn.findFirst({ where: { sessionId: ids.sessionId }, orderBy: { index: 'desc' }, select: { index: true } });
    const index = (top?.index ?? -1) + 1;
    await prisma.turn.create({
      data: {
        sessionId: ids.sessionId, index, speaker: 'agent', text: 'So the tracker cut fielding time. How did you test it?',
        metaJson: JSON.stringify({ kind: 'question', serving: { layer: 'local', degraded: true } }),
      },
    });
    const created = await prisma.assessmentVersion.create({
      data: {
        sessionId: ids.sessionId, scorecardId: ids.scorecardId, recommendation: 'PROCEED', confidence: 0.8, evidenceCoverage: 0.7,
        resultJson: JSON.stringify({
          assessmentVersion: 'A', roleScorecardVersion: 's', recommendation: 'PROCEED', confidence: 0.8, evidenceCoverage: 0.7, overallScore: 80,
          competencies: [], strengths: [], concerns: [], contradictions: [], openQuestions: [], limitations: [], summary: 'x',
        }),
      },
    });
    const auth = { Authorization: `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}` };
    const res = await request(app).get(`/api/assessments/${created.id}`).set(auth);
    expect(res.body.servingMode).toMatchObject({ degraded: true, turns: [{ index, layer: 'local' }] });
  });
});
