import { badgeShapes, type Tier } from './badgeGeometry.js';
import { rasterisePng } from './rasterPng.js';

/**
 * The badge as a PNG, rendered once per tier and size.
 *
 * A badge carries no candidate in it at all: every Silver badge at 512px is
 * the same file, whoever it was exported for. Rasterising it is the one
 * genuinely expensive thing on this router — a megapixel of scanline work on
 * the event loop, a second and a half at the top of its range — so doing it
 * again for each of a shortlist's thirty candidates would block the server for
 * the better part of a minute to produce thirty identical files.
 *
 * Bounded rather than unbounded. The route snaps `?size=` to a ladder of six,
 * so four tiers can only ever produce twenty-four entries and this map holds
 * the lot — but the bound is here rather than assumed there, because a second
 * caller reaching this function directly must not be able to fill it.
 * Eviction is oldest-first, and a miss costs exactly what having no cache at
 * all would have cost.
 */

const MAX_ENTRIES = 32;
const cache = new Map<string, Buffer>();

export function badgePng(tier: Tier, size: number): Buffer {
  const key = `${tier}:${size}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const png = rasterisePng(badgeShapes(tier, size), size);
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, png);
  return png;
}

/** Tests that change the geometry need the next render to be a real one. */
export function _resetBadgePngCache(): void {
  cache.clear();
}
