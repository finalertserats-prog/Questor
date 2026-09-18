import { describe, it, expect } from 'vitest';
import {
  BAR_LAYOUT,
  axisLabelStride,
  clampLabelCenter,
  estimateTextWidth,
  horizontalBarLayout,
  truncateToWidth,
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

describe('horizontalBarLayout', () => {
  const values = [3, 12];

  it('sizes the label column from the longest label when labels are short', () => {
    const layout = horizontalBarLayout(['QA', 'Design'], values, 480, measure, measure);
    expect(layout.labelW).toBe(measure('Design') + BAR_LAYOUT.labelGap);
  });

  it('keeps short labels whole', () => {
    const layout = horizontalBarLayout(['QA', 'Design'], values, 480, measure, measure);
    expect(layout.labels).toEqual(['QA', 'Design']);
  });

  it('caps the label column at 40% of the width for long labels', () => {
    const long = 'Senior Backend Engineer (Payments) · Senior · IN';
    const layout = horizontalBarLayout([long, 'QA'], values, 400, measure, measure);
    expect(layout.labelW).toBeLessThanOrEqual(160);
  });

  it('truncates a long label to fit its column', () => {
    const long = 'Senior Backend Engineer (Payments) · Senior · IN';
    const layout = horizontalBarLayout([long, 'QA'], values, 400, measure, measure);
    expect(measure(layout.labels[0])).toBeLessThanOrEqual(layout.labelW - BAR_LAYOUT.labelGap);
  });

  it('keeps the widest value text inside the svg width', () => {
    const layout = horizontalBarLayout(['A long role title for a narrow card', 'B'], [1234, 5], 400, measure, measure);
    const valueRight = layout.labelW + layout.plotW + BAR_LAYOUT.valueGap + measure('1234');
    expect(valueRight).toBeLessThanOrEqual(400);
  });

  it('keeps the value text inside a narrow phone-width chart', () => {
    const layout = horizontalBarLayout(['Senior Backend Engineer', 'QA'], [987, 5], 120, measure, measure);
    const valueRight = layout.labelW + layout.plotW + BAR_LAYOUT.valueGap + measure('987');
    expect(valueRight).toBeLessThanOrEqual(120);
  });

  it('never gives the plot a negative width when the chart is tiny', () => {
    const layout = horizontalBarLayout(['Senior Backend Engineer'], [987654], 40, measure, measure);
    expect(layout.plotW).toBeGreaterThanOrEqual(0);
  });

  it('handles an empty list', () => {
    expect(horizontalBarLayout([], [], 300, measure, measure).labels).toEqual([]);
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
