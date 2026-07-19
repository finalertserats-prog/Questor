import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { wipe, DEMO_JD, DEMO_RESUME } from '../src/seed/demoData.js';
import {
  computeCohenKappa, computeAgreementReport, MINIMUM_N, AGREEMENT_GATE,
  type ShadowObservation,
} from '../src/services/shadowMode.js';

const pairs = (...specs: Array<[string, string, number]>): Array<readonly [string, string]> => {
  const out: Array<readonly [string, string]> = [];
  for (const [a, b, count] of specs) for (let i = 0; i < count; i++) out.push([a, b] as const);
  return out;
};

describe('computeCohenKappa', () => {
  it('reports nothing measured when there are no paired observations', () => {
    const k = computeCohenKappa([]);
    expect(k.n).toBe(0);
    expect(k.kappa).toBeNull();
    expect(k.rawAgreement).toBeNull();
    expect(k.undefinedReason).toMatch(/no paired observations/i);
  });

  it('returns kappa 1 for perfect agreement across two categories', () => {
    const k = computeCohenKappa(pairs(['PROCEED', 'PROCEED', 10], ['DO_NOT_PROGRESS', 'DO_NOT_PROGRESS', 10]));
    expect(k.rawAgreement).toBe(1);
    expect(k.kappa).toBe(1);
  });

  it('matches a hand-computed kappa of 0.4', () => {
    // 2x2 table: 20 yes/yes, 5 yes/no, 10 no/yes, 15 no/no (n=50).
    // p_o = 35/50 = 0.70; p_e = 0.5*0.6 + 0.5*0.4 = 0.50; kappa = 0.2/0.5 = 0.4.
    const k = computeCohenKappa(pairs(['yes', 'yes', 20], ['yes', 'no', 5], ['no', 'yes', 10], ['no', 'no', 15]));
    expect(k.rawAgreement).toBe(0.7);
    expect(k.expectedAgreement).toBe(0.5);
    expect(k.kappa).toBeCloseTo(0.4, 6);
  });

  it('returns kappa near zero when agreement is exactly what chance predicts', () => {
    // Both raters split 50/50 and agree on exactly half => p_o = p_e = 0.5.
    const k = computeCohenKappa(pairs(['a', 'a', 25], ['a', 'b', 25], ['b', 'a', 25], ['b', 'b', 25]));
    expect(k.rawAgreement).toBe(0.5);
    expect(k.kappa).toBeCloseTo(0, 6);
  });

  it('exposes high raw agreement as worthless when one class dominates', () => {
    // The failure mode this statistic exists to catch: 90% raw agreement, but
    // both raters say CONSIDER almost always, so the agreement is chance.
    const k = computeCohenKappa(pairs(
      ['CONSIDER', 'CONSIDER', 18], ['PROCEED', 'CONSIDER', 1], ['CONSIDER', 'PROCEED', 1],
    ));
    expect(k.rawAgreement).toBe(0.9);
    expect(k.kappa).toBeLessThan(0.05);
  });

  it('refuses to report kappa when every observation used a single category', () => {
    // p_e = 1, so kappa is 0/0. Returning 1.0 here would be the most flattering
    // lie available; it must decline instead.
    const k = computeCohenKappa(pairs(['CONSIDER', 'CONSIDER', 40]));
    expect(k.rawAgreement).toBe(1);
    expect(k.kappa).toBeNull();
    expect(k.undefinedReason).toMatch(/undefined/i);
  });

  it('produces a confidence interval that brackets the point estimate', () => {
    const k = computeCohenKappa(pairs(['yes', 'yes', 20], ['yes', 'no', 5], ['no', 'yes', 10], ['no', 'no', 15]));
    expect(k.ci95).not.toBeNull();
    const [lower, upper] = k.ci95!;
    expect(lower).toBeLessThan(k.kappa!);
    expect(upper).toBeGreaterThan(k.kappa!);
  });

  it('narrows the confidence interval as n grows', () => {
    const spec: Array<[string, string, number]> = [['yes', 'yes', 20], ['yes', 'no', 5], ['no', 'yes', 10], ['no', 'no', 15]];
    const small = computeCohenKappa(pairs(...spec));
    const large = computeCohenKappa(pairs(...spec.map(([a, b, c]) => [a, b, c * 10] as [string, string, number])));
    expect(large.kappa).toBeCloseTo(small.kappa!, 6);
    const width = (k: typeof small) => k.ci95![1] - k.ci95![0];
    expect(width(large)).toBeLessThan(width(small));
  });

  it('returns a negative kappa when raters agree less than chance', () => {
    const k = computeCohenKappa(pairs(['a', 'b', 20], ['b', 'a', 20]));
    expect(k.rawAgreement).toBe(0);
    expect(k.kappa).toBeLessThan(0);
  });
});

