/**
 * The Milled Planchet, as geometry rather than as a picture.
 *
 * The approved design (scratchpad/mockups/questor-credentials.html) draws the
 * badge once, in SVG, in the browser. Questor has to draw the same badge three
 * more times: as an `.svg` file, as a `.png` file, and struck into the
 * certificate PDF beside the signatures. Three hand-written copies of an
 * octagon, a milled edge, a guilloché field and four bars would drift apart on
 * the first tweak — and the way that drift surfaces is a candidate holding a
 * PNG that does not match the PDF of the same award.
 *
 * So the geometry lives here once, as a flat list of filled and stroked
 * polygons in the mockup's own 0–100 space, and each renderer only has to know
 * how to draw a polygon. Curves are already polylines in the mockup (the
 * rosettes are sampled at 800 points), so nothing is lost by refusing to model
 * Béziers.
 *
 * Numbers below are transcribed from the mockup's `METAL`, `oct`, `rosette`,
 * `signal` and `crystal` functions and are deliberately not "tidied" — the
 * owner iterated on them six times and a rounder number is a different badge.
 */

export const TIERS = ['bronze', 'silver', 'gold', 'diamond'] as const;
export type Tier = (typeof TIERS)[number];

export function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

/** The hallmark is engraved only at 56px and above; below that it muddies the metal. */
export const HALLMARK_MIN_SIZE = 56;

interface Metal {
  /** Five stops of the planchet's rolled-metal gradient. */
  readonly gradient: readonly [string, string, string, string, string];
  readonly dark: string;
  readonly light: string;
  /** How many of the four bars are struck bright. */
  readonly bars: number;
  readonly hallmark: string;
}

const METAL: Readonly<Record<Tier, Metal>> = {
  bronze: { gradient: ['#6d3f24', '#c98d5e', '#ecb98f', '#a5663f', '#54301c'], dark: '#3a2011', light: '#f7e6d8', bars: 1, hallmark: 'Q·585' },
  silver: { gradient: ['#5b636e', '#ccd3da', '#f4f7f9', '#949ca7', '#464d57'], dark: '#2f353e', light: '#f7fafc', bars: 2, hallmark: 'Q·925' },
  gold: { gradient: ['#7a5a12', '#eccd79', '#fdf0c0', '#b68c22', '#63490c'], dark: '#463306', light: '#fef6dd', bars: 3, hallmark: 'Q·999' },
  diamond: { gradient: ['#5b86a6', '#cfe6f2', '#ffffff', '#8fb6d0', '#325067'], dark: '#20394b', light: '#ffffff', bars: 4, hallmark: '' },
};

