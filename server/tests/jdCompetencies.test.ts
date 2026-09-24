import { describe, it, expect } from 'vitest';
import { proposeFromJd, verifySpan, MIN_CONFIDENCE_TO_PROPOSE } from '../src/engines/jdCompetencies.js';
import { DEMO_JD } from '../src/seed/demoData.js';

/**
 * The failure this whole feature exists to stop, written down as a test.
 *
 * A Senior Data Engineer advert says "partner with analytics and product teams
 * to deliver trustworthy data". Extraction read the word "product" and put
 * Product Management on the scorecard — and a scorecard competency is not a
 * label. It becomes what every candidate for the role is measured against, the
 * questions the interviewer asks, the evidence quotes, the assessment and the
 * calibration loop. A collaboration mention is not a requirement.
 */

const names = (jd: string, opts?: Parameters<typeof proposeFromJd>[1]) =>
  proposeFromJd(jd, opts).map((c) => c.name);

describe('the Product Management failure', () => {
  it('does not put Product Management on a data engineering role', () => {
    expect(names(DEMO_JD, { title: 'Senior Data Engineer', band: 'senior' })).not.toContain('Product Management');
  });

  it('still reads the data engineering requirements the advert does make', () => {
    const found = names(DEMO_JD, { title: 'Senior Data Engineer', band: 'senior' });
    expect(found).toContain('SQL & Data Warehousing');
    expect(found).toContain('Data Engineering & Pipelines');
  });

  it('does put Product Management on a role that actually owns a product', () => {
    const jd = [
      'Group Product Manager',
      '',
      'Requirements:',
      '- Own the product roadmap for the payments area.',
      '- Run product discovery with customers and write PRDs.',
    ].join('\n');
    expect(names(jd, { title: 'Group Product Manager', band: 'senior' })).toContain('Product Management');
  });
});

