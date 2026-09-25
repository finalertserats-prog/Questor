// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createElement, useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TourOverlay } from '../src/components/TourOverlay';
import { IDLE_TOUR, startTour, type TourState, type TourStep } from '../src/components/tourModel';

/**
 * The property: while a tour step is running, the reader can always see a way
 * out of it.
 *
 * The overlay's scrim covers the viewport and answers no click, and its card
 * is a focus trap, so the page underneath is unreachable by pointer and by
 * keyboard alike. A step that cannot find its element therefore must not
 * simply draw nothing — that is a reader shut inside an invisible box on a
 * page that looks ordinary, and it is what this used to do for six seconds
 * with Escape as the only exit.
 *
 * These are the cases the model tests cannot reach, because they are about
 * what is on the screen rather than what the model decided. There is no
 * fake timer here: every case asserts the FIRST frame, which is the one the
 * old code left empty.
 */

const everyStep = () => true;

function Harness({ steps }: { steps: readonly TourStep[] }) {
  const [state, setState] = useState<TourState>(() => startTour(steps, everyStep));
  return createElement(TourOverlay, { steps, state, setState, present: everyStep });
}

function show(steps: readonly TourStep[]) {
  return render(createElement(MemoryRouter, null, createElement(Harness, { steps })));
}

afterEach(cleanup);

describe('a step whose element is not on the page', () => {
  const missing: readonly TourStep[] = [
    { id: 'nowhere', anchor: 'not-in-this-document', title: 'Nowhere', body: 'Points at something that is not here.' },
  ];

  it('still shows the card, so the reader is never behind a scrim with nothing to press', () => {
    show(missing);
    expect(screen.getByTestId('tour-card')).toBeTruthy();
    expect(screen.getByTestId('tour-skip')).toBeTruthy();
    expect(screen.getByTestId('tour-next')).toBeTruthy();
  });

  it('draws no spotlight, because there is nothing to point at', () => {
    show(missing);
    expect(screen.queryByTestId('tour-spotlight')).toBeNull();
  });

  it('still says where the reader is', () => {
    show(missing);
    expect(screen.getByTestId('tour-card').textContent).toContain('Step 1 of 1');
  });

  it('puts focus on the card, so Tab reaches the way out too', () => {
    show(missing);
    expect(document.activeElement).toBe(screen.getByTestId('tour-card'));
  });
});

describe('a step whose element is on the page', () => {
  const here: readonly TourStep[] = [
    { id: 'here', anchor: 'present-anchor', title: 'Here', body: 'Points at something real.' },
  ];

  it('spotlights it, and the card is there as always', () => {
    const target = document.createElement('div');
    target.setAttribute('data-tour', 'present-anchor');
    // jsdom lays nothing out, so getClientRects is empty unless it is told.
    target.getClientRects = (() => [{ top: 10, left: 10, width: 100, height: 20 }]) as unknown as typeof target.getClientRects;
    target.scrollIntoView = () => undefined;
    document.body.appendChild(target);
    try {
      show(here);
      expect(screen.getByTestId('tour-spotlight')).toBeTruthy();
      expect(screen.getByTestId('tour-card')).toBeTruthy();
    } finally {
      target.remove();
    }
  });
});

describe('a companion anchor settles a missing one at once', () => {
  // B21's shape: the button is gone, the stage track it is drawn beside is
  // not, so the step is finished with rather than waited out.
  const steps: readonly TourStep[] = [
    { id: 'first', title: 'First', body: 'A centred card, nothing to point at.' },
    { id: 'gone', anchor: 'gone-button', anchorSettledBy: 'the-panel', title: 'Gone', body: 'Its control has been used up.' },
    { id: 'after', title: 'After', body: 'Where the reader should end up.' },
  ];

  it('moves the reader on rather than holding them in front of it', async () => {
    const panel = document.createElement('div');
    panel.setAttribute('data-tour', 'the-panel');
    panel.getClientRects = (() => [{ top: 0, left: 0, width: 10, height: 10 }]) as unknown as typeof panel.getClientRects;
    panel.scrollIntoView = () => undefined;
    document.body.appendChild(panel);
    try {
      show(steps);
      expect(screen.getByTestId('tour').getAttribute('data-step')).toBe('first');
      await act(async () => { screen.getByTestId('tour-next').click(); });
      // Never parks on 'gone': the companion is present, so its absence is final.
      expect(screen.getByTestId('tour').getAttribute('data-step')).toBe('after');
      expect(screen.getByTestId('tour-card')).toBeTruthy();
    } finally {
      panel.remove();
    }
  });
});

describe('the overlay draws nothing at all when no tour is running', () => {
  it('leaves the page alone', () => {
    const steps: readonly TourStep[] = [{ id: 'a', title: 'A', body: 'a' }];
    render(createElement(MemoryRouter, null, createElement(TourOverlay, {
      steps, state: IDLE_TOUR, setState: () => undefined, present: everyStep,
    })));
    expect(screen.queryByTestId('tour')).toBeNull();
    expect(screen.queryByTestId('tour-card')).toBeNull();
  });
});
