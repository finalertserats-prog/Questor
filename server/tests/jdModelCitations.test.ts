import { describe, it, expect } from 'vitest';
import { canonicaliseName, locateSpan, verifySpan } from '../src/engines/jdCompetencies.js';
import { extractRoleHeuristic } from '../src/engines/roleIntelligence.js';
import { maskCollaborationObjects } from '../src/engines/jdSections.js';
import { DEMO_JD } from '../src/seed/demoData.js';

/**
 * The model path, held to the same standard as the deterministic one.
 *
 * A review found that it was not. Every competency the model proposed had to
 * carry a job-description quote, and the quote was checked to be real — but
 * nothing checked that the quote actually *supported* the competency. So a
 * model answering
 *
 *   { name: "Product Management",
 *     sourceSpan: "Partner with analytics and product teams to deliver
 *                  trustworthy data." }
 *
 * passed every gate, because that line genuinely is in the advert. The exact
 * failure this whole feature exists to prevent, reproduced through the other
 * door.
 *
 * A real quote is necessary and not sufficient. The cited line now has to
 * survive the same reading the extractor gives it before the competency is
 * accepted.
 */

/** The check the model path applies, exercised directly. */
function supported(spanText: string, name: string): boolean {
  const canonical = canonicaliseName(name);
  const masked = maskCollaborationObjects(spanText);
  if (!canonical) return false;
  if (canonical.notWhen?.some((re) => re.test(masked))) return false;
  return canonical.cues.some((re) => re.test(masked));
}

const COLLABORATION_LINE = 'Partner with analytics and product teams to deliver trustworthy data.';

describe('a model citation has to hold up, not merely exist', () => {
  it('the collaboration line really is in the advert', () => {
    expect(verifySpan(DEMO_JD, COLLABORATION_LINE)).toBe(true);
    expect(locateSpan(DEMO_JD, COLLABORATION_LINE)).not.toBeNull();
  });

  it('and still does not support Product Management', () => {
    expect(supported(COLLABORATION_LINE, 'Product Management')).toBe(false);
  });

  it('nor does naming another team support their discipline', () => {
    expect(supported('Work closely with the machine learning team to supply feature inputs.', 'Machine Learning Engineering')).toBe(false);
    expect(supported('Our FP&A team owns the forecast and the budget model.', 'Financial Analysis & Planning')).toBe(false);
  });

  it('a line that genuinely states the requirement does support it', () => {
    expect(supported('Own the product roadmap for the payments area.', 'Product Management')).toBe(true);
    expect(supported('Strong SQL and data warehousing (Snowflake or BigQuery).', 'SQL & Data Warehousing')).toBe(true);
  });

  it('a veto beats a real quote too', () => {
    expect(supported('Working knowledge of ICH Good Clinical Practice (GCP) is essential.', 'Cloud & Platform Architecture')).toBe(false);
  });

  it('rejects an invented quote before any of that', () => {
    expect(verifySpan(DEMO_JD, 'Deep Kubernetes and service mesh expertise required.')).toBe(false);
  });
});

describe('the platform baseline survives whichever path ran', () => {
  /**
   * The model path used to replace the heuristic set outright, which dropped
   * Communication, Problem Solving, Collaboration and Ownership & Impact —
   * the four the product tells people are asked on every role. Role creation
   * defaults to using the model, so most roles were losing them, and whether
   * an interview could ask how somebody thinks depended on how many
   * competencies the model happened to cite properly.
   */
  const BASELINE = ['Communication', 'Problem Solving', 'Collaboration', 'Ownership & Impact'];

  it('the heuristic path proposes all four', () => {
    const names = extractRoleHeuristic(DEMO_JD, 'Senior Data Engineer').profile.competencies.map((c) => c.name);
    for (const b of BASELINE) expect(names).toContain(b);
  });

  it('marks them as baseline rather than as extracted', () => {
    const competencies = extractRoleHeuristic(DEMO_JD, 'Senior Data Engineer').profile.competencies;
    for (const b of BASELINE) {
      const found = competencies.find((c) => c.name === b)!;
      expect(found.origin).toBe('baseline');
      expect(found.source).toBeUndefined();
    }
  });

  it('gives every other competency a span', () => {
    const competencies = extractRoleHeuristic(DEMO_JD, 'Senior Data Engineer').profile.competencies;
    for (const c of competencies.filter((x) => x.origin === 'jd')) {
      expect(c.source?.text, c.name).toBeTruthy();
      expect(verifySpan(DEMO_JD, c.source!.text), c.name).toBe(true);
    }
  });
});

describe('stems that need more than an s', () => {
  const fires = (key: string, line: string) =>
    canonicaliseName(key)!.cues.some((re) => re.test(line));

  it('matches -ation on a truncated stem', () => {
    expect(fires('SQL & Data Warehousing', 'Responsible for query optimization across the warehouse.')).toBe(true);
    expect(fires('SQL & Data Warehousing', 'Responsible for query optimisation across the warehouse.')).toBe(true);
  });
});
