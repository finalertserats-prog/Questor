import { describe, it, expect } from 'vitest';
import {
  BAR_LAYOUT,
  axisLabelStride,
  clampLabelCenter,
  estimateTextWidth,
  chooseBarLayout,
  truncateToWidth,
  wrapToLines,
} from '../src/components/dashboardModel';

// A fixed-pitch stand-in for canvas measureText: 7px per character.
const measure = (text: string) => text.length * 7;

describe('estimateTextWidth', () => {
  it('grows with the number of characters', () => {
    expect(estimateTextWidth('abcd', 12)).toBeGreaterThan(estimateTextWidth('ab', 12));
  });

  it('is zero for an empty string', () => {
    expect(estimateTextWidth('', 12)).toBe(0);
  });
});

describe('wrapToLines', () => {
  it('keeps a line that fits', () => {
    expect(wrapToLines('Senior Engineer', 200, measure, 2)).toEqual(['Senior Engineer']);
  });

  it('breaks at spaces', () => {
    expect(wrapToLines('Senior Backend Engineer', 60, measure, 2)).toEqual(['Senior', 'Backend…']);
  });

  it('breaks a single word too long for a line', () => {
    expect(wrapToLines('Supercalifragilistic', 70, measure, 3).every((line) => measure(line) <= 70)).toBe(true);
  });
});

describe('truncateToWidth', () => {
  it('leaves a label that fits unchanged', () => {
    expect(truncateToWidth('Backend', 100, measure)).toBe('Backend');
  });

  it('ends a label that does not fit with an ellipsis', () => {
    expect(truncateToWidth('Senior Backend Engineer (Payments)', 70, measure).endsWith('…')).toBe(true);
  });

  it('never returns a label wider than the room it was given', () => {
    expect(measure(truncateToWidth('Senior Backend Engineer (Payments)', 70, measure))).toBeLessThanOrEqual(70);
  });

  it('returns just the ellipsis when there is no room for any character', () => {
    expect(truncateToWidth('Engineer', 8, measure)).toBe('…');
  });
});

describe('chooseBarLayout', () => {
  const values = [3, 12];
  const long = 'Senior Backend Engineer (Payments) · Senior · IN';

  it('keeps labels beside the bars when every label fits', () => {
    expect(chooseBarLayout(['QA', 'Design'], values, 480, measure, measure).mode).toBe('inline');
  });

  it('sizes the inline label column from the longest label', () => {
    const layout = chooseBarLayout(['QA', 'Design'], values, 480, measure, measure);
    expect(layout.labelW).toBe(measure('Design') + BAR_LAYOUT.labelGap);
  });

  it('never truncates an inline label', () => {
    expect(chooseBarLayout(['QA', 'Design'], values, 480, measure, measure).labelLines).toEqual([['QA'], ['Design']]);
  });

  it('stacks the label above the bar when a label would not fit beside it', () => {
    expect(chooseBarLayout([long, 'QA'], values, 600, measure, measure).mode).toBe('stacked');
  });

  it('keeps a long label on one line when it fits the full width', () => {
    expect(chooseBarLayout([long, 'QA'], values, 600, measure, measure).labelLines[0]).toEqual([long]);
  });

  it('stacks at phone width', () => {
    expect(chooseBarLayout(['Senior Backend Engineer', 'QA'], values, 300, measure, measure).mode).toBe('stacked');
  });

  it('gives a stacked bar the full width left of the value column', () => {
    const layout = chooseBarLayout([long], [12], 400, measure, measure);
    expect(layout.labelW + layout.plotW + layout.valueW).toBe(400);
  });

  it('wraps a stacked label that is wider than the chart onto a second line', () => {
    const layout = chooseBarLayout([long], [12], 200, measure, measure);
    expect(layout.labelLines[0].join(' ')).toBe(long);
  });

  it('never draws a wrapped line wider than the chart', () => {
    const layout = chooseBarLayout([long], [12], 200, measure, measure);
    expect(Math.max(...layout.labelLines[0].map(measure))).toBeLessThanOrEqual(200);
  });

  it('gives a two-line label a taller row', () => {
    const layout = chooseBarLayout([long, 'QA'], [12, 1], 200, measure, measure);
    expect(layout.rowTops[1]).toBeGreaterThan(layout.rowHeight);
  });

  it('ellipsises only what would need a third line', () => {
    const huge = `${long} ${long} ${long}`;
    const layout = chooseBarLayout([huge], [12], 200, measure, measure);
    expect(layout.labelLines[0].length === 2 && layout.labelLines[0][1].endsWith('…')).toBe(true);
  });

  it('adds the rows up to the chart height', () => {
    const layout = chooseBarLayout([long, 'QA'], [12, 1], 200, measure, measure);
    expect(layout.height).toBe(layout.rowTops[1] + layout.rowHeight);
  });

  it('ends the widest value at least 8px inside the svg when inline', () => {
    const layout = chooseBarLayout(['QA', 'B'], [1234, 5], 400, measure, measure);
    const valueRight = layout.labelW + layout.plotW + BAR_LAYOUT.valueGap + measure('1234');
    expect(valueRight).toBeLessThanOrEqual(400 - 8);
  });

  it('ends the widest value at least 8px inside the svg when stacked', () => {
    const layout = chooseBarLayout([long], [987], 390, measure, measure);
    const valueRight = layout.labelW + layout.plotW + BAR_LAYOUT.valueGap + measure('987');
    expect(valueRight).toBeLessThanOrEqual(390 - 8);
  });

  it('never gives the plot a negative width when the chart is tiny', () => {
    expect(chooseBarLayout(['Senior Backend Engineer'], [987654], 40, measure, measure).plotW).toBeGreaterThanOrEqual(0);
  });

  it('handles an empty list', () => {
    expect(chooseBarLayout([], [], 300, measure, measure).labelLines).toEqual([]);
  });

  it('gives stacked rows room for a label line above the bar', () => {
    const stacked = chooseBarLayout([long], [1], 400, measure, measure);
    const inline = chooseBarLayout(['QA'], [1], 400, measure, measure);
    expect(stacked.rowHeight).toBeGreaterThan(inline.rowHeight);
  });
});

describe('axisLabelStride', () => {
  it('labels every slot when the labels fit', () => {
    expect(axisLabelStride(80, 40)).toBe(1);
  });

  it('skips slots so measured labels never overlap on a phone', () => {
    const stride = axisLabelStride(22, 40);
    expect(stride * 22).toBeGreaterThanOrEqual(40 + BAR_LAYOUT.axisLabelGap);
  });

  it('labels every slot for a zero-width label', () => {
    expect(axisLabelStride(22, 0)).toBe(1);
  });

  it('survives a zero-width slot', () => {
    expect(axisLabelStride(0, 40)).toBeGreaterThanOrEqual(1);
  });
});

describe('clampLabelCenter', () => {
  it('leaves a centre that fits alone', () => {
    expect(clampLabelCenter(100, 40, 300)).toBe(100);
  });

  it('pulls a label in from the right edge', () => {
    expect(clampLabelCenter(295, 40, 300)).toBe(280);
  });

  it('pulls a label in from the left edge', () => {
    expect(clampLabelCenter(5, 40, 300)).toBe(20);
  });
});
