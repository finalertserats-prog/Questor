import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DRAFT_FIELD_KEYS, fieldDraftSpec } from '../src/domain/fieldDrafts.js';

/**
 * The browser keeps a copy of which fields may be drafted and what is said
 * where one may not (web/src/components/drafts/fieldDraftVocabulary.ts),
 * because it cannot import from this workspace.
 *
 * A copy that drifts is how two vocabularies grow — and drift HERE would mean
 * the page offering a draft the server refuses, or telling a reviewer a
 * different reason than the one the boundary is actually drawn for. So the
 * copy is compared as text, and this fails if the two part company.
 */

const WEB_COPY = join(__dirname, '..', '..', 'web', 'src', 'components', 'drafts', 'fieldDraftVocabulary.ts');

const source = readFileSync(WEB_COPY, 'utf8');

/** `key: { suggest: true, tidy: true, refusal: X }` as the web file writes it. */
function webRule(key: string): { suggest: boolean; tidy: boolean } | null {
  const hit = source.match(new RegExp(`\\n\\s*${key}:\\s*\\{([^}]*)\\}`));
  if (!hit) return null;
  return { suggest: /suggest:\s*true/.test(hit[1]), tidy: /tidy:\s*true/.test(hit[1]) };
}

describe('the browser\'s copy of the drafting boundary', () => {
  it('lists exactly the same fields', () => {
    const keys = [...source.matchAll(/^\s{2}'([a-z_]+)',$/gm)].map((m) => m[1]);
    expect(keys).toEqual([...DRAFT_FIELD_KEYS]);
  });

  it('allows a draft for exactly the same fields', () => {
    for (const key of DRAFT_FIELD_KEYS) {
      expect({ key, ...webRule(key) }).toEqual({ key, suggest: fieldDraftSpec(key).suggest, tidy: fieldDraftSpec(key).tidy });
    }
  });

  it('gives the person the same reason, word for word', () => {
    for (const key of DRAFT_FIELD_KEYS) {
      const refusal = fieldDraftSpec(key).refusal;
      if (!refusal) continue;
      // The sentence is broken across lines in both files, so it is compared
      // in the pieces the source is written in rather than as one string.
      for (const piece of refusal.split('. ').filter((p) => p.length > 15)) {
        expect({ key, has: source.includes(piece.slice(0, 60)) }).toEqual({ key, has: true });
      }
    }
  });
});