const observation = (
  id: string, human: string, ai: string,
  competencies: ShadowObservation['competencies'] = [],
): ShadowObservation => ({ assessmentId: id, humanDisposition: human, aiRecommendation: ai, competencies });

describe('computeAgreementReport', () => {
  it('says plainly that nothing is known when no blind verdicts exist', () => {
    const report = computeAgreementReport([], 12);
    expect(report.sampleSize.blindVerdicts).toBe(0);
    expect(report.sufficiency.sufficient).toBe(false);
    expect(report.sufficiency.statement).toMatch(/no blind human verdicts/i);
    expect(report.disposition.kappa).toBeNull();
    expect(report.gate.met).toBeNull();
    expect(report.gate.statement).toMatch(/not met/i);
  });

  it('never reports the gate as met on an undersized sample, even at perfect agreement', () => {
    const obs = Array.from({ length: MINIMUM_N - 1 }, (_, i) =>
      observation(`a${i}`, i % 2 === 0 ? 'PROCEED' : 'DO_NOT_PROGRESS', i % 2 === 0 ? 'PROCEED' : 'DO_NOT_PROGRESS'));
    const report = computeAgreementReport(obs, obs.length);
    expect(report.disposition.rawAgreement).toBe(1);
    expect(report.sufficiency.sufficient).toBe(false);
    expect(report.gate.met).toBeNull();
  });

  it('evaluates the gate against the lower CI bound once n is sufficient', () => {
    const obs = Array.from({ length: 60 }, (_, i) =>
      observation(`a${i}`, i % 2 === 0 ? 'PROCEED' : 'DO_NOT_PROGRESS', i % 2 === 0 ? 'PROCEED' : 'DO_NOT_PROGRESS'));
    const report = computeAgreementReport(obs, 60);
    expect(report.sufficiency.sufficient).toBe(true);
    expect(report.gate.met).toBe(true);
    expect(report.disposition.ci95![0]).toBeGreaterThanOrEqual(AGREEMENT_GATE);
  });

  it('does not report the gate as met when the CI lower bound sits below it', () => {
    // Mostly agreeing but noisy: point estimate is decent, CI is wide.
    const obs = Array.from({ length: 40 }, (_, i) => {
      const human = i % 2 === 0 ? 'PROCEED' : 'DO_NOT_PROGRESS';
      const ai = i % 5 === 0 ? 'CONSIDER' : human;
      return observation(`a${i}`, human, ai);
    });
    const report = computeAgreementReport(obs, 40);
    expect(report.sufficiency.sufficient).toBe(true);
    expect(report.disposition.ci95![0]).toBeLessThan(AGREEMENT_GATE);
    expect(report.gate.met).toBe(false);
    expect(report.gate.statement).toMatch(/must not/i);
  });

  it('builds a confusion matrix of human verdict against AI recommendation', () => {
    const report = computeAgreementReport([
      observation('a', 'PROCEED', 'PROCEED'),
      observation('b', 'PROCEED', 'CONSIDER'),
      observation('c', 'DO_NOT_PROGRESS', 'CONSIDER'),
    ], 3);
    expect(report.disposition.confusionMatrix.PROCEED?.PROCEED).toBe(1);
    expect(report.disposition.confusionMatrix.PROCEED?.CONSIDER).toBe(1);
    expect(report.disposition.confusionMatrix.DO_NOT_PROGRESS?.CONSIDER).toBe(1);
    expect(report.disposition.humanDistribution.PROCEED).toBe(2);
    expect(report.disposition.aiDistribution.CONSIDER).toBe(2);
  });

  it('computes per-competency agreement and the direction of disagreement', () => {
    const report = computeAgreementReport([
      observation('a', 'PROCEED', 'PROCEED', [
        { competencyId: 'c1', competencyName: 'Data Modelling', humanLevel: 3, aiLevel: 4 },
        { competencyId: 'c2', competencyName: 'Communication', humanLevel: 4, aiLevel: 4 },
      ]),
      observation('b', 'CONSIDER', 'CONSIDER', [
        { competencyId: 'c1', competencyName: 'Data Modelling', humanLevel: 2, aiLevel: 4 },
      ]),
    ], 2);

    const modelling = report.competencyLevel.byCompetency.find((c) => c.competencyId === 'c1')!;
    expect(modelling.n).toBe(2);
    expect(modelling.exactAgreement).toBe(0);
    // Positive mean signed error => the AI scores this competency higher than
    // blind reviewers do. ((4-3) + (4-2)) / 2 = 1.5.
    expect(modelling.meanSignedError).toBe(1.5);
    expect(modelling.withinOneLevel).toBe(0.5);
    expect(report.competencyLevel.n).toBe(3);
  });

  it('reports null competency-level statistics when no competency was scored by both', () => {
    const report = computeAgreementReport([observation('a', 'PROCEED', 'PROCEED')], 1);
    expect(report.competencyLevel.n).toBe(0);
    expect(report.competencyLevel.exactAgreement).toBeNull();
    expect(report.competencyLevel.withinOneLevel).toBeNull();
    expect(report.competencyLevel.byCompetency).toEqual([]);
  });

  it('always carries the caveat that agreement is not validity', () => {
    const report = computeAgreementReport([observation('a', 'PROCEED', 'PROCEED')], 1);
    expect(report.caveats.join(' ')).toMatch(/does not establish/i);
    expect(report.caveats.join(' ')).toMatch(/anchoring/i);
  });

  it('flags the dominant-class trap in the caveats when kappa is undefined', () => {
    const obs = Array.from({ length: 40 }, (_, i) => observation(`a${i}`, 'CONSIDER', 'CONSIDER'));
    const report = computeAgreementReport(obs, 40);
    expect(report.disposition.rawAgreement).toBe(1);
    expect(report.disposition.kappa).toBeNull();
    expect(report.gate.met).toBeNull();
    expect(report.caveats.join(' ')).toMatch(/carries no information/i);
  });
});

