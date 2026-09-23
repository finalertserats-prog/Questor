// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AssessmentTranscript } from '../src/components/assessment/AssessmentTranscript';
import {
  hasReadAll, markEndReached, markTurnSeen, noTurnsSeen, reportableIndexes, turnsReadLabel,
} from '../src/components/review/transcriptReadGate';
import type { TranscriptRow } from '../src/components/review/transcriptReaderModel';

/**
 * The control that satisfies the transcript requirement, checked on the path
 * that has no scrollbar in it.
 *
 * jsdom has no IntersectionObserver and no layout, so nothing here can be
 * satisfied by scrolling — which is exactly the point. A reviewer using a
 * screen reader or a keyboard is in the same position, and if the gate cannot
 * be met this way it cannot be met by them at all.
 */

afterEach(cleanup);

const ROWS: TranscriptRow[] = [0, 1, 2].map((i) => ({
  key: String(i),
  turnIndex: i,
  turnId: `t${i}`,
  voice: i % 2 === 0 ? 'interviewer' : 'candidate',
  label: i % 2 === 0 ? 'Avery' : 'Arjun Mehta',
  text: `Turn number ${i}.`,
  stamp: '12:0' + i,
  competency: null,
  leftByButton: false,
}));

function transcript(over: Record<string, unknown> = {}) {
  const props = {
    status: 'ready' as const,
    rows: ROWS,
    error: '',
    onRetry: () => undefined,
    quotedTurnId: '',
    quotedAt: 0,
    transcriptKey: 'k1',
    onRead: () => undefined,
    ...over,
  };
  return render(h(AssessmentTranscript, props));
}

describe('reaching the transcript without a scrollbar', () => {
  it('puts every turn in the tab order', () => {
    transcript();
    for (const turn of screen.getAllByTestId('transcript-turn')) {
      expect(turn.getAttribute('tabindex')).toBe('0');
    }
  });

  it('reports a turn as shown when it takes focus', () => {
    const seen: number[] = [];
    transcript({ onTurnSeen: (i: number) => seen.push(i) });
    fireEvent.focus(screen.getAllByTestId('transcript-turn')[1]);
    expect(seen).toEqual([1]);
  });

  it('ends with a real, reachable control rather than an invisible sentinel', () => {
    transcript();
    const end = screen.getByTestId('transcript-end');
    expect(end.tagName).toBe('BUTTON');
    expect(end.textContent).toContain('End of transcript');
  });

  it('reports the end when that control takes focus', () => {
    const ends: number[] = [];
    transcript({ onEndReached: () => ends.push(1) });
    fireEvent.focus(screen.getByTestId('transcript-end'));
    expect(ends).toHaveLength(1);
  });

  it('reports the end when that control is pressed', () => {
    const ends: number[] = [];
    transcript({ onEndReached: () => ends.push(1) });
    fireEvent.click(screen.getByTestId('transcript-end'));
    expect(ends).toHaveLength(1);
  });

  it('offers a way out of the run of turns, one Tab from the column', () => {
    transcript();
    const skip = screen.getByTestId('transcript-skip');
    expect(skip.tagName).toBe('BUTTON');
    expect(skip.textContent).toContain('Skip to the end');
  });

  it('sends that way out straight to the end marker', () => {
    const ends: number[] = [];
    transcript({ onEndReached: () => ends.push(1) });
    fireEvent.click(screen.getByTestId('transcript-skip'));
    expect(document.activeElement).toBe(screen.getByTestId('transcript-end'));
    expect(ends).toHaveLength(1);
  });

  it('offers no end marker while there is nothing to read', () => {
    transcript({ rows: [] });
    expect(screen.queryByTestId('transcript-end')).toBeNull();
  });
});

