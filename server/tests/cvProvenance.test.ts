import { describe, it, expect } from 'vitest';
import { prepareCvForScoring } from '../src/engines/cvRedaction.js';
import { extractCvFacts } from '../src/engines/cvFacts.js';

/**
 * Where a fact came from, said accurately enough that a person can check it.
 *
 * `CvEvidence.line` is an INDEX into the lines the scorer kept, and the scorer
 * keeps neither blank lines nor the ones redaction dropped. The fit panel
 * printed it as "CV line {line + 1}", so on any real CV — which opens with a
 * name, an address and a phone number, all dropped — the number sent a
 * recruiter to the wrong line of the document. Off by however much was removed
 * above it, and silently.
 *
 * That is the whole premise of a profile a recruiter does not have to
 * proof-read: if the source reference is wrong, checking the parse is slower
 * than reading the CV again. `sourceLine` is the 1-based line in the document
 * as uploaded, and it is what a person is ever shown.
 */

// Deliberately shaped like a real CV: a header block that redaction removes in
// full, blank lines between sections, and the first role well down the page.
const CV = [
  'Meera Iyer',                                   // 1  dropped (identity header)
  'meera.iyer@example.com | +91 98765 43210',     // 2  dropped (contact)
  'Bengaluru, India',                             // 3  dropped (contact/location)
  '',                                             // 4  blank
  'SUMMARY',                                      // 5  kept (heading)
  'Data engineer with seven years on batch and streaming pipelines.', // 6 kept
  '',                                             // 7  blank
  'EXPERIENCE',                                   // 8  kept (heading)
  'Senior Data Engineer, Northwind Logistics (March 2021 - Present)', // 9 kept
  'Rebuilt the nightly ETL on Airflow 2.x.',      // 10 kept
  '',                                             // 11 blank
  'Data Engineer, Calder Analytics (June 2018 - February 2021)',      // 12 kept
  'Partitioned the Postgres warehouse by tenant.', // 13 kept
].join('\n');

const lineOfDocument = (n: number) => CV.split('\n')[n - 1];

describe('a parsed fact points at the line it actually came from', () => {
  it('numbers every kept line by its position in the uploaded document', () => {
    const cv = prepareCvForScoring(CV);

    const summary = cv.lines.find((l) => l.text.startsWith('Data engineer with seven years'));

    expect(summary?.sourceLine).toBe(6);
  });

  it('does not number lines by their position in the filtered array', () => {
    // The distinction this whole file exists for: the summary line is the
    // second line the scorer kept, and the sixth line of the document.
    const cv = prepareCvForScoring(CV);
    const summary = cv.lines.find((l) => l.text.startsWith('Data engineer with seven years'));

    expect([summary?.index, summary?.sourceLine]).toEqual([1, 6]);
  });

  it('gives a role the document line a reader can look up', () => {
    const facts = extractCvFacts(CV);
    const role = facts.roles.find((r) => r.employer.includes('Northwind'));

    expect(role?.evidence.sourceLine).toBe(9);
  });

  it('quotes text that is really on the line it names', () => {
    // The strongest form of the claim, and the one a recruiter relies on: take
    // the number the product prints, open the document at that line, and find
    // the quote there. This fails for every fact if the number is an index.
    const facts = extractCvFacts(CV);
    const checked = facts.roles.map((r) => ({
      quote: r.evidence.quote,
      atThatLine: lineOfDocument(r.evidence.sourceLine ?? -1) ?? '',
    }));

    const wrong = checked.filter((c) => !c.atThatLine.includes(c.quote));
    expect(wrong).toEqual([]);
  });

  it('keeps the bullets under a role pointing at their own document lines', () => {
    const facts = extractCvFacts(CV);
    const role = facts.roles.find((r) => r.employer.includes('Northwind'));
    const bullet = role?.bullets[0];

    expect([bullet?.sourceLine, lineOfDocument(bullet?.sourceLine ?? -1)])
      .toEqual([10, 'Rebuilt the nightly ETL on Airflow 2.x.']);
  });

  it('numbers a qualification by its document line too', () => {
    const withDegree = `${CV}\n\nEDUCATION\nB.Tech Computer Science, Anna University, 2016`;
    const facts = extractCvFacts(withDegree);
    const qualification = facts.qualifications[0];

    expect(qualification?.evidence.sourceLine).toBe(16);
  });
});
