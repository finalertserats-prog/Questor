import { describe, it, expect } from 'vitest';
import {
  IDLE_TOUR,
  TOUR_STEPS,
  isFirstStep,
  isLastStep,
  keyAction,
  needsDrawer,
  nextStep,
  placeTourCard,
  previousStep,
  restartTour,
  shouldAutoStartTour,
  skipTour,
  startTour,
  stepAnnouncement,
  stepPosition,
  tourHasEnded,
  tourMotion,
  type TourStep,
} from '../src/components/tourModel';

/**
 * The guided tour's decisions — which steps exist, in what order, and how the
 * reader moves through them — kept as pure logic so they can be tested in the
 * node environment this workspace uses (no DOM, no jsdom). The React overlay
 * only measures elements and draws what this module decides.
 */

const everyAnchorPresent = () => true;

// Three anchored steps with a centred welcome, so a missing anchor can be
// simulated without depending on the product's real step list.
const STEPS: readonly TourStep[] = [
  { id: 'welcome', title: 'Welcome', body: 'Hello.' },
  { id: 'one', anchor: 'one', title: 'One', body: 'First anchored step.' },
  { id: 'two', anchor: 'two', title: 'Two', body: 'Second anchored step.' },
  { id: 'three', anchor: 'three', title: 'Three', body: 'Third anchored step.' },
];

const without = (...missing: string[]) => (anchor: string | undefined) => anchor === undefined || !missing.includes(anchor);

describe('TOUR_STEPS', () => {
  it('walks the product in order: welcome, sidebar, dashboard, pipeline, profile menu, finish', () => {
    expect(TOUR_STEPS.map((step) => step.id)).toEqual([
      'welcome',
      'nav-dashboard',
      'nav-candidates',
      'nav-roles',
      'nav-interviews',
      'nav-add-candidate',
      'nav-new-role',
      'workflow',
      'kpis',
      'trends',
      'pipeline-stages',
      'recent-interviews',
      'profile-menu',
      'finish',
    ]);
  });

  it('opens with a centred welcome step that points at nothing', () => {
    expect(TOUR_STEPS[0].anchor).toBeUndefined();
  });

  it('gives every step a title and an explanation', () => {
    expect(TOUR_STEPS.every((step) => step.title.length > 0 && step.body.length > 0)).toBe(true);
  });

  it('marks every sidebar step so the phone drawer can be opened for it', () => {
    const sidebarIds = TOUR_STEPS.filter((step) => step.inSidebar).map((step) => step.id);
    expect(sidebarIds).toEqual(['nav-dashboard', 'nav-candidates', 'nav-roles', 'nav-interviews', 'nav-add-candidate', 'nav-new-role', 'profile-menu', 'finish']);
  });

  it('explains the medallion stages including the AI-run Silver round', () => {
    const stages = TOUR_STEPS.find((step) => step.id === 'pipeline-stages')!;
    for (const word of ['Participation', 'Bronze', 'Silver', 'AI interviewer', 'Gold', 'Diamond']) {
      expect(stages.body).toContain(word);
    }
  });

  it('no longer mentions the retired Platinum stage', () => {
    const stages = TOUR_STEPS.find((step) => step.id === 'pipeline-stages')!;
    expect(stages.body).not.toContain('Platinum');
  });

  it('tells the reader where to restart the tour on the final step', () => {
    expect(TOUR_STEPS[TOUR_STEPS.length - 1].body).toContain('Take the tour');
  });
});

describe('startTour', () => {
  it('begins running at the first step', () => {
    expect(startTour(STEPS, everyAnchorPresent)).toEqual({ status: 'running', index: 0 });
  });

  it('begins at the first step whose anchor is present', () => {
    const anchoredOnly = STEPS.slice(1);
    expect(startTour(anchoredOnly, without('one')).index).toBe(1);
  });
});

describe('nextStep', () => {
  it('moves to the following step', () => {
    const state = startTour(STEPS, everyAnchorPresent);
    expect(nextStep(state, STEPS, everyAnchorPresent).index).toBe(1);
  });

  it('skips a step whose anchor is absent from the page', () => {
    const state = startTour(STEPS, everyAnchorPresent);
    expect(nextStep(state, STEPS, without('one')).index).toBe(2);
  });

  it('completes the tour when stepping past the last step', () => {
    const state = { status: 'running', index: 3 } as const;
    expect(nextStep(state, STEPS, everyAnchorPresent).status).toBe('completed');
  });

  it('completes the tour when every remaining anchor is absent', () => {
    const state = { status: 'running', index: 1 } as const;
    expect(nextStep(state, STEPS, without('two', 'three')).status).toBe('completed');
  });

  it('does nothing once the tour has ended', () => {
    const ended = skipTour(startTour(STEPS, everyAnchorPresent));
    expect(nextStep(ended, STEPS, everyAnchorPresent)).toBe(ended);
  });
});

describe('previousStep', () => {
  it('moves to the preceding step', () => {
    const state = { status: 'running', index: 2 } as const;
    expect(previousStep(state, STEPS, everyAnchorPresent).index).toBe(1);
  });

  it('skips backwards over a step whose anchor is absent', () => {
    const state = { status: 'running', index: 2 } as const;
    expect(previousStep(state, STEPS, without('one')).index).toBe(0);
  });

  it('stays on the first step rather than going below it', () => {
    const state = startTour(STEPS, everyAnchorPresent);
    expect(previousStep(state, STEPS, everyAnchorPresent)).toBe(state);
  });
});

