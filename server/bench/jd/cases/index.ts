import { DATA_CASES } from './dataEngineering.js';
import { SOFTWARE_CASES } from './software.js';
import { PLATFORM_CASES } from './platformSecurity.js';
import { PRODUCT_CASES } from './productDesign.js';
import { COMMERCIAL_CASES } from './salesMarketing.js';
import { FINANCE_LEGAL_CASES } from './financeLegal.js';
import { HEALTH_SCIENCE_CASES } from './healthcareScience.js';
import { INDUSTRIAL_CASES } from './operationsIndustrial.js';
import { PUBLIC_EDUCATION_CASES } from './publicEducation.js';
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
  ...SOFTWARE_CASES,
  ...PLATFORM_CASES,
  ...PRODUCT_CASES,
  ...COMMERCIAL_CASES,
  ...FINANCE_LEGAL_CASES,
  ...HEALTH_SCIENCE_CASES,
  ...INDUSTRIAL_CASES,
  ...PUBLIC_EDUCATION_CASES,
];
