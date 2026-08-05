import { describe, it, expect } from 'vitest';
import { parseJsonLoose } from '../src/providers/llm/index.js';

describe('parseJsonLoose', () => {
  it('parses bare minified JSON, which is what the prompt asks for', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON in a json-tagged fence', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses JSON in an untagged fence', () => {
    expect(parseJsonLoose('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  /**
   * The failure this function was rewritten for. The work-sample generator asks
   * the model for an artefact AND a JSON wrapper, so the reply legitimately
   * contains a ```sql or ```python block before the JSON. The old matcher took
   * the first fence whatever its language and swallowed the language tag with
   * it, producing "sql\nSELECT…" — never valid JSON. Every one of those calls
   * was billed and thrown away, and the interview quietly fell back to the
   * heuristic artefact.
   */
  it('skips a code-block artefact and finds the JSON after it', () => {
    const reply = [
      'Here is the query:',
      '```sql',
      'SELECT customer_id, COUNT(*) FROM orders GROUP BY 1;',
      '```',
      '```json',
      '{"prompt":"What is wrong with this query?"}',
      '```',
    ].join('\n');
    expect(parseJsonLoose(reply)).toEqual({ prompt: 'What is wrong with this query?' });
  });

  it('skips a python artefact fence the same way', () => {
    const reply = '```python\nimport pandas as pd\ndf.merge(other)\n```\n{"prompt":"What breaks at volume?"}';
    expect(parseJsonLoose(reply)).toEqual({ prompt: 'What breaks at volume?' });
  });

  it('finds JSON that follows prose with no fence at all', () => {
    expect(parseJsonLoose('Sure — here you go: {"a":1}. Let me know.')).toEqual({ a: 1 });
  });

  it('parses a top-level array', () => {
    expect(parseJsonLoose('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('keeps braces and escaped quotes inside strings', () => {
    expect(parseJsonLoose('{"q":"what about {this}?"}')).toEqual({ q: 'what about {this}?' });
    expect(parseJsonLoose('{"q":"she said \\"go\\""}')).toEqual({ q: 'she said "go"' });
  });

  it('does not stop at a brace inside an earlier code block', () => {
    const reply = '```js\nconst x = {not: "this"};\n```\n{"prompt":"the real one"}';
    expect(parseJsonLoose(reply)).toEqual({ prompt: 'the real one' });
  });

  it('throws when there is no JSON, so the caller falls back deliberately', () => {
    expect(() => parseJsonLoose('I cannot help with that.')).toThrow();
    expect(() => parseJsonLoose('')).toThrow();
  });

  it('throws on a truncated object rather than guessing at the missing half', () => {
    expect(() => parseJsonLoose('{"a":1')).toThrow();
  });
});
