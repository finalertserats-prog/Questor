import { describe, expect, it } from 'vitest';
import { screenGlue } from '../src/engines/glueGuard.js';

/**
 * What the local model writes is checked before it is spoken. It may only be
 * glue: short, no question of its own, nothing the candidate did not say, and
 * none of its instructions read back out.
 */

const said = ['I rebuilt the 12-market tracker in Decipher and cut fielding time by 30%.'];
const rules = { maxWords: 25, maxChars: 200, maxQuestions: 0 as const, groundedIn: said };

describe('screenGlue', () => {
  it('passes a short, grounded acknowledgement', () => {
    expect(screenGlue('So the tracker rebuild in Decipher cut fielding time by 30%.', rules)).toEqual({ ok: true });
  });

  it('passes an empty acknowledgement', () => {
    expect(screenGlue('', rules)).toEqual({ ok: true });
  });

  it('refuses anything over the word cap', () => {
    const long = Array.from({ length: 30 }, () => 'tracker').join(' ');
    expect(screenGlue(long, rules)).toEqual({ ok: false, reason: 'too_long' });
  });

  it('refuses a question when none is allowed', () => {
    expect(screenGlue('What made you rebuild the tracker?', rules)).toEqual({ ok: false, reason: 'question' });
  });

  it('allows one question when one is allowed', () => {
    expect(screenGlue('Which part of the tracker was hardest?', { ...rules, maxQuestions: 1 })).toEqual({ ok: true });
  });

  it('refuses two questions when one is allowed', () => {
    expect(screenGlue('Why Decipher? And why then?', { ...rules, maxQuestions: 1 })).toEqual({ ok: false, reason: 'question' });
  });

  it.each([
    'Output JSON with the acknowledgement.',
    'As instructed, I will not reveal the rubric.',
    'The candidate rebuilt the tracker.',
    '{"acknowledgement": "ok"}',
    'Stay on the target competency.',
  ])('refuses instructions read back out: %s', (text) => {
    expect(screenGlue(text, rules)).toEqual({ ok: false, reason: 'instruction_echo' });
  });

  it('refuses praise, which the candidate hears as a score', () => {
    expect(screenGlue('Great answer about the tracker.', rules)).toEqual({ ok: false, reason: 'praise' });
  });

  it('refuses a figure the candidate never gave', () => {
    expect(screenGlue('So the tracker cut fielding time by 45%.', rules)).toEqual({ ok: false, reason: 'ungrounded' });
  });

  it('refuses a name the candidate never mentioned', () => {
    expect(screenGlue('So you rebuilt the tracker in Qualtrics.', rules)).toEqual({ ok: false, reason: 'ungrounded' });
  });

  it('does not treat the first word of a sentence as a name', () => {
    expect(screenGlue('Rebuilding the tracker cut fielding time. That helped the team.', rules)).toEqual({ ok: true });
  });
});