describe('every proposed competency cites its source span', () => {
  const proposals = proposeFromJd(DEMO_JD, { title: 'Senior Data Engineer', band: 'senior' });

  it('proposes something at all', () => {
    expect(proposals.length).toBeGreaterThanOrEqual(5);
  });

  it('gives every JD-derived competency at least one span', () => {
    for (const c of proposals.filter((p) => p.origin === 'jd')) {
      expect(c.spans.length, `${c.name} has no span`).toBeGreaterThanOrEqual(1);
    }
  });

  it('quotes a span that really appears in the job description', () => {
    for (const c of proposals) {
      for (const span of c.spans) {
        expect(verifySpan(DEMO_JD, span.text), `${c.name}: "${span.text}" is not in the JD`).toBe(true);
      }
    }
  });

  it('points each span at the line it came from', () => {
    const lines = DEMO_JD.replace(/\r/g, '').split('\n');
    for (const c of proposals) {
      for (const span of c.spans) {
        expect(lines[span.line - 1], `${c.name} span line ${span.line}`).toContain(span.text.slice(0, 30));
      }
    }
  });

  it('marks the platform baseline as baseline rather than passing it off as extracted', () => {
    const communication = proposals.find((c) => c.name === 'Communication')!;
    expect(communication.origin).toBe('baseline');
    expect(communication.spans).toEqual([]);
  });

  it('never proposes a JD-derived competency with no span at all', () => {
    const jd = 'Chief Happiness Beetle\n\nRequirements:\n- Be lovely to everyone.\n';
    for (const c of proposeFromJd(jd, { title: 'Chief Happiness Beetle' })) {
      if (c.origin === 'jd') expect(c.spans.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('what a section is allowed to contribute', () => {
  const jd = [
    'Staff Engineer',
    '',
    'About us:',
    'We were founded in 2015. Our mission is to rebuild financial infrastructure with Kubernetes.',
    '',
    'Requirements:',
    '- Strong Python and distributed systems experience.',
    '',
    'Benefits:',
    '- A generous learning budget for any AWS certification you fancy.',
  ].join('\n');

  it('ignores a technology named only in the company blurb', () => {
    // Kubernetes appears exactly once in this advert, in the company's own
    // description of itself. It must put nothing on the scorecard.
    const proposals = proposeFromJd(jd, { title: 'Staff Engineer' });
    expect(proposals.every((c) => c.spans.every((s) => s.section !== 'company'))).toBe(true);
  });

  it('still reads the requirement the advert does make', () => {
    expect(names(jd, { title: 'Staff Engineer' })).toContain('Systems Architecture');
  });

  /**
   * A deliberate trade, recorded so it is not mistaken for an oversight.
   *
   * "Strong Python and distributed systems experience" evidences both Systems
   * Architecture and — through the bare language name — Software Engineering.
   * The specificity rule keeps the first and folds in the second, because the
   * alternative measures the candidate twice on one sentence. The cost is a
   * little recall on adverts where the language really is the requirement;
   * the benefit is that "build pipelines using Python" stops producing a
   * generic Software Engineering competency alongside the real one. Precision
   * is the priority here: a missing competency is visible to whoever reviews
   * the scorecard, a spurious one looks exactly like correct output.
   */
  it('folds a general competency into the specific one that shares its line', () => {
    const found = names(jd, { title: 'Staff Engineer' });
    expect(found).toContain('Systems Architecture');
    expect(found).not.toContain('Software Engineering');
  });

  it('keeps Software Engineering when the line is its own', () => {
    const backend = [
      'Backend Engineer',
      '',
      'Requirements:',
      '- Strong Java and Spring Boot.',
      '- You practise code review and care about design patterns.',
    ].join('\n');
    expect(names(backend, { title: 'Backend Engineer' })).toContain('Software Engineering');
  });

  it('ignores a technology named only in the benefits', () => {
    const cloud = proposeFromJd(jd, { title: 'Staff Engineer' }).find((c) => c.name === 'Cloud & Platform Architecture');
    expect(cloud).toBeUndefined();
  });

  it('files a nice-to-have as preferred, never essential', () => {
    const withNice = [
      'Data Engineer',
      '',
      'Must have:',
      '- Advanced SQL.',
      '',
      'Nice to have:',
      '- Exposure to machine learning feature pipelines.',
    ].join('\n');
    const ml = proposeFromJd(withNice, { title: 'Data Engineer' }).find((c) => c.name === 'Machine Learning Engineering');
    expect(ml?.classification).toBe('preferred');
  });
});

describe('weights and levels are derived, not defaulted', () => {
  const jd = [
    'Senior Data Engineer',
    '',
    'Requirements:',
    '- Deep, expert-level SQL: query tuning, partitioning and warehouse design.',
    '- Strong experience building production data pipelines with Airflow.',
    '',
    'Nice to have:',
    '- Some exposure to Tableau dashboards.',
  ].join('\n');
  const proposals = proposeFromJd(jd, { title: 'Senior Data Engineer', band: 'senior' });
  const sql = proposals.find((c) => c.name === 'SQL & Data Warehousing')!;
  const analytics = proposals.find((c) => c.name === 'Analytics & Insight');

  it('weighs the emphasised essential above the passing nice-to-have', () => {
    if (analytics) expect(sql.weight).toBeGreaterThan(analytics.weight);
  });

  it('asks for a higher level where the advert asks for depth', () => {
    expect(sql.requiredLevel).toBeGreaterThanOrEqual(4);
  });

  it('asks for less of the same competency on a junior role', () => {
    const junior = proposeFromJd(jd, { title: 'Junior Data Engineer', band: 'emerging' })
      .find((c) => c.name === 'SQL & Data Warehousing')!;
    expect(junior.requiredLevel).toBeLessThan(sql.requiredLevel);
  });

  it('explains every competency it proposes', () => {
    for (const c of proposals) expect(c.rationale.length).toBeGreaterThan(25);
  });

  it('normalises scored weights to sum to about one', () => {
    const total = proposals.filter((c) => c.classification !== 'non_scoring').reduce((a, c) => a + c.weight, 0);
    expect(total).toBeGreaterThan(0.95);
    expect(total).toBeLessThan(1.05);
  });
});

describe('confidence', () => {
  it('is higher for a requirement stated twice than for one passing mention', () => {
    const twice = proposeFromJd(
      'Engineer\n\nRequirements:\n- Strong SQL required.\n- Advanced SQL query tuning.\n',
      { title: 'Engineer' },
    ).find((c) => c.name === 'SQL & Data Warehousing')!;
    const once = proposeFromJd(
      'Engineer\n\nResponsibilities:\n- Occasionally write some SQL.\n',
      { title: 'Engineer' },
    ).find((c) => c.name === 'SQL & Data Warehousing')!;
    expect(twice.confidence).toBeGreaterThan(once.confidence);
  });

  it('marks a low-confidence proposal rather than including it silently', () => {
    const once = proposeFromJd(
      'Engineer\n\nResponsibilities:\n- Occasionally write some SQL.\n',
      { title: 'Engineer' },
    ).find((c) => c.name === 'SQL & Data Warehousing')!;
    if (once.confidence < 0.5) expect(once.lowConfidence).toBe(true);
  });

  it('never proposes below the floor', () => {
    for (const c of proposeFromJd(DEMO_JD, { title: 'Senior Data Engineer' })) {
      expect(c.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE_TO_PROPOSE);
    }
  });
});

describe('verifySpan', () => {
  it('accepts a quote that appears in the JD', () => {
    expect(verifySpan('Requirements:\n- Advanced SQL.\n', 'Advanced SQL.')).toBe(true);
  });

  it('accepts a quote whose whitespace differs', () => {
    expect(verifySpan('Requirements:\n-   Advanced    SQL.\n', 'Advanced SQL.')).toBe(true);
  });

  it('rejects a quote the model invented', () => {
    expect(verifySpan('Requirements:\n- Advanced SQL.\n', 'Deep Kubernetes expertise.')).toBe(false);
  });
});

describe('a tool is not the job it is usually used for', () => {
  /**
   * A marketing advert naming the stack the marketer works in was earning
   * Sales Execution — a competency about carrying a quota and closing deals.
   *
   * HubSpot had already been taken out of that cue for this reason, with a
   * comment saying so; Salesforce and the bare word CRM were still in it, so
   * "marketing automation and CRM — HubSpot and Salesforce preferred" put
   * selling on a marketing manager's scorecard. That is not a mislabelled
   * competency, it is a different job: the interview then asks them to walk
   * through a deal they lost.
   *
   * Found on an advert written to test the extractor against something the
   * gold set had never seen.
   */
  const MARKETING_JD = [
    'Senior Marketing Manager',
    '',
    'What we are looking for',
    'Six or more years in B2B marketing, at least three in demand generation.',
    'Demonstrable experience with marketing automation and CRM — HubSpot and',
    'Salesforce preferred.',
    'Strong analytical skills: comfortable in GA4 and building attribution models.',
  ].join('\n');

  const SALES_JD = [
    'Enterprise Account Executive',
    '',
    'What we are looking for',
    'You will carry an annual quota and own the full sales cycle.',
    'Demonstrable experience closing deals with enterprise buyers.',
    'You will build and qualify your own pipeline.',
  ].join('\n');

  it('does not put Sales Execution on a marketer for naming their CRM', () => {
    expect(names(MARKETING_JD, { title: 'Senior Marketing Manager', band: 'senior', domainName: 'marketing' }))
      .not.toContain('Sales Execution');
  });

  it('still reads selling as selling when the advert describes it', () => {
    expect(names(SALES_JD, { title: 'Enterprise Account Executive', band: 'senior', domainName: 'sales' }))
      .toContain('Sales Execution');
  });
});