// ---------------------------------------------------------------------------
// Route-level behaviour. Safe to wipe the database here: vitest.config.ts sets
// fileParallelism: false, so test files never run concurrently.
// ---------------------------------------------------------------------------

const app = createApp();
let token = '';
let assessmentId = '';

beforeAll(async () => {
  await wipe();
  const reg = await request(app).post('/api/auth/register')
    .send({ email: 'shadow@questor.local', password: 'correct-horse-battery-staple', name: 'Shadow', tenantName: 'Shadow Org' });
  token = reg.body.token;
  const auth = { Authorization: `Bearer ${token}` };

  const role = await request(app).post('/api/roles').set(auth)
    .send({ sourceType: 'paste', sourceText: DEMO_JD, title: 'Senior Data Engineer', useLlm: false });
  const roleId = role.body.role.id;
  await request(app).post(`/api/roles/${roleId}/approve`).set(auth).send({});

  const cand = await request(app).post('/api/candidates').set(auth)
    .send({ fullName: 'Priya Sharma', email: 'priya.shadow@e.com', roleId });
  await request(app).post(`/api/candidates/${cand.body.candidate.id}/resume`).set(auth).field('text', DEMO_RESUME);

  const session = await request(app).post('/api/interviews').set(auth)
    .send({ candidateId: cand.body.candidate.id, durationMinutes: 45, approve: true });
  const sessionId = session.body.session.id;

  const start = await request(app).post(`/api/interviews/${sessionId}/start`).set(auth).send({});
  let done = start.body.turn.done;
  let guard = 0;
  while (!done && guard < 40) {
    guard++;
    const turn = await request(app).post(`/api/interviews/${sessionId}/turn`).set(auth)
      .send({ text: 'I owned a Snowflake pipeline end to end, made recovery idempotent and cut failures by 60%.' });
    done = turn.body.turn.done;
    if (turn.body.assessmentId) assessmentId = turn.body.assessmentId;
  }
});

