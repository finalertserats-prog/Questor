import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  BRAND_TAGLINE,
  brandLogoAlt,
  brandLogoBox,
  brandLogoSources,
  brandLogoTone,
  browserThemeColor,
  priorityAttributes,
  type BrandLogoVariant,
} from '../src/components/brandLogoModel';

/**
 * Which logo file is drawn is decided by the ACTIVE app theme — the one the
 * reader picked with the in-app switch — not the operating system's
 * preference, which the product deliberately ignores (see components/theme.tsx).
 */

const VARIANTS: readonly BrandLogoVariant[] = ['mark', 'lockup', 'full'];

describe('brandLogoTone', () => {
  it('follows the active light theme', () => {
    expect(brandLogoTone('light')).toBe('light');
  });

  it('follows the active dark theme', () => {
    expect(brandLogoTone('dark')).toBe('dark');
  });

  it('lets a surface that is always dark force the dark artwork on a light theme', () => {
    expect(brandLogoTone('light', 'dark')).toBe('dark');
  });

  it('lets a surface that is always light force the light artwork on a dark theme', () => {
    expect(brandLogoTone('dark', 'light')).toBe('light');
  });
});

describe('brandLogoSources', () => {
  it('draws the lockup for a light theme from the light file', () => {
    expect(brandLogoSources('lockup', 'light').src).toBe('/brand/questor-lockup-light.png');
  });

  it('draws the lockup for a dark theme from the dark file', () => {
    expect(brandLogoSources('lockup', 'dark').src).toBe('/brand/questor-lockup-dark.png');
  });

  it('offers a webp of the dark lockup for browsers that take it', () => {
    expect(brandLogoSources('lockup', 'dark').webp).toBe('/brand/questor-lockup-dark.webp');
  });

  it('draws the full logo for a light theme from the light file', () => {
    expect(brandLogoSources('full', 'light').src).toBe('/brand/questor-logo-light.png');
  });

  it('draws the full logo for a dark theme from the dark file', () => {
    expect(brandLogoSources('full', 'dark').src).toBe('/brand/questor-logo-dark.png');
  });

  it('offers a webp of the light full logo', () => {
    expect(brandLogoSources('full', 'light').webp).toBe('/brand/questor-logo-light.webp');
  });

  it('draws the mark from the vector file, which reads on both themes', () => {
    expect(brandLogoSources('mark', 'dark').src).toBe('/brand/questor-mark.svg');
  });

  it('draws the same mark on both themes', () => {
    expect(brandLogoSources('mark', 'light')).toEqual(brandLogoSources('mark', 'dark'));
  });

  it('offers no webp alternative for the vector mark', () => {
    expect(brandLogoSources('mark', 'light').webp).toBeUndefined();
  });

  it.each(['lockup', 'full'] as const)('never draws the %s from the same file on both themes', (variant) => {
    expect(brandLogoSources(variant, 'light').src).not.toBe(brandLogoSources(variant, 'dark').src);
  });
});

describe('brandLogoBox', () => {
  it('draws the mark square', () => {
    expect(brandLogoBox('mark', 26)).toEqual({ width: 26, height: 26 });
  });

  it('draws the lockup wider than it is tall', () => {
    const box = brandLogoBox('lockup', 30);
    expect(box.width).toBeGreaterThan(box.height);
  });

  it.each(VARIANTS)('reserves whole pixels for the %s, so the attributes are valid', (variant) => {
    const box = brandLogoBox(variant, 33);
    expect(Number.isInteger(box.width) && Number.isInteger(box.height)).toBe(true);
  });

  it.each(VARIANTS)('keeps the %s at the height asked for', (variant) => {
    expect(brandLogoBox(variant, 40).height).toBe(40);
  });
});

describe('brandLogoAlt', () => {
  it('names the product for the mark', () => {
    expect(brandLogoAlt('mark', false)).toBe('Questor');
  });

  it('names the product for the lockup', () => {
    expect(brandLogoAlt('lockup', false)).toBe('Questor');
  });

  it('reads the tagline the full logo draws', () => {
    expect(brandLogoAlt('full', false)).toBe(`Questor — ${BRAND_TAGLINE}`);
  });

  it.each(VARIANTS)('is empty for a decorative %s, so a screen reader skips it', (variant) => {
    expect(brandLogoAlt(variant, true)).toBe('');
  });
});

describe('BRAND_TAGLINE', () => {
  it('is the product line, set as a sentence', () => {
    expect(BRAND_TAGLINE).toBe('The intelligence behind every hire.');
  });
});

describe('priorityAttributes', () => {
  it('loads an above-the-fold logo eagerly', () => {
    expect(priorityAttributes(true).loading).toBe('eager');
  });

  it('asks for an above-the-fold logo first', () => {
    expect(priorityAttributes(true).fetchpriority).toBe('high');
  });

  it('adds nothing for an ordinary logo', () => {
    expect(priorityAttributes(false)).toEqual({});
  });
});

describe('browserThemeColor', () => {
  it('paints the browser chrome the light page colour on the light theme', () => {
    expect(browserThemeColor('light')).toBe('#f5f4f8');
  });

  it('paints the browser chrome the dark page colour on the dark theme', () => {
    expect(browserThemeColor('dark')).toBe('#121218');
  });
});

describe('index.html', () => {
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');

  it('offers the vector favicon', () => {
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/brand/favicon.svg" />');
  });

  it('keeps the .ico fallback for browsers without SVG favicons', () => {
    expect(html).toContain('href="/brand/favicon.ico"');
  });

  it('links the web app manifest', () => {
    expect(html).toContain('<link rel="manifest" href="/brand/site.webmanifest" />');
  });

  it('links the apple touch icon', () => {
    expect(html).toContain('href="/brand/apple-touch-icon.png"');
  });

  it.each(['light', 'dark'] as const)('guesses a %s theme-color from the page background', (theme) => {
    expect(html).toContain(`media="(prefers-color-scheme: ${theme})" content="${browserThemeColor(theme)}"`);
  });

  it('rewrites theme-color to the chosen theme before first paint', () => {
    expect(html).toContain(`theme === 'dark' ? '${browserThemeColor('dark')}' : '${browserThemeColor('light')}'`);
  });
});
