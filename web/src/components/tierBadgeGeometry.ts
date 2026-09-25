/**
 * The Milled Planchet: the geometry behind the tier badge.
 *
 * A direct port of the approved mockup's generator
 * (scratchpad/mockups/questor-credentials.html). The numbers are copied rather
 * than re-derived on purpose — the badge is a piece of struck metal with a
 * silhouette that has to read identically at 20px in a table row and at 118px
 * beside a certificate seal, and a redrawn octagon or a re-tuned bar height is
 * a different coin.
 *
 * React-free so it can be read and tested on its own, which is how the bar
 * count — the badge's actual meaning — is pinned.
 */

export const TIER_KEYS = ['bronze', 'silver', 'gold', 'diamond'] as const;
export type TierKey = (typeof TIER_KEYS)[number];

export interface TierMetal {
  /** Five gradient stops, dark rim through highlight and back. */
  readonly gradient: readonly [string, string, string, string, string];
  readonly dark: string;
  readonly light: string;
  /** How many of the four signal bars are struck bright. */
  readonly struckBars: number;
  /** The hallmark engraved at 56px and above. Diamond carries none. */
  readonly hallmark: string;
}

export const TIER_METAL: Readonly<Record<TierKey, TierMetal>> = {
  bronze: { gradient: ['#6d3f24', '#c98d5e', '#ecb98f', '#a5663f', '#54301c'], dark: '#3a2011', light: '#f7e6d8', struckBars: 1, hallmark: 'Q·585' },
  silver: { gradient: ['#5b636e', '#ccd3da', '#f4f7f9', '#949ca7', '#464d57'], dark: '#2f353e', light: '#f7fafc', struckBars: 2, hallmark: 'Q·925' },
  gold: { gradient: ['#7a5a12', '#eccd79', '#fdf0c0', '#b68c22', '#63490c'], dark: '#463306', light: '#fef6dd', struckBars: 3, hallmark: 'Q·999' },
  diamond: { gradient: ['#5b86a6', '#cfe6f2', '#ffffff', '#8fb6d0', '#325067'], dark: '#20394b', light: '#ffffff', struckBars: 4, hallmark: '' },
};

/**
 * Below this the guilloché and the hallmark are left off: at 36px and under
 * they muddy the metal into a grey smudge rather than reading as detail.
 */
export const DETAIL_FROM_PX = 56;

export const GRADIENT_STOPS: readonly (readonly [number, number])[] = [[0, 0], [34, 1], [52, 2], [70, 3], [100, 4]];

/** A regular octagon, point-up-left as the mockup orients it. */
export function octagonPath(centre: number, radius: number): string {
  const points: string[] = [];
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2 - Math.PI / 8;
    points.push(`${(centre + Math.cos(angle) * radius).toFixed(2)},${(centre + Math.sin(angle) * radius).toFixed(2)}`);
  }
  return `M${points.join('L')}Z`;
}

/**
 * The guilloché field: an epitrochoid, traced point by point rather than
 * hand-authored, which is what makes it a rose-engine pattern instead of a
 * decoration someone drew once and cannot vary.
 */
export function rosettePath(
  outerRadius: number, wheelRadius: number, penOffset: number, turns: number,
  cx: number, cy: number, scale: number,
): string {
  const points: string[] = [];
  const steps = 800;
  const ratio = (outerRadius - wheelRadius) / wheelRadius;
  for (let i = 0; i <= steps; i++) {
    const q = (i / steps) * Math.PI * 2 * turns;
    const x = cx + ((outerRadius - wheelRadius) * Math.cos(q) + penOffset * Math.cos(ratio * q)) * scale;
    const y = cy + ((outerRadius - wheelRadius) * Math.sin(q) - penOffset * Math.sin(ratio * q)) * scale;
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return `M${points.join('L')}`;
}

/** The two rose-engine passes inside the field, outermost first. */
export const ROSETTES: readonly (readonly [number, number, number, number])[] = [[26, 5, 16, 5], [19, 4, 12, 4]];

export interface SignalBar {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly struck: boolean;
}

/**
 * Four bars, rising left to right, of which the tier's are struck bright.
 *
 * Always four. The unearned ones are engraved rather than omitted, and they
 * are drawn with an outline at nearly half opacity because at one point they
 * were faint enough to vanish: Bronze then read as a one-bar badge rather than
 * as one of four, which is the opposite of what the mark is for.
 */
/**
 * Two decimals, as the octagon and the guilloché already use.
 *
 * `38 * 0.57` is 21.659999999999997 in binary floating point, and written
 * straight into an attribute that is what the exported badge.svg carries. The
 * viewBox is 100 units wide and the badge is drawn at 20-36px, so the
 * difference is some 10^-9 of a pixel — this rounds the spelling, not the
 * geometry.
 */
const twoPlaces = (value: number) => Math.round(value * 100) / 100;

export function signalBars(struckCount: number, detailed: boolean): SignalBar[] {
  const width = detailed ? 8.5 : 9.5;
  const gap = detailed ? 4.5 : 3.8;
  const base = 69;
  const maxHeight = 38;
  const heights = [maxHeight * 0.36, maxHeight * 0.57, maxHeight * 0.78, maxHeight];
  const total = 4 * width + 3 * gap;
  const x0 = 50 - total / 2;
  return heights.map((height, i) => ({
    x: twoPlaces(x0 + i * (width + gap)),
    y: twoPlaces(base - height),
    width,
    height: twoPlaces(height),
    struck: i < struckCount,
  }));
}

export interface CrystalFacet {
  readonly path: string;
  readonly lit: boolean;
  /** The spoke from the facet's leading corner in to the table. */
  readonly spoke: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number };
}

/**
 * Diamond alone breaks the pattern, because it marks a change of kind: the
 * field is cut into eight facets around a raised table instead of being milled
 * flat.
 */
export function crystalFacets(radius: number): CrystalFacet[] {
  const facets: CrystalFacet[] = [];
  for (let i = 0; i < 8; i++) {
    const a1 = (i / 8) * Math.PI * 2 - Math.PI / 8;
    const a2 = ((i + 1) / 8) * Math.PI * 2 - Math.PI / 8;
    const am = (a1 + a2) / 2;
    const x1 = 50 + Math.cos(a1) * radius;
    const y1 = 50 + Math.sin(a1) * radius;
    const x2 = 50 + Math.cos(a2) * radius;
    const y2 = 50 + Math.sin(a2) * radius;
    const xm = 50 + Math.cos(am) * radius * 0.46;
    const ym = 50 + Math.sin(am) * radius * 0.46;
    facets.push({
      path: `M${x1.toFixed(1)},${y1.toFixed(1)} L${x2.toFixed(1)},${y2.toFixed(1)} L${xm.toFixed(1)},${ym.toFixed(1)} Z`,
      lit: i % 2 === 1,
      spoke: {
        x1: Number(x1.toFixed(1)), y1: Number(y1.toFixed(1)),
        x2: Number((50 + Math.cos(a1) * radius * 0.46).toFixed(1)),
        y2: Number((50 + Math.sin(a1) * radius * 0.46).toFixed(1)),
      },
    });
  }
  return facets;
}

