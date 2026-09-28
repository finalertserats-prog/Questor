import type { Point } from './badgeGeometry.js';

/**
 * The hallmark's digits, drawn as strokes.
 *
 * The SVG badge and the certificate's seal set `Q·585` in a real font, because
 * both formats have a text layer and a reader can select it. A PNG has no text
 * layer at all, and this server carries no font outlines it could rasterise —
 * pdfkit ships metrics for the standard fourteen faces, not their glyphs, and
 * embedding a monospace font to draw six characters at a thirtieth of the
 * badge's height would put a megabyte on disk for a mark that is 30% opaque.
 *
 * So the hallmark is engraved rather than typeset: single-stroke paths of the
 * kind a rotary engraver actually cuts, which is a closer match to what the
 * mark is pretending to be than an outline font would have been.
 *
 * Only the characters the tier table actually uses are defined. That is not an
 * oversight waiting to bite — `strokeGlyphs.test.ts` walks every tier's
 * hallmark and fails if a character has no glyph, so a new tier with a `7` in
 * it turns red here rather than shipping a badge with a gap in the metal.
 */

/** Glyph space: x and y in cap heights, y=0 at the cap line, y=1 on the baseline. */
interface Glyph {
  readonly strokes?: readonly { readonly points: readonly Point[]; readonly closed: boolean }[];
  readonly discs?: readonly { readonly cx: number; readonly cy: number; readonly r: number }[];
}

const p = (x: number, y: number): Point => ({ x, y });

function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number, steps = 28): readonly Point[] {
  return Array.from({ length: steps + 1 }, (_unused, i) => {
    const angle = from + ((to - from) * i) / steps;
    return p(cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry);
  });
}

function ellipse(cx: number, cy: number, rx: number, ry: number): readonly Point[] {
  return arc(cx, cy, rx, ry, 0, Math.PI * 2 - Math.PI / 16, 30);
}

const CENTRE = 0.26;

const GLYPHS: Readonly<Record<string, Glyph>> = {
  '0': { strokes: [{ points: ellipse(CENTRE, 0.5, 0.24, 0.5), closed: true }] },
  '2': {
    strokes: [
      {
        points: [...arc(CENTRE, 0.26, 0.23, 0.26, 2.6, 6.8), p(0.05, 0.98), p(0.5, 0.98)],
        closed: false,
      },
    ],
  },
  '5': {
    strokes: [
      { points: [p(0.47, 0.03), p(0.11, 0.03), p(0.08, 0.4), ...arc(CENTRE, 0.69, 0.24, 0.3, 4.2, 8.18)], closed: false },
    ],
  },
  '8': {
    strokes: [
      { points: ellipse(CENTRE, 0.25, 0.19, 0.25), closed: true },
      { points: ellipse(CENTRE, 0.72, 0.235, 0.28), closed: true },
    ],
  },
  '9': {
    strokes: [
      { points: ellipse(CENTRE, 0.29, 0.215, 0.29), closed: true },
      { points: [p(0.475, 0.3), ...arc(CENTRE, 0.7, 0.21, 0.28, 0, 1.75)], closed: false },
    ],
  },
  Q: {
    strokes: [
      { points: ellipse(CENTRE, 0.48, 0.23, 0.48), closed: true },
      { points: [p(0.3, 0.7), p(0.5, 1.02)], closed: false },
    ],
  },
  '·': { discs: [{ cx: CENTRE, cy: 0.6, r: 0.085 }] },
};

export function hasGlyph(character: string): boolean {
  return Object.prototype.hasOwnProperty.call(GLYPHS, character);
}

export type GlyphRun =
  | { readonly kind: 'stroke'; readonly points: readonly Point[]; readonly closed: boolean; readonly width: number }
  | { readonly kind: 'fill'; readonly points: readonly Point[] };

/** IBM Plex Mono's advance and cap height, so the engraving sits where the SVG's text does. */
const ADVANCE = 0.6;
const CAP_HEIGHT = 0.7;
const GLYPH_WIDTH = 0.52;
const STROKE_WIDTH = 0.13;

export interface TextShape {
  readonly at: Point;
  readonly text: string;
  readonly size: number;
  readonly tracking: number;
}

/**
 * One centred run of hallmark text, as paths in the badge's 0–100 space.
 *
 * Centred on `at.x` over the whole run and sitting on `at.y` as a baseline,
 * matching `text-anchor="middle"` in the SVG so the two renderings put the
 * mark in the same place.
 */
export function hallmarkGlyphs(shape: TextShape): readonly GlyphRun[] {
  const characters = [...shape.text];
  if (!characters.length) return [];
  const cap = CAP_HEIGHT * shape.size;
  const advance = ADVANCE * shape.size;
  const total = characters.length * advance + (characters.length - 1) * shape.tracking;
  const left = shape.at.x - total / 2;
  const sidebearing = (ADVANCE - GLYPH_WIDTH * CAP_HEIGHT) * shape.size / 2;
  const top = shape.at.y - cap;

  const runs: GlyphRun[] = [];
  characters.forEach((character, index) => {
    const glyph = GLYPHS[character];
    if (!glyph) return;
    const originX = left + index * (advance + shape.tracking) + sidebearing;
    const place = (point: Point): Point => ({ x: originX + point.x * cap, y: top + point.y * cap });
    for (const stroke of glyph.strokes ?? []) {
      runs.push({ kind: 'stroke', points: stroke.points.map(place), closed: stroke.closed, width: STROKE_WIDTH * cap });
    }
    for (const disc of glyph.discs ?? []) {
      const centre = place(p(disc.cx, disc.cy));
      runs.push({
        kind: 'fill',
        points: Array.from({ length: 12 }, (_unused, k) => {
          const angle = (k / 12) * Math.PI * 2;
          return { x: centre.x + Math.cos(angle) * disc.r * cap, y: centre.y + Math.sin(angle) * disc.r * cap };
        }),
      });
    }
  });
  return runs;
}
