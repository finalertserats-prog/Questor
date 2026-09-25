import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { badgeShapes, metalOf, TIERS, type Tier } from '../src/services/badgeGeometry.js';
import { badgeSvg } from '../src/services/badgeSvg.js';
import { rasterisePng } from '../src/services/rasterPng.js';
import { hasGlyph } from '../src/services/strokeGlyphs.js';

/**
 * The badge, drawn three ways from one set of shapes.
 *
 * The point of these is that the SVG, the PNG and the seal struck into the
 * certificate cannot drift apart: they are all fed by `badgeShapes`, and what
 * is asserted here is that the shape list really does carry the design's
 * distinguishing marks rather than each renderer inventing its own.
 */

function pngSize(png: Buffer): readonly [number, number] {
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

describe('badge geometry', () => {
  it('strikes one more bar for each tier', () => {
    expect(TIERS.map((tier) => metalOf(tier).bars)).toEqual([1, 2, 3, 4]);
  });

  it('keeps one silhouette across all four tiers', () => {
    // Every tier opens on the same octagon of radius 47. The owner's whole
    // point is that the badges differ in what is struck, not in their outline.
    const outlines = TIERS.map((tier) => {
      const first = badgeShapes(tier, 132)[0];
      return first.op === 'fill' ? first.subpaths[0].length : 0;
    });

    expect(outlines).toEqual([8, 8, 8, 8]);
  });

  it('engraves the hallmark only at display sizes', () => {
    const large = badgeShapes('gold', 132).some((shape) => shape.op === 'text');
    const small = badgeShapes('gold', 36).some((shape) => shape.op === 'text');

    expect([large, small]).toEqual([true, false]);
  });

  /**
   * Ids are document-wide, and an inlined badge shares a document with
   * whatever else is on the page.
   *
   * Every badge used to declare `qg0`. As a standalone .svg that is safe, and
   * it is the only way this renderer is consumed today — but paste four tiers
   * into one page and every `url(#qg0)` resolves to whichever came first, so
   * three of them silently wear the first one's metal. Valid SVG, no error,
   * wrong badge. That is exactly what happened the first time all four were
   * shown together.
   *
   * Asserted across tiers rather than within one badge, because within one
   * badge the ids were always distinct — the collision only exists between
   * two renders, which is the case no single-badge test could see.
   */
  it('gives two tiers gradient ids that cannot collide in one document', () => {
    const idsOf = (svg: string): string[] => [...svg.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const all = TIERS.flatMap((tier) => idsOf(badgeSvg(tier, 360)));

    expect([all.length > 0, new Set(all).size]).toEqual([true, all.length]);
  });

  /**
   * The id is derived from tier and size, not randomised: `badgeSize` snaps
   * `?size=` to six values so one badge is one fixed asset, and two requests
   * for it must answer with the same bytes.
   */
  /**
   * The guilloché is held inside the octagon, ink and all.
   *
   * Nothing pinned this: removing the clip left every test green, and the
   * only record that it worked was a number in a commit message. Asserted on
   * the PAINTED extent rather than the centreline, because containing the
   * centreline and calling it parity is the same defect one layer down — the
   * browser clips the stroke, so half a stroke still outside is still a
   * different drawing.
   */
  it('keeps the guilloché inside the octagon, including the width it is painted at', () => {
    const inradius = 40 * Math.cos(Math.PI / 8);
    const facet = Math.PI / 4;
    const worstOverhang = (shapes: readonly ReturnType<typeof badgeShapes>[number][]): number => {
      let worst = -Infinity;
      for (const shape of shapes) {
        if (shape.op !== 'stroke' || shape.closed) continue;
        for (const points of shape.subpaths) {
          if (points.length < 100) continue; // the rosettes; not the two-point ticks or bars
          for (const p of points) {
            const dx = p.x - 50;
            const dy = p.y - 50;
            const angle = Math.atan2(dy, dx);
            const offset = ((angle % facet) + facet * 1.5) % facet - facet / 2;
            const limit = inradius / Math.cos(offset);
            worst = Math.max(worst, Math.hypot(dx, dy) + shape.width / 2 - limit);
          }
        }
      }
      return worst;
    };

    const overhang = worstOverhang(badgeShapes('gold', 132));

    expect([overhang > -Infinity, overhang <= 0]).toEqual([true, true]);
  });

  /**
   * Size is half the id, and nothing tested it.
   *
   * Diamond's crystal gradient is resolved against a radius of 33 at 56px and
   * above and 35 below it, so the same shape index at two sizes is genuinely
   * two different gradients. Drop the size from the prefix and every other
   * test here still passes while those two collide under one id.
   */
  it('gives one tier different gradient ids at different sizes', () => {
    const idsOf = (svg: string): string[] => [...svg.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const small = idsOf(badgeSvg('diamond', 32));
    const large = idsOf(badgeSvg('diamond', 512));

    expect([small.length > 0, small.some((id) => large.includes(id))]).toEqual([true, false]);
  });

  it('answers the same bytes for the same tier and size', () => {
    expect(badgeSvg('gold', 360)).toBe(badgeSvg('gold', 360));
  });

  it('drops the guilloché field and the hallmark at row sizes', () => {
    // Below 56px they collapse into a grey smear that makes Silver and Gold
    // hard to tell apart, which is the one thing the badge exists to do.
    expect(badgeShapes('silver', 24).length).toBeLessThan(badgeShapes('silver', 132).length);
  });

  it('draws the unearned bars rather than omitting them', () => {
    // Four bars on Bronze as on Diamond: an outline at 45% and a fill at 22%
    // for the three not yet struck.
    const bronze = badgeShapes('bronze', 132)
      .filter((shape) => shape.op === 'stroke' && shape.alpha === 0.45 && shape.colour === metalOf('bronze').light);

    expect(bronze).toHaveLength(3);
  });

  it('gives Diamond a cut stone instead of bars', () => {
    const diamond = badgeShapes('diamond', 132);
    const facets = diamond.filter((shape) => shape.op === 'fill' && shape.subpaths[0].length === 3);

    expect(facets).toHaveLength(8);
  });
});

describe('the engraved hallmark', () => {
  it('has a glyph for every character any tier asks for', () => {
    // The stroke font carries only the characters the tier table uses. A new
    // tier with a 7 in its hallmark must fail here rather than ship a badge
    // with a gap in the metal.
    const missing = TIERS.flatMap((tier) => [...metalOf(tier).hallmark]).filter((character) => !hasGlyph(character));

    expect(missing).toEqual([]);
  });
});

describe('badgeSvg', () => {
  it.each(TIERS)('answers vector markup for %s', (tier: Tier) => {
    const svg = badgeSvg(tier, 132);

    expect([svg.startsWith('<svg'), svg.includes('viewBox="0 0 100 100"'), svg.includes('<path')]).toEqual([true, true, true]);
  });

  it('labels itself for a screen reader', () => {
    expect(badgeSvg('gold', 132)).toContain('aria-label="Gold badge"');
  });

  it('sets the hallmark as real text, which an SVG can carry', () => {
    expect(badgeSvg('gold', 132)).toContain('>Q·999<');
  });

  it('resolves the metal gradient into user space so the stops cannot be re-mapped', () => {
    expect(badgeSvg('silver', 132)).toContain('gradientUnits="userSpaceOnUse"');
  });
});

describe('rasterisePng', () => {
  it('writes a real PNG at the size asked for', () => {
    const png = rasterisePng(badgeShapes('silver', 128), 128);

    expect([png.subarray(1, 4).toString('latin1'), ...pngSize(png)]).toEqual(['PNG', 128, 128]);
  });

  it('clamps a size that would be a denial of service', () => {
    expect(pngSize(rasterisePng(badgeShapes('gold', 4096), 4096))).toEqual([1024, 1024]);
  });

  it('leaves the ground transparent rather than white', () => {
    // A white square behind the badge is exactly what people complain about
    // when it lands in a slide or a dark-mode page. The top-left corner sits
    // outside the octagon, so it must still be fully transparent.
    const png = rasterisePng(badgeShapes('bronze', 64), 64);

    expect(png.length).toBeGreaterThan(0);
    expect(alphaAt(png)).toBe(0);
  });

  it('renders the same bytes twice, which is what makes it safe to cache', () => {
    // A badge carries no candidate in it: every Silver at 512px is the same
    // file, whoever it was exported for. `badgePng` relies on that.
    expect(rasterisePng(badgeShapes('gold', 96), 96).equals(rasterisePng(badgeShapes('gold', 96), 96))).toBe(true);
  });

  it('puts different metal in the same place for two tiers', () => {
    // Same silhouette, different colour: two tiers must not produce identical
    // bytes, or the renderer is ignoring the metal table.
    const silver = rasterisePng(badgeShapes('silver', 96), 96);
    const gold = rasterisePng(badgeShapes('gold', 96), 96);

    expect(silver.equals(gold)).toBe(false);
  });
});

/**
 * The alpha of the top-left pixel, decoded back out of the file.
 *
 * Reading it from the encoder's input would test nothing about the encoder;
 * this goes through zlib the way a viewer does.
 */
function alphaAt(png: Buffer): number {
  let at = 8;
  let data = Buffer.alloc(0);
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('latin1');
    if (type === 'IDAT') data = Buffer.concat([data, png.subarray(at + 8, at + 8 + length)]);
    at += length + 12;
  }
  // Row 0: one filter byte, then RGBA for the first pixel.
  return inflateSync(data)[4];
}