describe('an empty transcript', () => {
  it('reads as satisfied by the pure rule, which is why the page must not ask before it has loaded', () => {
    // Vacuously true of no turns. Recorded here because it is the trap: the
    // page guards on the transcript being ready AND having rows before it
    // records anything (pages/AssessmentView.tsx), and the server checks the
    // indexes against the interview it has.
    expect(hasReadAll(noTurnsSeen('k1'), [])).toBe(true);
  });
});

describe('what those reports add up to', () => {
  const all = [0, 1, 2];

  it('is satisfied by focusing the end marker alone — the one-step path', () => {
    const state = markEndReached(noTurnsSeen('k1'));
    expect(hasReadAll(state, all)).toBe(true);
    expect(reportableIndexes(state, all)).toEqual(all);
  });

  it('is satisfied by tabbing through every turn', () => {
    const state = all.reduce(markTurnSeen, noTurnsSeen('k1'));
    expect(hasReadAll(state, all)).toBe(true);
  });

  it('is not satisfied by part of the transcript', () => {
    const state = markTurnSeen(markTurnSeen(noTurnsSeen('k1'), 0), 1);
    expect(hasReadAll(state, all)).toBe(false);
    expect(turnsReadLabel(state, all)).toBe('Read 2 of 3 turns');
  });
});

describe('driving the whole thing by keyboard only', () => {
  it('reaches "read" from focus events alone, with no scrolling anywhere', () => {
    let state = noTurnsSeen('k1');
    transcript({
      onTurnSeen: (i: number) => { state = markTurnSeen(state, i); },
      onEndReached: () => { state = markEndReached(state); },
    });
    // What Tab does: each turn in order, then the control after them.
    for (const turn of screen.getAllByTestId('transcript-turn')) fireEvent.focus(turn);
    fireEvent.focus(screen.getByTestId('transcript-end'));
    expect(hasReadAll(state, [0, 1, 2])).toBe(true);
  });

  it('reaches "read" from the end marker alone, which is how a screen reader arrives', () => {
    let state = noTurnsSeen('k1');
    transcript({ onEndReached: () => { state = markEndReached(state); } });
    fireEvent.focus(screen.getByTestId('transcript-end'));
    expect(hasReadAll(state, [0, 1, 2])).toBe(true);
  });
});

describe('when the browser has no IntersectionObserver', () => {
  it('still renders, and still reports through focus', () => {
    const original = globalThis.IntersectionObserver;
    // @ts-expect-error — removing it is the point of the test.
    delete globalThis.IntersectionObserver;
    try {
      const seen: number[] = [];
      transcript({ onTurnSeen: (i: number) => seen.push(i) });
      fireEvent.focus(screen.getAllByTestId('transcript-turn')[0]);
      expect(seen).toEqual([0]);
    } finally {
      if (original) globalThis.IntersectionObserver = original;
    }
  });
});

describe('the observer, where the browser has one', () => {
  it('reports the turns and the end it is given', () => {
    const seen: number[] = [];
    const ends: number[] = [];
    let fire: ((entries: unknown[]) => void) | null = null;
    class FakeObserver {
      constructor(cb: (entries: unknown[]) => void) { fire = cb; }
      observe() { /* the test fires the callback itself */ }
      disconnect() { /* nothing to let go of */ }
    }
    const original = globalThis.IntersectionObserver;
    // @ts-expect-error — a stand-in with the shape the component uses.
    globalThis.IntersectionObserver = FakeObserver;
    try {
      transcript({ onTurnSeen: (i: number) => seen.push(i), onEndReached: () => ends.push(1) });
      const turn = screen.getAllByTestId('transcript-turn')[2];
      const end = screen.getByTestId('transcript-end');
      fire?.([
        { isIntersecting: true, target: turn },
        { isIntersecting: false, target: screen.getAllByTestId('transcript-turn')[0] },
        { isIntersecting: true, target: end },
      ]);
      expect(seen).toEqual([2]);
      expect(ends).toHaveLength(1);
    } finally {
      if (original) globalThis.IntersectionObserver = original;
      else vi.unstubAllGlobals();
    }
  });
});
