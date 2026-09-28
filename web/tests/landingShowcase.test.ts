import { describe, it, expect } from 'vitest';
import {
  SHOWCASE_STEPS,
  SHOWCASE_FEATURES,
  STEP_INTERVAL_MS,
  initialShowcaseState,
  showcaseReducer,
  type ShowcaseState,
} from '../src/components/landingShowcase';

const running: ShowcaseState = { step: 0, paused: false };
const last = SHOWCASE_STEPS.length - 1;

describe('SHOWCASE_STEPS', () => {
  it('runs the hiring workflow in the order each step depends on', () => {
    expect(SHOWCASE_STEPS.map((step) => step.key)).toEqual([
      'scorecard',
      'onboard',
      'fit',
      'ai-interview',
      'human-rounds',
      'decision',
    ]);
  });

  it('names the AI interview round as the fourth step', () => {
    expect(SHOWCASE_STEPS[3].title).toBe('The AI interview round');
  });

  it('ends on a decision a person makes', () => {
    expect(SHOWCASE_STEPS[last].detail).toContain('person');
  });

  it('gives every step a distinct key', () => {
    expect(new Set(SHOWCASE_STEPS.map((step) => step.key)).size).toBe(SHOWCASE_STEPS.length);
  });

  it('gives every step a title and a supporting detail', () => {
    for (const step of SHOWCASE_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.detail.length).toBeGreaterThan(0);
    }
  });
});

describe('STEP_INTERVAL_MS', () => {
  it('holds each step long enough to read, without stalling', () => {
    expect(STEP_INTERVAL_MS).toBeGreaterThanOrEqual(3000);
    expect(STEP_INTERVAL_MS).toBeLessThanOrEqual(8000);
  });
});

describe('initialShowcaseState', () => {
  it('starts on the first step and plays when motion is allowed', () => {
    expect(initialShowcaseState(false)).toEqual({ step: 0, paused: false });
  });

  it('starts paused on the first step when reduced motion is requested', () => {
    expect(initialShowcaseState(true)).toEqual({ step: 0, paused: true });
  });
});

describe('showcaseReducer', () => {
  it('advances to the next step on a tick', () => {
    expect(showcaseReducer(running, { type: 'tick' })).toEqual({ step: 1, paused: false });
  });

  it('wraps back to the first step after the last one', () => {
    expect(showcaseReducer({ step: last, paused: false }, { type: 'tick' })).toEqual({ step: 0, paused: false });
  });

  it('does not advance while paused, so reduced motion stays on the first step', () => {
    const still = showcaseReducer(initialShowcaseState(true), { type: 'tick' });
    expect(still).toEqual({ step: 0, paused: true });
    expect(showcaseReducer(still, { type: 'tick' }).step).toBe(0);
  });

  it('pauses on interaction and shows the step the person chose', () => {
    expect(showcaseReducer(running, { type: 'select', step: 4 })).toEqual({ step: 4, paused: true });
  });

  it('ignores a selection outside the sequence', () => {
    expect(showcaseReducer(running, { type: 'select', step: 99 })).toBe(running);
    expect(showcaseReducer(running, { type: 'select', step: -1 })).toBe(running);
  });

  it('pauses without moving when a pointer or focus enters the sequence', () => {
    expect(showcaseReducer({ step: 2, paused: false }, { type: 'pause' })).toEqual({ step: 2, paused: true });
  });

  it('resumes from where it was left when the interaction ends', () => {
    expect(showcaseReducer({ step: 2, paused: true }, { type: 'resume' })).toEqual({ step: 2, paused: false });
  });

  it('returns the same state object when nothing changes, so React can skip a render', () => {
    expect(showcaseReducer(running, { type: 'resume' })).toBe(running);
    const paused: ShowcaseState = { step: 0, paused: true };
    expect(showcaseReducer(paused, { type: 'pause' })).toBe(paused);
    expect(showcaseReducer(paused, { type: 'tick' })).toBe(paused);
  });
});

describe('SHOWCASE_FEATURES', () => {
  it('gives every feature a distinct key, a title and a detail', () => {
    expect(new Set(SHOWCASE_FEATURES.map((f) => f.key)).size).toBe(SHOWCASE_FEATURES.length);
    for (const feature of SHOWCASE_FEATURES) {
      expect(feature.title.length).toBeGreaterThan(0);
      expect(feature.detail.length).toBeGreaterThan(0);
    }
  });

  it('claims nothing Questor cannot do: no Teams, Zoom or Meet meeting creation', () => {
    const copy = [
      ...SHOWCASE_FEATURES.map((f) => `${f.title} ${f.detail}`),
      ...SHOWCASE_STEPS.map((s) => `${s.title} ${s.detail}`),
    ]
      .join(' ')
      .toLowerCase();
    for (const vendor of ['teams', 'zoom', 'google meet', 'webex']) {
      expect(copy).not.toContain(vendor);
    }
  });

  it('introduces the AI interviewers where the AI round is described', () => {
    const step = SHOWCASE_STEPS.find((s) => s.key === 'ai-interview');
    expect(step?.detail.toLowerCase()).toContain('five ai interviewers');
  });

  it('introduces the AI interviewers once, so the idea is never used before it is explained', () => {
    const copy = [
      ...SHOWCASE_FEATURES.map((f) => `${f.title} ${f.detail}`),
      ...SHOWCASE_STEPS.map((s) => `${s.title} ${s.detail}`),
    ].join(' ');
    expect(copy.match(/five AI interviewers/g)).toHaveLength(1);
  });
});
