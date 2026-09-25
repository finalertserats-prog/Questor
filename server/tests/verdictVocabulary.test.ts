import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isVerdict, VERDICTS, VERDICT_LABELS, decisionOfVerdict, outcomeLabel, verdictOfDecision, WITHDRAWN_LABEL,
} from '../src/domain/verdict.js';

/**
 * One vocabulary, end to end.
 *
 * The same judgement used to be recorded twice in two languages: the
 * assessment said PROCEED / CONSIDER / DO_NOT_PROGRESS and the pipeline said
 * APPROVED / REJECTED / WITHDRAWN, so a reviewer who pressed "Proceed" was
 * told, on the next page, that the candidate had been "Approved". Storage
 * keeps both enums — migrating a decided pipeline's column would rewrite
 * history — but there is exactly one set of words, and this is the only place
 * the two are allowed to meet.
 */

describe('the verdict vocabulary', () => {
  it('has one word for each judgement a reviewer can record', () => {
    expect(VERDICTS.map((v) => VERDICT_LABELS[v])).toEqual(['Proceed', 'Consider', 'Do not progress']);
  });

  it('recognises only the three verdicts', () => {
    expect(VERDICTS.every(isVerdict)).toBe(true);
  });

  it('does not accept a stored pipeline decision as a verdict', () => {
    expect(isVerdict('APPROVED')).toBe(false);
  });
});

describe('mapping a verdict onto the stored pipeline decision', () => {
  it('proceeds by approving the round', () => {
    expect(decisionOfVerdict('PROCEED')).toBe('APPROVED');
  });

  it('does not progress by rejecting it', () => {
    expect(decisionOfVerdict('DO_NOT_PROGRESS')).toBe('REJECTED');
  });

  it('decides nothing on Consider, which is a person saying "not yet"', () => {
    expect(decisionOfVerdict('CONSIDER')).toBeNull();
  });
});

describe('reading a stored pipeline decision back', () => {
  it('round-trips every verdict that decides something', () => {
    for (const verdict of VERDICTS) {
      const decision = decisionOfVerdict(verdict);
      if (decision) expect(verdictOfDecision(decision)).toBe(verdict);
    }
  });

  it('has no verdict for a withdrawal, because nobody judged the candidate', () => {
    expect(verdictOfDecision('WITHDRAWN')).toBeNull();
  });

  it('says every stored decision in the one vocabulary', () => {
    expect(outcomeLabel('APPROVED')).toBe('Proceed');
    expect(outcomeLabel('REJECTED')).toBe('Do not progress');
    expect(outcomeLabel('WITHDRAWN')).toBe(WITHDRAWN_LABEL);
  });
});

/**
 * The browser cannot import the server's module, so it carries its own copy.
 * A copy that drifts is how the two vocabularies grew in the first place, so
 * the two tables are compared as text rather than trusted to stay in step.
 */
describe('the browser copy of the vocabulary', () => {
  const web = readFileSync(
    join(__dirname, '..', '..', 'web', 'src', 'components', 'assessment', 'verdictVocabulary.ts'),
    'utf8',
  );

  function pairs(source: string, table: string): string[] {
    const body = new RegExp(`${table}[^=]*=\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? '';
    return [...body.matchAll(/(\w+):\s*'([^']*)'/g)].map((m) => `${m[1]}=${m[2]}`).sort();
  }

  const server = readFileSync(join(__dirname, '..', 'src', 'domain', 'verdict.ts'), 'utf8');

  it('labels each verdict with the same words as the server', () => {
    expect(pairs(web, 'VERDICT_LABELS')).toEqual(pairs(server, 'VERDICT_LABELS'));
    expect(pairs(web, 'VERDICT_LABELS')).not.toEqual([]);
  });

  it('maps each verdict onto the same stored decision as the server', () => {
    expect(pairs(web, 'DECISION_OF_VERDICT')).toEqual(pairs(server, 'DECISION_OF_VERDICT'));
    expect(pairs(web, 'DECISION_OF_VERDICT')).not.toEqual([]);
  });
});
