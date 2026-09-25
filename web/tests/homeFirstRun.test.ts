import { describe, expect, it } from 'vitest';
import { hasNothingYet } from '../src/components/hrbox/needsYouModel';
import type { NeedsYouFeed } from '../src/components/hrbox/needsYouModel';

/**
 * The first screen a new organisation sees.
 *
 * Home told an organisation where nothing had happened yet the same thing it
 * told a team that was simply caught up: "Nothing needs you — the interviewers
 * will say when something does." To someone who had just been given an
 * account, the product's own opening line said wait, and the only first-run
 * guidance in Questor sat on a tab they were never shown.
 *
 * Two real organisations registered in production, saw that screen, and never
 * created a role. These tests exist so the two states can never collapse back
 * into one.
 */

function feed(over: Partial<NeedsYouFeed> = {}): NeedsYouFeed {
  return {
    generatedAt: new Date().toISOString(),
    crew: [],
    needsYou: { total: 0, page: 1, pageSize: 10, items: [] },
    comingUp: [],
    doneRecently: [],
    ...over,
  } as NeedsYouFeed;
}

describe('an organisation where nothing has happened yet', () => {
  it('is recognised when there is no work, nothing booked and nothing done', () => {
    expect(hasNothingYet(feed())).toBe(true);
  });

  it('is not the same as a team that is caught up for the moment', () => {
    // Nothing needs them right now, but interviews are booked. This team knows
    // what Questor is for; telling them to create their first role would be
    // wrong, and telling them to wait is right.
    const busy = feed({ comingUp: [{ id: 'c1' } as never] });
    expect(hasNothingYet(busy)).toBe(false);
  });

  it('is not the same as a team whose work is all behind them', () => {
    const finished = feed({ doneRecently: [{ id: 'd1' } as never] });
    expect(hasNothingYet(finished)).toBe(false);
  });

  it('is not claimed while something is actually waiting on someone', () => {
    const waiting = feed({ needsYou: { total: 1, page: 1, pageSize: 10, items: [{ id: 'n1' } as never] } });
    expect(hasNothingYet(waiting)).toBe(false);
  });
});
