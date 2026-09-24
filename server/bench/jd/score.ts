import { proposeFromJd } from '../../src/engines/jdCompetencies.js';
import { competencyKeyOf } from '../../src/domain/calibration.js';
import { resolveCanonical } from '../../src/domain/taxonomy/index.js';
import { legacyClassification, legacyPropose } from './legacy.js';
import type { JdGoldCase } from './types.js';

/**
 * The measurement.
 *
 * Precision is the one that matters here, and it is the one an extractor
 * optimised for "find everything" quietly destroys. A spurious competency is
 * not a cosmetic error: it becomes something every candidate for the role is
 * measured and scored against, it feeds the interview's questions, the
 * evidence quotes, the assessment and the calibration loop. Recall failures
 * are visible to the person reviewing the scorecard — they can see SQL is
 * missing. Precision failures look exactly like correct output.
 */

export interface CaseResult {
  readonly id: string;
  readonly domain: string;
  readonly title: string;
  readonly proposed: readonly string[];
  readonly truePositives: readonly string[];
  readonly falsePositives: readonly string[];
  readonly falseNegatives: readonly string[];
  /** Forbidden competencies that were proposed anyway. Every one of these is a defect. */
  readonly forbiddenHits: readonly string[];
  /** Expected must-haves that came out as something other than essential. */
  readonly mustHaveMisses: readonly string[];
  /** JD-derived proposals with no source span. Must always be empty. */
  readonly unsupported: readonly string[];
  readonly precision: number;
  readonly recall: number;
}

export interface BenchSummary {
  readonly cases: readonly CaseResult[];
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly forbiddenHits: number;
  readonly mustHaveMisses: number;
  readonly unsupported: number;
  readonly byDomain: ReadonlyArray<{ domain: string; cases: number; precision: number; recall: number }>;
}

function keys(names: readonly string[]): Set<string> {
  // Labels are written as canonical names; resolving them means a label may
  // also be written as any alias without silently becoming a miss.
  return new Set(names.map((n) => resolveCanonical(n)?.key ?? competencyKeyOf(n)));
}

export function runCase(gold: JdGoldCase, engine: 'current' | 'legacy' = 'current'): CaseResult {
  // Baselines are on every role by construction and are excluded from both
  // sides of the measurement, so they cannot flatter either number.
  const fromJd = engine === 'legacy'
    ? legacyPropose(gold.jd).map((name) => ({
      name,
      key: resolveCanonical(name)?.key ?? competencyKeyOf(name),
      classification: legacyClassification(name, gold.jd),
      spans: [] as unknown[],
      origin: 'jd' as const,
    }))
    : proposeFromJd(gold.jd, { title: gold.title, band: gold.band }).filter((p) => p.origin === 'jd');

  const proposedKeys = new Set(fromJd.map((p) => p.key ?? competencyKeyOf(p.name)));
  const expected = keys(gold.expect);
  const forbidden = keys(gold.forbid);
  const mustHave = keys(gold.mustHave);

  const truePositives = [...proposedKeys].filter((k) => expected.has(k));
  const falsePositives = [...proposedKeys].filter((k) => !expected.has(k));
  const falseNegatives = [...expected].filter((k) => !proposedKeys.has(k));

  const essential = new Set(
    fromJd.filter((p) => p.classification === 'essential').map((p) => p.key ?? competencyKeyOf(p.name)),
  );

  return {
    id: gold.id,
    domain: gold.domain,
    title: gold.title,
    proposed: fromJd.map((p) => p.name),
    truePositives,
    falsePositives,
    falseNegatives,
    forbiddenHits: [...proposedKeys].filter((k) => forbidden.has(k)),
    mustHaveMisses: [...mustHave].filter((k) => !essential.has(k)),
    unsupported: fromJd.filter((p) => p.spans.length === 0).map((p) => p.name),
    precision: ratio(truePositives.length, proposedKeys.size),
    recall: ratio(truePositives.length, expected.size),
  };
}

export function runBench(cases: readonly JdGoldCase[], engine: 'current' | 'legacy' = 'current'): BenchSummary {
  const results = cases.map((c) => runCase(c, engine));
  const tp = sum(results.map((r) => r.truePositives.length));
  const fp = sum(results.map((r) => r.falsePositives.length));
  const fn = sum(results.map((r) => r.falseNegatives.length));
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);

  const domains = [...new Set(results.map((r) => r.domain))].sort();
  return {
    cases: results,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : round(2 * precision * recall / (precision + recall)),
    forbiddenHits: sum(results.map((r) => r.forbiddenHits.length)),
    mustHaveMisses: sum(results.map((r) => r.mustHaveMisses.length)),
    unsupported: sum(results.map((r) => r.unsupported.length)),
    byDomain: domains.map((domain) => {
      const inDomain = results.filter((r) => r.domain === domain);
      const dtp = sum(inDomain.map((r) => r.truePositives.length));
      const dfp = sum(inDomain.map((r) => r.falsePositives.length));
      const dfn = sum(inDomain.map((r) => r.falseNegatives.length));
      return { domain, cases: inDomain.length, precision: ratio(dtp, dtp + dfp), recall: ratio(dtp, dtp + dfn) };
    }),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : round(numerator / denominator);
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
