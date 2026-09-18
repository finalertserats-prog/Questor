/**
 * Which Questor logo file to draw, and at what size — kept free of React so it
 * can be unit tested in the node test environment (web/tests/brandLogoModel.test.ts).
 *
 * The artwork comes in a light and a dark cut. The cut is chosen from the
 * ACTIVE app theme, the one set by the in-app switch, and never from
 * prefers-color-scheme: the product ignores the OS preference on purpose (see
 * components/theme.tsx), so a <source media="(prefers-color-scheme: dark)">
 * would draw the dark logo on a light page for anyone on a dark desktop.
 */

import type { Theme } from './theme';

export type BrandLogoVariant = 'mark' | 'lockup' | 'full';

/** Which cut of the artwork: "light" is drawn on light surfaces, "dark" on dark ones. */
export type BrandLogoTone = Theme;

export const BRAND_NAME = 'Questor';

/** The product line, as the full logo sets it and as copy should quote it. */
export const BRAND_TAGLINE = 'The intelligence behind every hire.';

const BRAND_DIR = '/brand';

/**
 * The drawn proportions (width / height) of each file. These only reserve
 * space before the file arrives; once it has, CSS lets the file's own
 * proportions win (see .brand-logo), so artwork that drifts from these figures
 * is never stretched — at worst it shifts by a pixel or two on load.
 */
const ASPECT_RATIO: Readonly<Record<BrandLogoVariant, number>> = {
  mark: 1,
  lockup: 3.6,
  full: 1.3,
};

/**
 * The surface's theme, unless the surface paints itself one way regardless
 * (the interview room is always dark), in which case that wins.
 */
export function brandLogoTone(activeTheme: Theme, surfaceTone?: BrandLogoTone): BrandLogoTone {
  return surfaceTone ?? activeTheme;
}

export interface BrandLogoSources {
  /** The file every browser can draw. */
  readonly src: string;
  /** A smaller alternative for browsers that take webp; absent for vector art. */
  readonly webp?: string;
}

export function brandLogoSources(variant: BrandLogoVariant, tone: BrandLogoTone): BrandLogoSources {
  switch (variant) {
    case 'mark':
      // One vector file: the purple Q and white bubble read on either ground,
      // and it is sharp at every size and pixel density.
      return { src: `${BRAND_DIR}/questor-mark.svg` };
    case 'lockup':
      return {
        src: `${BRAND_DIR}/questor-lockup-${tone}.png`,
        webp: `${BRAND_DIR}/questor-lockup-${tone}.webp`,
      };
    case 'full':
      return {
        src: `${BRAND_DIR}/questor-logo-${tone}.png`,
        webp: `${BRAND_DIR}/questor-logo-${tone}.webp`,
      };
    default: {
      const unreachable: never = variant;
      throw new Error(`Unknown logo variant: ${String(unreachable)}`);
    }
  }
}

export interface BrandLogoBox {
  readonly width: number;
  readonly height: number;
}

/** The width and height attributes for a logo drawn `height` CSS pixels tall. */
export function brandLogoBox(variant: BrandLogoVariant, height: number): BrandLogoBox {
  const h = Math.round(height);
  return { width: Math.round(h * ASPECT_RATIO[variant]), height: h };
}

/**
 * The words the artwork draws. Decorative uses — a logo beside the product's
 * name in text — are silent, so a screen reader does not say "Questor" twice.
 */
export function brandLogoAlt(variant: BrandLogoVariant, decorative: boolean): string {
  if (decorative) return '';
  return variant === 'full' ? `${BRAND_NAME} — ${BRAND_TAGLINE}` : BRAND_NAME;
}

/**
 * The page background (--desk in styles/app.css) per theme, for the browser's
 * theme-color. index.html's pre-paint script carries the same two values.
 */
const THEME_COLOR: Readonly<Record<Theme, string>> = {
  light: '#f5f4f8',
  dark: '#121218',
};

export function browserThemeColor(theme: Theme): string {
  return THEME_COLOR[theme];
}

export interface PriorityAttributes {
  readonly loading?: 'eager';
  /**
   * Lower-case on purpose: React 18 passes an unknown lower-case attribute
   * straight to the DOM, but warns about the camel-cased `fetchPriority`.
   */
  readonly fetchpriority?: 'high';
}

/** Only the one logo that is above the fold on first paint asks to jump the queue. */
export function priorityAttributes(priority: boolean): PriorityAttributes {
  return priority ? { loading: 'eager', fetchpriority: 'high' } : {};
}
