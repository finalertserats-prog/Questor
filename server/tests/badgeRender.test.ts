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

  it('drops the milled edge and the guilloché field at row sizes', () => {
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