describe('isFirstStep and isLastStep', () => {
  it('reports the first present step as first', () => {
    expect(isFirstStep({ status: 'running', index: 0 }, STEPS, everyAnchorPresent)).toBe(true);
  });

  it('treats a step as first when everything before it is absent', () => {
    const anchoredOnly = STEPS.slice(1);
    expect(isFirstStep({ status: 'running', index: 1 }, anchoredOnly, without('one'))).toBe(true);
  });

  it('reports the last present step as last', () => {
    expect(isLastStep({ status: 'running', index: 3 }, STEPS, everyAnchorPresent)).toBe(true);
  });

  it('treats a step as last when everything after it is absent', () => {
    expect(isLastStep({ status: 'running', index: 1 }, STEPS, without('two', 'three'))).toBe(true);
  });

  it('does not report a middle step as last', () => {
    expect(isLastStep({ status: 'running', index: 1 }, STEPS, everyAnchorPresent)).toBe(false);
  });
});

describe('ending and restarting', () => {
  it('skipping ends the tour where it was', () => {
    expect(skipTour({ status: 'running', index: 2 })).toEqual({ status: 'skipped', index: 2 });
  });

  it('reports skipped and completed tours as ended, and a running one as not', () => {
    expect([
      tourHasEnded(skipTour(startTour(STEPS, everyAnchorPresent))),
      tourHasEnded({ status: 'completed', index: 3 }),
      tourHasEnded(startTour(STEPS, everyAnchorPresent)),
      tourHasEnded(IDLE_TOUR),
    ]).toEqual([true, true, false, false]);
  });

  it('restarting after completion begins again at step one', () => {
    expect(restartTour(STEPS, everyAnchorPresent)).toEqual({ status: 'running', index: 0 });
  });
});

describe('shouldAutoStartTour', () => {
  it('starts on the dashboard for a user who has never finished or skipped it', () => {
    expect(shouldAutoStartTour({ tourCompletedAt: null }, '/')).toBe(true);
  });

  it('never starts again once the server records a completion', () => {
    expect(shouldAutoStartTour({ tourCompletedAt: '2026-09-16T10:00:00.000Z' }, '/')).toBe(false);
  });

  it('waits for the dashboard rather than starting on a deep link', () => {
    expect(shouldAutoStartTour({ tourCompletedAt: null }, '/candidates/abc')).toBe(false);
  });

  it('does not start with nobody signed in', () => {
    expect(shouldAutoStartTour(null, '/')).toBe(false);
  });
});

describe('stepPosition and stepAnnouncement', () => {
  it('counts only the steps that are present on this page', () => {
    expect(stepPosition({ status: 'running', index: 2 }, STEPS, without('one'))).toEqual({ current: 2, total: 3 });
  });

  it('reads the step number and title aloud', () => {
    expect(stepAnnouncement(STEPS[2], { current: 3, total: 4 })).toBe('Step 3 of 4: Two');
  });
});

describe('tourMotion', () => {
  it('scrolls instantly and does not animate when motion is reduced', () => {
    expect(tourMotion(true)).toEqual({ scrollBehavior: 'auto', animate: false });
  });

  it('scrolls smoothly and animates otherwise', () => {
    expect(tourMotion(false)).toEqual({ scrollBehavior: 'smooth', animate: true });
  });
});

describe('keyAction', () => {
  it('maps Escape to skip, the arrow keys to back and next, and ignores the rest', () => {
    expect(['Escape', 'ArrowRight', 'ArrowLeft', 'Tab', 'Enter'].map(keyAction)).toEqual(['skip', 'next', 'back', null, null]);
  });
});

describe('needsDrawer', () => {
  it('asks for the drawer only for a sidebar step on a narrow viewport', () => {
    const sidebarStep: TourStep = { id: 's', anchor: 's', title: 'S', body: 'b', inSidebar: true };
    const pageStep: TourStep = { id: 'p', anchor: 'p', title: 'P', body: 'b' };
    expect([needsDrawer(sidebarStep, true), needsDrawer(sidebarStep, false), needsDrawer(pageStep, true)]).toEqual([true, false, false]);
  });
});

describe('placeTourCard', () => {
  const viewport = { width: 1200, height: 800 };
  const card = { width: 320, height: 200 };

  it('centres the card when there is nothing to point at', () => {
    expect(placeTourCard(null, card, viewport)).toEqual({ top: 300, left: 440, placement: 'center' });
  });

  it('sits to the right of a sidebar item when there is room', () => {
    const target = { top: 100, left: 0, width: 200, height: 40 };
    expect(placeTourCard(target, card, viewport)).toEqual({ top: 100, left: 212, placement: 'right' });
  });

  it('sits below a wide element when there is no room beside it', () => {
    const target = { top: 100, left: 40, width: 1100, height: 120 };
    expect(placeTourCard(target, card, viewport).placement).toBe('bottom');
  });

  it('sits above an element near the bottom of the viewport', () => {
    const target = { top: 700, left: 40, width: 1100, height: 80 };
    expect(placeTourCard(target, card, viewport)).toEqual({ top: 488, left: 40, placement: 'top' });
  });

  it('keeps the card inside the viewport', () => {
    const target = { top: 100, left: 1000, width: 190, height: 40 };
    const placed = placeTourCard(target, card, viewport);
    expect(placed.left + card.width).toBeLessThanOrEqual(viewport.width);
  });

  it('docks the card to the bottom on a phone', () => {
    const phone = { width: 380, height: 700 };
    const target = { top: 80, left: 0, width: 300, height: 40 };
    expect(placeTourCard(target, card, phone).placement).toBe('sheet');
  });
});
