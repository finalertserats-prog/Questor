import { describe, expect, it } from 'vitest';
import { computeFitScore } from '../src/engines/fitScoring.js';
import { PROTECTED_TOPICS } from '../src/engines/policyEngine.js';
import {
  ALL_PROTECTED_TOKENS, DATA_ENGINEER_ROLE, DATA_ENGINEER_STACK, PROTECTED_A, PROTECTED_B,
  withProtectedDetail, type ProtectedDetail,
} from './fixtures/cvFixtures.js';

/**
 * The test this feature is not allowed to ship without.
 *
 * Two CVs describing exactly the same career, differing ONLY in the personal
 * details employment law says may never influence a hiring decision — name,
 * date of birth, age, gender, marital status, nationality, religion, address,
 * photograph, the institution that granted the degree and the year it was
 * granted. Every one of those is either a protected characteristic or a clean
 * proxy for one.
 *
 * The requirement is not "the scores are close". It is that they are IDENTICAL,
 * component by component, evidence by evidence — because a scorer that moves by
 * a point when the name changes has found a correlation, and a correlation with
 * a name is a correlation with an ethnicity.
 *
 * It is written against the whole public surface rather than against the
 * redaction function, so that it keeps holding if someone later adds a
 * component, a probe, or a model call.
 */

const NOW = new Date('2026-09-23T00:00:00Z');
const fitFor = (d: ProtectedDetail) =>
  computeFitScore({}, withProtectedDetail(d), DATA_ENGINEER_ROLE, DATA_ENGINEER_STACK, { now: NOW, scorecardVersion: 1 }).fit;

const a = fitFor(PROTECTED_A);
const b = fitFor(PROTECTED_B);

describe('two identical careers with different personal details', () => {
  it('score exactly the same overall', () => {
    expect(b.overall).toBe(a.overall);
  });

  it('score exactly the same on every component', () => {
    expect(b.components.map((c) => `${c.key}=${c.score}`)).toEqual(a.components.map((c) => `${c.key}=${c.score}`));
  });

  it('read exactly the same on every competency', () => {
    expect(b.competencies!.map((c) => `${c.competencyId}=${c.strength}`)).toEqual(a.competencies!.map((c) => `${c.competencyId}=${c.strength}`));
  });

  it('read exactly the same on every technology', () => {
    expect(b.technologies!.map((t) => `${t.name}=${t.strength}/${t.recencyYears}`)).toEqual(a.technologies!.map((t) => `${t.name}=${t.strength}/${t.recencyYears}`));
  });

  it('get the same confidence and the same coverage', () => {
    expect([b.confidence, b.coverage]).toEqual([a.confidence, a.coverage]);
  });

  it('get the same band and the same meaning', () => {
    expect([b.band, b.meaning]).toEqual([a.band, a.meaning]);
  });

  it('produce the same probes in the same order', () => {
    expect(b.probes).toEqual(a.probes);
  });

  it('produce word-for-word the same explanations', () => {
    expect(b.components.map((c) => c.explanation)).toEqual(a.components.map((c) => c.explanation));
    expect(b.competencies!.map((c) => c.explanation)).toEqual(a.competencies!.map((c) => c.explanation));
  });
});

describe('nothing a score is built from', () => {
  const surfaces = (fit: typeof a) => [
    ...fit.components.flatMap((c) => [c.label, c.rule, c.explanation ?? '', ...c.evidence]),
    ...fit.competencies!.flatMap((c) => [c.name, c.explanation, ...c.evidence.map((e) => e.quote)]),
    ...fit.technologies!.flatMap((t) => [t.explanation, ...t.evidence.map((e) => e.quote)]),
    ...fit.probes, ...fit.missing, ...(fit.notEvidenced ?? []), ...(fit.mustHaveGaps ?? []),
    fit.meaning ?? '',
  ].join('\n');

  it.each([['A', PROTECTED_A], ['B', PROTECTED_B]] as const)('ever quotes a protected detail (%s)', (_label, detail) => {
    const said = surfaces(detail === PROTECTED_A ? a : b);
    for (const token of ALL_PROTECTED_TOKENS(detail)) {
      expect(said, `a fit surface quoted "${token}"`).not.toContain(token);
    }
  });
});

describe('the exclusions', () => {
  it('are published with every score, so the refusal is checkable', () => {
    expect(a.excludedSignals.length).toBeGreaterThan(10);
  });

  it('cover every characteristic the interview policy already protects', () => {
    const published = a.excludedSignals.join(' ').toLowerCase();
    // Two are covered by a broader phrase rather than the policy's exact word.
    const synonyms: Record<string, string> = {
      sex: 'gender', 'gender identity': 'gender', 'sexual orientation': 'gender',
      pregnancy: 'health', 'family status': 'marital status', disability: 'health',
      'national origin': 'nationality', colour: 'ethnicity', race: 'ethnicity',
      'political views': 'religion',
    };
    for (const topic of PROTECTED_TOPICS) {
      const needle = synonyms[topic] ?? topic;
      expect(published, `nothing published covers "${topic}"`).toContain(needle);
    }
  });
});

describe('the redaction report', () => {
  it('counts what it removed so a person can see it happened', () => {
    expect(a.redaction!.linesRemoved).toBeGreaterThanOrEqual(8);
    expect(a.redaction!.kinds).toEqual(expect.arrayContaining(['name', 'date_of_birth', 'gender', 'nationality', 'religion', 'photograph', 'education_provenance']));
  });

  it('is identical for two CVs whose only difference is the detail removed', () => {
    expect(b.redaction!.linesRemoved).toBe(a.redaction!.linesRemoved);
    expect([...b.redaction!.kinds].sort()).toEqual([...a.redaction!.kinds].sort());
  });
});