const authHeader = () => ({ Authorization: `Bearer ${token}` });

describe('shadow mode routes', () => {
  it('serves /shadow-metrics without it being captured by the /:id route', async () => {
    const res = await request(app).get('/api/assessments/shadow-metrics').set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.sampleSize.blindVerdicts).toBe(0);
    expect(res.body.gate.met).toBeNull();
    expect(res.body.sufficiency.statement).toMatch(/no blind human verdicts/i);
  });

  it('exposes only neutral fields on the blind view', async () => {
    const res = await request(app).get(`/api/assessments/${assessmentId}/blind`).set(authHeader());
    expect(res.status).toBe(200);
    // Assert on structure, not on prose: `withheld` and `instructions` legitimately
    // NAME the hidden fields, so substring-scanning the payload would false-positive.
    expect(Object.keys(res.body).sort()).toEqual([
      'assessmentId', 'blindVerdictRecorded', 'candidate', 'competencies',
      'instructions', 'levelScale', 'role', 'sessionId', 'transcript', 'withheld',
    ]);
    for (const competency of res.body.competencies) {
      expect(Object.keys(competency).sort()).toEqual([
        'category', 'definition', 'evidence', 'id', 'indicators', 'name', 'requiredLevel',
      ]);
    }
    for (const turn of res.body.transcript) {
      expect(Object.keys(turn).sort()).toEqual(['competencyId', 'index', 'speaker', 'text']);
    }
  });

  it('still shows the reviewer the evidence and transcript they need to judge', async () => {
    const res = await request(app).get(`/api/assessments/${assessmentId}/blind`).set(authHeader());
    expect(res.body.competencies.length).toBeGreaterThan(0);
    expect(res.body.transcript.length).toBeGreaterThan(0);
    expect(res.body.competencies.some((c: { evidence: unknown[] }) => c.evidence.length > 0)).toBe(true);
    expect(res.body.blindVerdictRecorded).toBe(false);
  });

  it('refuses to reveal the AI output before a blind verdict is recorded', async () => {
    const res = await request(app).get(`/api/assessments/${assessmentId}/reveal`).set(authHeader());
    expect(res.status).toBe(409);
  });

  it('records a verdict, reveals afterwards, and counts the pair in the metrics', async () => {
    const blind = await request(app).get(`/api/assessments/${assessmentId}/blind`).set(authHeader());
    const competencyLevels = blind.body.competencies.slice(0, 2)
      .map((c: { id: string }) => ({ competencyId: c.id, level: 3 }));

    const posted = await request(app).post(`/api/assessments/${assessmentId}/blind-verdict`).set(authHeader())
      .send({ disposition: 'CONSIDER', reason: 'Evidence was solid but not deep.', competencyLevels });
    expect(posted.status).toBe(201);

    const reveal = await request(app).get(`/api/assessments/${assessmentId}/reveal`).set(authHeader());
    expect(reveal.status).toBe(200);
    expect(reveal.body.result.recommendation).toBeTruthy();

    const metrics = await request(app).get('/api/assessments/shadow-metrics').set(authHeader());
    expect(metrics.body.sampleSize.blindVerdicts).toBe(1);
    expect(metrics.body.sufficiency.sufficient).toBe(false);
    // n=1: the endpoint must decline to conclude rather than report 100% agreement.
    expect(metrics.body.gate.met).toBeNull();
  });

  it('will not let a reviewer rewrite their blind verdict after the reveal', async () => {
    const res = await request(app).post(`/api/assessments/${assessmentId}/blind-verdict`).set(authHeader())
      .send({ disposition: 'PROCEED', reason: 'Changed my mind after seeing the AI score.' });
    expect(res.status).toBe(409);
  });
});
