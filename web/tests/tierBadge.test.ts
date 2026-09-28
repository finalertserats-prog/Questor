import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TierBadge } from '../src/components/TierBadge';
import { TIER_KEYS, TIER_METAL, octagonPath, rosettePath, signalBars, DETAIL_FROM_PX } from '../src/components/tierBadgeGeometry';

/**
 * The Milled Planchet. The badge has to read the same at 20px in a table row
 * and at 118px beside a certificate seal, and the thing that makes it readable
 * is the four bars: a Bronze showing one bar on bare metal claims "one", and a
 * Bronze showing one struck bar among four engraved ones claims "one of four".
 * Those are different statements and the difference has been lost once.
 */

const render = (props: Parameters<typeof TierBadge>[0]) => renderToStaticMarkup(createElement(TierBadge, props));

/** Every size the app actually uses, plus the certificate's. */
const APP_SIZES = [20, 24, 30, 36];

describe('the four signal bars', () => {
  // Diamond is a cut stone and carries no bars; the other three always carry four.
  it.each(['bronze', 'silver', 'gold'] as const)('draws four bars on %s, whatever is struck', (tier) => {
    expect(render({ tier, size: 36 }).match(/data-tier-bar="/g)).toHaveLength(4);
  });

  it.each([['bronze', 1], ['silver', 2], ['gold', 3]] as const)('strikes %s bright on %i bar(s)', (tier, struck) => {
    const html = render({ tier, size: 36 });
    expect(html.match(/data-tier-bar="struck"/g)).toHaveLength(struck);
    expect(html.match(/data-tier-bar="engraved"/g)).toHaveLength(4 - struck);
  });

  // The failure this pins: the unearned bars were once faint enough to vanish,
  // and Bronze read as a one-bar badge rather than as one of four.
  it.each(APP_SIZES)('keeps the engraved bars clearly visible at %ipx', (size) => {
    const html = render({ tier: 'bronze', size });
    const engraved = html.split('data-tier-bar="engraved"').slice(1);
    expect(engraved).toHaveLength(3);
    for (const bar of engraved) {
      expect(bar).toContain('stroke-width="1.1"');
      expect(bar).toContain('opacity="0.45"');
    }
  });

  it('thins the engraved outline only once the badge is big enough to carry detail', () => {
    expect(render({ tier: 'bronze', size: DETAIL_FROM_PX })).toContain('stroke-width="0.9"');
  });
});

describe('what is engraved only on a large badge', () => {
  it.each(APP_SIZES)('leaves the hallmark off at %ipx, where it would muddy the metal', (size) => {
    expect(render({ tier: 'gold', size })).not.toContain(TIER_METAL.gold.hallmark);
  });

  it('engraves the hallmark from 56px', () => {
    expect(render({ tier: 'gold', size: DETAIL_FROM_PX })).toContain(TIER_METAL.gold.hallmark);
  });

  it.each(['bronze', 'silver', 'gold'] as const)('gives %s its own hallmark', (tier) => {
    expect(render({ tier, size: 118 })).toContain(TIER_METAL[tier].hallmark);
  });

  it('gives Diamond no hallmark, because it is not a struck alloy', () => {
    expect(TIER_METAL.diamond.hallmark).toBe('');
    expect(render({ tier: 'diamond', size: 118 })).not.toContain('Q·');
  });

  it('leaves the guilloché off a row-sized badge and cuts it on a large one', () => {
    const field = rosettePath(26, 5, 16, 5, 50, 50, 1).slice(0, 40);
    expect(render({ tier: 'silver', size: 36 })).not.toContain(field);
    expect(render({ tier: 'silver', size: 118 })).toContain(field);
  });

  /**
   * The knurled rim is gone, at every size and on every tier.
   *
   * This test asserted the opposite until the owner cut the milling: 88 fine
   * radial ticks ringed the octagon, and against its own edge they read as a
   * second border competing with the first. Inverted rather than deleted,
   * because the silhouette carrying the mark alone is now a property worth
   * holding — and because a deleted test is indistinguishable from one that
   * never existed.
   *
   * Diamond is the control: it still draws `<line>` inside its crystal, so a
   * change that stopped emitting lines altogether would fail here rather than
   * pass quietly. That is the half a bare `not.toContain` cannot give.
   */
  it('rings no tier with a milled edge, at any size', () => {
    const milled = (tier: 'bronze' | 'silver' | 'gold', size: number) =>
      (render({ tier, size }).match(/<line /g) ?? []).length;

    expect([milled('gold', 118), milled('gold', 36), milled('bronze', 118), milled('silver', 118)])
      .toEqual([0, 0, 0, 0]);
  });

  it('still draws the crystal facets on Diamond, which are the only lines left', () => {
    expect((render({ tier: 'diamond', size: 118 }).match(/<line /g) ?? []).length).toBeGreaterThan(0);
  });
});

/**
 * Parity with the approved generator in scratchpad/mockups/questor-credentials.html.
 *
 * The geometry was settled over six rounds with the owner, so the numbers here
 * are written out literally rather than read back from the module they are
 * checking — a constant that drifts would otherwise drift in both places at
 * once and the test would keep passing.
 */
describe('parity with the approved mockup, at the sizes the app uses', () => {
  // signal(): w 9.5, gap 3.8, base 69, maxH 38, heights x0.36 / 0.57 / 0.78 / 1.
  const BARS = [
    { x: '25.3', height: '13.68', y: '55.32' },
    { x: '38.6', height: '21.66', y: '47.34' },
    { x: '51.9', height: '29.64', y: '39.36' },
    { x: '65.2', height: '38', y: '31' },
  ];

  it.each(APP_SIZES)('places all four bars exactly where the mockup does, at %ipx', (size) => {
    const html = render({ tier: 'silver', size });
    for (const bar of BARS) {
      expect(html).toContain(`x="${bar.x}" y="${bar.y}" width="9.5" height="${bar.height}"`);
    }
  });

  it('recesses a struck bar and fills it bright, as the mockup strikes it', () => {
    const struck = render({ tier: 'bronze', size: 36 }).split('data-tier-bar="struck"')[1];
    expect(struck).toContain('opacity="0.3"');   // the recess
    expect(struck).toContain('opacity="0.97"');  // the bright inlay
    expect(struck).toContain('rx="0.7"');
  });

  it('recesses an engraved bar and outlines it, as the mockup engraves it', () => {
    const engraved = render({ tier: 'bronze', size: 36 }).split('data-tier-bar="engraved"')[1];
    expect(engraved).toContain('opacity="0.22"');
    expect(engraved).toContain('stroke-width="1.1"');
    expect(engraved).toContain('opacity="0.45"');
    expect(engraved).not.toContain('opacity="0.97"');
  });

  it('draws the rim edge at the weight the mockup uses below 56px', () => {
    expect(render({ tier: 'gold', size: 30 })).toContain('stroke-width="2.2" opacity="0.55"');
  });

  it('lays the metal down with the mockup’s five gradient stops', () => {
    const html = render({ tier: 'bronze', size: 24 });
    for (const [offset, colour] of [[0, '#6d3f24'], [34, '#c98d5e'], [52, '#ecb98f'], [70, '#a5663f'], [100, '#54301c']] as const) {
      expect(html).toContain(`offset="${offset}%" stop-color="${colour}"`);
    }
  });

  it('cuts Diamond’s stone at the mockup’s smaller-badge radius', () => {
    const html = render({ tier: 'diamond', size: 36 });
    expect(html).toContain(octagonPath(50, 35));
    expect(html).toContain('stroke-width="2.2" opacity="0.5"');
  });

  it.each(APP_SIZES)('draws nothing at %ipx that the mockup reserves for large badges', (size) => {
    const html = render({ tier: 'silver', size });
    expect(html).not.toContain('<line ');   // no crystal facets at app sizes
    expect(html).not.toContain('<text');    // no hallmark
    expect(html).not.toContain('clip-path'); // no guilloché field
  });
});

describe('the silhouette', () => {
  it.each(TIER_KEYS)('cuts %s from the same octagon', (tier) => {
    expect(render({ tier, size: 36 })).toContain(octagonPath(50, 47));
  });

  it.each(APP_SIZES)('renders at exactly the size asked for (%ipx)', (size) => {
    expect(render({ tier: 'silver', size })).toContain(`width="${size}" height="${size}"`);
  });

  it('keeps the viewBox fixed so every size is the same drawing', () => {
    expect(render({ tier: 'gold', size: 20 })).toContain('viewBox="0 0 100 100"');
  });

  it('gives Diamond its cut stone instead of bars', () => {
    const html = render({ tier: 'diamond', size: 36 });
    expect(html).not.toContain('data-tier-bar');
    expect(html).toContain(octagonPath(50, 35 * 0.46));
  });
});

describe('how the badge is announced', () => {
  // In a journey row the tier is already written beside the badge; announcing
  // "Silver badge" as well reads the word twice.
  it('is decorative unless it is asked to speak', () => {
    expect(render({ tier: 'silver', size: 24 })).toContain('aria-hidden="true"');
  });

  it('takes a label where it stands alone', () => {
    const html = render({ tier: 'silver', size: 118, label: 'Silver badge' });
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Silver badge"');
    expect(html).not.toContain('aria-hidden');
  });

  it('gives each badge on a page its own gradient, so they do not take the last one’s metal', () => {
    // One tree, as a real journey renders them: two separate renders each
    // restart React's id counter and would pass while the page still broke.
    const page = renderToStaticMarkup(createElement(
      'div', null,
      createElement(TierBadge, { tier: 'bronze', size: 24 }),
      createElement(TierBadge, { tier: 'gold', size: 24 }),
    ));
    const ids = [...page.matchAll(/id="(tier-metal-[^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('the geometry on its own', () => {
  it('rises the bars left to right', () => {
    const heights = signalBars(2, false).map((bar) => bar.height);
    expect([...heights].sort((a, b) => a - b)).toEqual(heights);
  });

  it('centres the bar group on the badge', () => {
    const bars = signalBars(4, false);
    const left = bars[0].x;
    const right = bars[3].x + bars[3].width;
    expect((left + right) / 2).toBeCloseTo(50, 5);
  });

  it('generates the guilloché rather than storing a drawn path', () => {
    // 801 sampled points: a rose-engine pattern that can be varied, not a
    // decoration someone drew once.
    expect(rosettePath(26, 5, 16, 5, 50, 50, 1).split('L')).toHaveLength(801);
  });

  it('closes the octagon on eight corners', () => {
    const path = octagonPath(50, 47);
    expect(path.endsWith('Z')).toBe(true);
    expect(path.replace('M', '').replace('Z', '').split('L')).toHaveLength(8);
  });
});
