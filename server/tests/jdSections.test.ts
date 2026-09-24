import { describe, it, expect } from 'vitest';
import {
  segmentJd,
  sectionWeight,
  contributingLines,
  maskCollaborationObjects,
  MIN_CONTRIBUTING_WEIGHT,
  type JdSectionKind,
} from '../src/engines/jdSections.js';
import { excludedBy, EXCLUSION_RULES } from '../src/engines/jdExclusions.js';

/**
 * Sectioning and exclusion are the two gates that stand between a job
 * description and a competency every candidate for the role is then measured
 * against. Both are pinned by example here, because the cost of getting them
 * wrong is a person scored on something the role never asked for.
 */

const FULL_JD = `Senior Data Engineer
Location: Bengaluru (Hybrid)  |  Employment type: Full-time  |  Level: Senior

About us:
Acme was founded in 2014 and is headquartered in Bengaluru. Our mission is to make
financial data trustworthy. We are a Series C company of 400 people.

About the role:
We are hiring a Senior Data Engineer to design and operate our analytical data platform.

Responsibilities:
- Build and operate batch and streaming pipelines using Python, Airflow and Spark.
- Partner with product teams to deliver trustworthy data.
- Write and optimize complex SQL; reason about partitioning and correctness.

Requirements:
- Strong SQL and data warehousing (Snowflake, Redshift or BigQuery).
- Proven experience building production data pipelines.

Nice to have:
- Exposure to machine learning feature pipelines.

Benefits:
- Competitive salary, equity, and an annual learning budget.
- Private health insurance and 25 days paid time off.

Acme is an equal opportunity employer. We welcome applicants regardless of race,
religion, gender or age. All offers are subject to a background check.`;

function kindOfLineContaining(text: string): JdSectionKind {
  const sections = segmentJd(FULL_JD);
  for (const section of sections) {
    for (const line of section.lines) {
      if (line.text.includes(text)) return section.kind;
    }
  }
  throw new Error(`no line contains ${text}`);
}

describe('segmentJd', () => {
  it('files the company blurb under company, not requirements', () => {
    expect(kindOfLineContaining('founded in 2014')).toBe('company');
  });

  it('files responsibilities under responsibilities', () => {
    expect(kindOfLineContaining('batch and streaming pipelines')).toBe('responsibilities');
  });

  it('files the must-have list under requirements', () => {
    expect(kindOfLineContaining('Strong SQL and data warehousing')).toBe('requirements');
  });

  it('separates nice-to-haves from requirements', () => {
    expect(kindOfLineContaining('machine learning feature pipelines')).toBe('nice_to_have');
  });

  it('files perks under benefits', () => {
    expect(kindOfLineContaining('Private health insurance')).toBe('benefits');
  });

  it('files the equal-opportunity statement under boilerplate', () => {
    expect(kindOfLineContaining('equal opportunity employer')).toBe('boilerplate');
  });

  it('recognises Must have and What you will do as headings', () => {
    const jd = 'Data Analyst\n\nWhat you will do:\n- Build dashboards.\n\nMust have:\n- Advanced SQL.\n';
    const kinds = segmentJd(jd).map((s) => s.kind);
    expect(kinds).toContain('responsibilities');
    expect(kinds).toContain('requirements');
  });

  it('keeps the 1-based line number of every line so a span can be pointed at', () => {
    const jd = 'Title\n\nRequirements:\n- Advanced SQL.\n';
    const line = segmentJd(jd).flatMap((s) => s.lines).find((l) => l.text.includes('Advanced SQL'));
    expect(line?.line).toBe(4);
  });
});

describe('sectionWeight', () => {
  it('lets requirements contribute the most', () => {
    expect(sectionWeight('requirements')).toBeGreaterThan(sectionWeight('responsibilities'));
  });

  it('gives company, benefits and boilerplate no contribution at all', () => {
    expect(sectionWeight('company')).toBe(0);
    expect(sectionWeight('benefits')).toBe(0);
    expect(sectionWeight('boilerplate')).toBe(0);
  });

  it('keeps every contributing section at or above the floor', () => {
    for (const kind of ['requirements', 'responsibilities', 'nice_to_have'] as const) {
      expect(sectionWeight(kind)).toBeGreaterThanOrEqual(MIN_CONTRIBUTING_WEIGHT);
    }
  });
});

