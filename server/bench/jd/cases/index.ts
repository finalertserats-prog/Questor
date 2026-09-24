import { DATA_CASES } from './dataEngineering.js';
import type { JdGoldCase } from '../types.js';

/**
 * The gold set.
 *
 * Every case is written rather than scraped — a real advert cannot be
 * committed here, and a synthetic one can be labelled honestly — and shaped
 * like the adverts the product actually receives, headings, perks, boilerplate
 * and all.
 */
export const GOLD_CASES: readonly JdGoldCase[] = [
  ...DATA_CASES,
];
