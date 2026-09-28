import { describe, expect, it } from 'vitest';
import { servingModeSentence } from '../src/components/servingModeModel';

describe('servingModeSentence', () => {
  it('says nothing when every turn ran on the primary model', () => {
    expect(servingModeSentence({ degraded: false, turns: [], counts: { primary: 9, local: 0, builtIn: 0 } })).toBeNull();
  });

  it('says nothing for an older server that does not send the field', () => {
    expect(servingModeSentence(undefined)).toBeNull();
  });

  it('names how many questions ran on each fallback', () => {
    expect(servingModeSentence({
      degraded: true,
      turns: [{ index: 4, layer: 'local' }, { index: 6, layer: 'local' }, { index: 8, layer: 'built-in', failure: 'quota' }],
      counts: { primary: 3, local: 2, builtIn: 1 },
    })).toBe('The AI provider was unavailable for part of this interview: 2 questions were worded by the backup local model and 1 by the built-in question bank. Follow-up probes on those turns may be plainer; weigh the answers with that in mind.');
  });

  it('uses the singular for one question', () => {
    expect(servingModeSentence({ degraded: true, turns: [{ index: 4, layer: 'local' }], counts: { primary: 5, local: 1, builtIn: 0 } }))
      .toContain('1 question was worded by the backup local model.');
  });
});