export function metalOf(tier: Tier): Metal {
  return METAL[tier];
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type Paint =
  | { readonly kind: 'solid'; readonly colour: string; readonly alpha: number }
  | {
      readonly kind: 'linear';
      /** Absolute, in the 0–100 space — already resolved from the shape's own box. */
      readonly from: Point;
      readonly to: Point;
      readonly stops: readonly { readonly at: number; readonly colour: string }[];
      readonly alpha: number;
    };

export type Shape =
  | { readonly op: 'fill'; readonly subpaths: readonly (readonly Point[])[]; readonly paint: Paint }
  | {
      readonly op: 'stroke';
      readonly subpaths: readonly (readonly Point[])[];
      readonly closed: boolean;
      readonly colour: string;
      readonly alpha: number;
      readonly width: number;
    }
  | {
      readonly op: 'text';
      readonly at: Point;
      readonly text: string;
      readonly size: number;
      readonly tracking: number;
      readonly colour: string;
      readonly alpha: number;
    };

/** The planchet's silhouette: a regular octagon with a vertex at the top-right. */
export function octagon(centre: number, radius: number): readonly Point[] {
  return Array.from({ length: 8 }, (_unused, i) => {
    const angle = (i / 8) * Math.PI * 2 - Math.PI / 8;
    return { x: centre + Math.cos(angle) * radius, y: centre + Math.sin(angle) * radius };
  });
}

/**
 * A hypotrochoid — the curve an engine-turning lathe cuts, and the reason the
 * guilloché field reads as struck metal rather than as printed decoration.
 *
 * Sampled at 800 points exactly as the mockup samples it. Fewer points would
 * be cheaper and would show as flat spots on the tightest lobes at export
 * sizes, which is where this ornament is looked at closely.
 */
export function rosette(
  outer: number,
  inner: number,
  offset: number,
  turns: number,
  cx: number,
  cy: number,
  scale: number,
): readonly Point[] {
  const ratio = (outer - inner) / inner;
  return Array.from({ length: 801 }, (_unused, i) => {
    const q = (i / 800) * Math.PI * 2 * turns;
    return {
      x: cx + ((outer - inner) * Math.cos(q) + offset * Math.cos(ratio * q)) * scale,
      y: cy + ((outer - inner) * Math.sin(q) - offset * Math.sin(ratio * q)) * scale,
    };
  });
}

/**
 * A rounded rectangle as a polygon.
 *
 * Tessellated rather than kept as arcs so that every shape in this file is a
 * polygon and each renderer needs one drawing primitive instead of three. At
 * four segments a corner the straightest edge of the approximation is under a
 * fiftieth of a unit off the true arc — well below a pixel at any size this
 * badge is exported at.
 */
export function roundedRect(x: number, y: number, width: number, height: number, radius: number): readonly Point[] {
  const r = Math.min(radius, width / 2, height / 2);
  if (r <= 0) {
    return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
  }
  const corners: readonly { readonly cx: number; readonly cy: number; readonly start: number }[] = [
    { cx: x + width - r, cy: y + r, start: -Math.PI / 2 },
    { cx: x + width - r, cy: y + height - r, start: 0 },
    { cx: x + r, cy: y + height - r, start: Math.PI / 2 },
    { cx: x + r, cy: y + r, start: Math.PI },
  ];
  const points: Point[] = [];
  for (const corner of corners) {
    for (let step = 0; step <= 4; step += 1) {
      const angle = corner.start + (step / 4) * (Math.PI / 2);
      points.push({ x: corner.cx + Math.cos(angle) * r, y: corner.cy + Math.sin(angle) * r });
    }
  }
  return points;
}

function boxOf(points: readonly Point[]): { readonly x: number; readonly y: number; readonly w: number; readonly h: number } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * The rolled-metal gradient, resolved against one shape's own bounding box.
 *
 * The mockup declares it once in SVG object-bounding-box units and lets every
 * element that references it re-map the stops to its own extent — which is why
 * the Diamond crystal is lit from the same angle as the planchet it sits on
 * despite being far smaller. Resolving to absolute coordinates here keeps that
 * behaviour in renderers with no notion of a bounding box.
 */
function metalGradient(points: readonly Point[], tier: Tier, alpha: number): Paint {
  const box = boxOf(points);
  const { gradient } = METAL[tier];
  return {
    kind: 'linear',
    from: { x: box.x + 0.1 * box.w, y: box.y },
    to: { x: box.x + 0.9 * box.w, y: box.y + box.h },
    stops: [
      { at: 0, colour: gradient[0] },
      { at: 0.34, colour: gradient[1] },
      { at: 0.52, colour: gradient[2] },
      { at: 0.7, colour: gradient[3] },
      { at: 1, colour: gradient[4] },
    ],
    alpha,
  };
}

const solid = (colour: string, alpha: number): Paint => ({ kind: 'solid', colour, alpha });

function fill(points: readonly Point[], paint: Paint): Shape {
  return { op: 'fill', subpaths: [points], paint };
}

function stroke(points: readonly Point[], colour: string, alpha: number, width: number, closed: boolean): Shape {
  return { op: 'stroke', subpaths: [points], closed, colour, alpha, width };
}

/** The knurled rim. Radial ticks, not a texture: it survives being printed. */
function milledEdge(count: number, outer: number, inner: number, colour: string, width: number): readonly Shape[] {
  return Array.from({ length: count }, (_unused, i) => {
    const angle = (i / count) * Math.PI * 2;
    return stroke(
      [
        { x: 50 + Math.cos(angle) * outer, y: 50 + Math.sin(angle) * outer },
        { x: 50 + Math.cos(angle) * inner, y: 50 + Math.sin(angle) * inner },
      ],
      colour,
      0.3,
      width,
      false,
    );
  });
}

/**
 * Four bars, of which the earned ones are struck bright.
 *
 * The unearned bars are engraved rather than omitted — outlined at 45% and
 * filled at 22% — because a badge that simply drops them reads as a different
 * shape per tier, and the owner's whole point is one silhouette across all
 * four.
 */
function signalBars(tier: Tier, big: boolean): readonly Shape[] {
  const metal = METAL[tier];
  const width = big ? 8.5 : 9.5;
  const gap = big ? 4.5 : 3.8;
  const base = 69;
  const maxHeight = 38;
  const heights = [maxHeight * 0.36, maxHeight * 0.57, maxHeight * 0.78, maxHeight];
  const x0 = 50 - (4 * width + 3 * gap) / 2;
  const inset = big ? 0.9 : 1;

  const shapes: Shape[] = [];
  heights.forEach((height, i) => {
    const x = x0 + i * (width + gap);
    const y = base - height;
    const struck = i < metal.bars;
    shapes.push(fill(roundedRect(x, y, width, height, 1), solid(metal.dark, struck ? 0.3 : 0.22)));
    if (!struck) {
      shapes.push(stroke(roundedRect(x, y, width, height, 1), metal.light, 0.45, big ? 0.9 : 1.1, true));
      return;
    }
    shapes.push(fill(roundedRect(x + inset, y + inset, width - inset * 2, height - inset * 2, 0.7), solid(metal.light, 0.97)));
    if (big) {
      // The bar's shaded left flank. Only at display sizes: at 20px it is a
      // third of a pixel and turns the whole bar muddy.
      shapes.push(fill(roundedRect(x + 0.9, y + 0.9, (width - 1.8) * 0.32, height - 1.8, 0), solid(metal.dark, 0.16)));
    }
  });
  return shapes;
}

/** Diamond's cut stone: eight facets around a raised table. */
function crystal(tier: Tier, big: boolean, radius: number): readonly Shape[] {
  const metal = METAL[tier];
  const table = radius * 0.46;
  const at = (angle: number, r: number): Point => ({ x: 50 + Math.cos(angle) * r, y: 50 + Math.sin(angle) * r });

  const shapes: Shape[] = [fill(octagon(50, radius), metalGradient(octagon(50, radius), tier, 0.96))];
  for (let i = 0; i < 8; i += 1) {
    const a1 = (i / 8) * Math.PI * 2 - Math.PI / 8;
    const a2 = ((i + 1) / 8) * Math.PI * 2 - Math.PI / 8;
    const mid = (a1 + a2) / 2;
    shapes.push(
      fill([at(a1, radius), at(a2, radius), at(mid, table)], i % 2 ? solid('#ffffff', 0.3) : solid(metal.dark, 0.16)),
    );
    shapes.push(stroke([at(a1, radius), at(a1, table)], '#ffffff', 0.5, big ? 0.8 : 1.2, false));
  }
  shapes.push(fill(octagon(50, table), solid('#ffffff', 0.72)));
  shapes.push(stroke(octagon(50, table), metal.dark, 0.4, big ? 0.7 : 1, true));
  if (big) {
    shapes.push(stroke([{ x: 50 - radius * 0.3, y: 50 }, { x: 50 + radius * 0.3, y: 50 }], '#ffffff', 0.85, 1.1, false));
    shapes.push(stroke([{ x: 50, y: 50 - radius * 0.3 }, { x: 50, y: 50 + radius * 0.3 }], '#ffffff', 0.85, 1.1, false));
  }
  shapes.push(stroke(octagon(50, radius), metal.dark, 0.55, big ? 1 : 1.6, true));
  return shapes;
}

/**
 * The badge for one tier, at the level of detail its size can carry.
 *
 * `size` decides detail and nothing else — the shapes are always in 0–100
 * space and the renderer scales them. Below 56px the milled edge, the
 * guilloché field and the hallmark are dropped: at row sizes they collapse
 * into a grey smear that makes Silver and Gold hard to tell apart, which is
 * the one thing the badge exists to do.
 */
export function badgeShapes(tier: Tier, size: number): readonly Shape[] {
  const metal = METAL[tier];
  const big = size >= HALLMARK_MIN_SIZE;
  const rim = octagon(50, 47);

  if (tier === 'diamond') {
    const shapes: Shape[] = [
      fill(rim, metalGradient(rim, tier, 0.34)),
      stroke(rim, metal.dark, 0.5, big ? 1.2 : 2.2, true),
    ];
    if (big) shapes.push(...milledEdge(72, 46, 42, metal.dark, 0.5));
    shapes.push(...crystal(tier, big, big ? 33 : 35));
    return shapes;
  }

  const shapes: Shape[] = [fill(rim, metalGradient(rim, tier, 1))];
  if (big) {
    shapes.push(...milledEdge(88, 46.5, 42.5, metal.dark, 0.55));
    shapes.push(stroke(octagon(50, 41), metal.dark, 0.45, 0.7, true));
    // The mockup clips these to an octagon of radius 40. They reach 37 from
    // centre against an inradius of 36.95, so the clip removes five hundredths
    // of a unit on four flats — under a third of a pixel at any export size.
    // Carrying a clipping path through three renderers to hide that would cost
    // far more than it buys.
    shapes.push(stroke(rosette(26, 5, 16, 5, 50, 50, 1), metal.dark, 0.24, 0.38, false));
    shapes.push(stroke(rosette(19, 4, 12, 4, 50, 50, 1), metal.dark, 0.18, 0.38, false));
  }
  shapes.push(stroke(rim, metal.dark, 0.55, big ? 1.1 : 2.2, true));
  shapes.push(...signalBars(tier, big));
  if (big && metal.hallmark) {
    shapes.push({ op: 'text', at: { x: 50, y: 80 }, text: metal.hallmark, size: 5.4, tracking: 0.9, colour: metal.dark, alpha: 0.3 });
  }
  return shapes;
}

/** What a reader or a screen reader is told the badge is. */
export function badgeLabel(tier: Tier): string {
  return `${tier.charAt(0).toUpperCase()}${tier.slice(1)} badge`;
}