describe('contributingLines', () => {
  const lines = contributingLines(FULL_JD);
  const texts = lines.map((l) => l.text).join('\n');

  it('offers the requirement lines to the extractor', () => {
    expect(texts).toContain('Strong SQL and data warehousing');
  });

  it('never offers a benefits line', () => {
    expect(texts).not.toContain('health insurance');
    expect(texts).not.toContain('learning budget');
  });

  it('never offers the company blurb', () => {
    expect(texts).not.toContain('founded in 2014');
    expect(texts).not.toContain('Series C');
  });

  it('never offers the equal-opportunity statement', () => {
    expect(texts).not.toContain('equal opportunity');
  });

  it('marks nice-to-have lines so they cannot become essential', () => {
    const nice = lines.find((l) => l.text.includes('machine learning feature pipelines'));
    expect(nice?.section).toBe('nice_to_have');
  });
});

describe('maskCollaborationObjects', () => {
  it('masks who you partner with, so their discipline is not read as yours', () => {
    const masked = maskCollaborationObjects('Partner with product teams to deliver trustworthy data.');
    expect(masked).not.toMatch(/product/i);
    expect(masked).toContain('deliver trustworthy data');
  });

  it('keeps the work that follows a collaboration verb', () => {
    const masked = maskCollaborationObjects('Work closely with the ML team to build feature pipelines.');
    expect(masked).not.toMatch(/\bML\b/);
    expect(masked).toContain('build feature pipelines');
  });

  it('masks a list of other disciplines', () => {
    const masked = maskCollaborationObjects('Collaborate with analysts, product and engineering.');
    expect(masked).not.toMatch(/product/i);
  });

  it('leaves a line with no collaboration verb untouched', () => {
    const line = 'Own the product roadmap and the backlog.';
    expect(maskCollaborationObjects(line)).toBe(line);
  });

  it('does not mask the role\'s own work that merely mentions a team noun', () => {
    const line = 'Lead a team of five data engineers.';
    expect(maskCollaborationObjects(line)).toContain('data engineers');
  });
});

describe('excludedBy', () => {
  const cases: Array<{ line: string; rule: string }> = [
    { line: 'Private health insurance and 25 days paid time off.', rule: 'benefits' },
    { line: 'Competitive salary, equity and an annual learning budget.', rule: 'benefits' },
    { line: 'Acme is an equal opportunity employer.', rule: 'dei_statement' },
    { line: 'We welcome applicants regardless of race, religion, gender or age.', rule: 'dei_statement' },
    { line: 'All offers are subject to a background check and right to work.', rule: 'legal_notice' },
    { line: 'Acme was founded in 2014 and is headquartered in Bengaluru.', rule: 'company_blurb' },
    { line: 'Our mission is to make financial data trustworthy.', rule: 'company_commitment' },
    { line: 'We make accounting software that does not make people cry.', rule: 'company_narrative' },
    { line: 'Our infrastructure runs on Azure.', rule: 'company_narrative' },
    { line: 'You will not line manage anyone.', rule: 'negated_requirement' },
    { line: 'You are not the product owner.', rule: 'negated_requirement' },
    { line: 'Our CMO owns demand generation and the campaign calendar.', rule: 'other_team_tool' },
    { line: 'Finance or accounting buyers.', rule: 'customer_function' },
    { line: 'Apply now via our careers page with a cover letter.', rule: 'application_process' },
    { line: 'The platform team owns the Kubernetes cluster.', rule: 'other_team_tool' },
    { line: 'Our CI pipeline is maintained by the developer experience team.', rule: 'other_team_owns' },
  ];

  for (const { line, rule } of cases) {
    it(`excludes "${line.slice(0, 40)}…" by ${rule}`, () => {
      expect(excludedBy(line)?.id).toBe(rule);
    });
  }

  it('does not exclude a genuine requirement', () => {
    expect(excludedBy('Strong SQL and data warehousing (Snowflake, Redshift or BigQuery).')).toBeNull();
    expect(excludedBy('Build and operate batch and streaming pipelines using Python and Airflow.')).toBeNull();
  });

  it('every rule states why it exists, so a person can be told', () => {
    for (const rule of EXCLUSION_RULES) {
      expect(rule.why.length).toBeGreaterThan(10);
    }
  });
});
