/**
 * Self-serve organisation onboarding: the rules that do not need a database.
 *
 * "Business area" is not a new taxonomy. It is the shared role catalog's own
 * `CatalogDomain` — the 35 areas the catalog already groups every role under,
 * and the same word the role form already uses ("Domain"). An organisation
 * picks a handful of them so the catalog it searches is the part it hires in.
 * `CatalogJobFamily` is the other axis (what kind of work: Engineering,
 * Advisory, Management) and is deliberately NOT what is being chosen here.
 */

import { normalizeTitle } from './catalogText.js';

/** How many business areas an organisation may hold before the owner raises it. */
export const DEFAULT_BUSINESS_AREA_LIMIT = 5;

/**
 * The ceiling the owner may raise an organisation to. 35 is every domain in
 * the seeded catalog, i.e. "all of it" — a limit above that would be a number
 * with nothing behind it.
 */
export const MAX_BUSINESS_AREA_LIMIT = 35;

/** Rough size, asked once so the owner can weigh a request. Not used for billing. */
export const ORG_SIZES = [
  { id: 'under-50', label: '1–50 people' },
  { id: '50-200', label: '51–200 people' },
  { id: '200-1000', label: '201–1,000 people' },
  { id: '1000-5000', label: '1,001–5,000 people' },
  { id: 'over-5000', label: 'More than 5,000 people' },
] as const;

export type OrgSizeId = (typeof ORG_SIZES)[number]['id'];

export const ORG_SIZE_IDS = ORG_SIZES.map((s) => s.id) as readonly OrgSizeId[];

export function isOrgSize(value: string): value is OrgSizeId {
  return (ORG_SIZE_IDS as readonly string[]).includes(value);
}

export function orgSizeLabel(id: string): string {
  return ORG_SIZES.find((s) => s.id === id)?.label ?? id;
}

// --- abuse defences ---------------------------------------------------------
//
// A public form that creates queue rows is a flood surface and a name-reservation
// surface at once. Four separate limits, because they stop different people:
// one address hammering the form, one domain spraying from many addresses, a
// competitor re-submitting a name to keep it occupied, and a botnet filling the
// queue so real requests are never seen.

/** Requests one email address may make in a day. */
export const MAX_REQUESTS_PER_EMAIL_PER_DAY = 3;

/**
 * Requests one email domain may make in a day. Higher than the per-address
 * limit because several people at one company legitimately ask, and far below
 * what a script would want.
 */
export const MAX_REQUESTS_PER_EMAIL_DOMAIN_PER_DAY = 10;

/** How long one organisation name stays claimed by an earlier request. */
export const ORG_NAME_COOLDOWN_HOURS = 24;

/** Pending requests the queue holds before the form stops accepting more. */
export const MAX_PENDING_REQUESTS = 200;

export const DAY_MS = 24 * 60 * 60_000;

/**
 * The comparison key for "the same organisation name". Case, punctuation and
 * the usual company suffixes are noise: "Acme Corp.", "ACME Corporation" and
 * "acme corp" are one name, and a cooldown that missed that would be bypassed
 * by typing a full stop.
 */
const COMPANY_SUFFIXES = new Set([
  'inc', 'llc', 'ltd', 'limited', 'plc', 'gmbh', 'bv', 'nv', 'sa', 'ag', 'srl', 'spa', 'oy', 'ab',
  'corp', 'corporation', 'co', 'company', 'pvt', 'private', 'pte', 'llp', 'group', 'holdings',
  'technologies', 'technology', 'tech', 'labs', 'solutions', 'services', 'systems', 'the',
]);

export function orgNameKey(name: string): string {
  const words = normalizeTitle(name).split(' ').filter(Boolean);
  const kept = words.filter((w) => !COMPANY_SUFFIXES.has(w));
  // Everything was a suffix ("The Group Ltd"): keep the words rather than
  // collapse every such name onto one empty key that would block them all.
  return (kept.length > 0 ? kept : words).join(' ');
}

/** The part after the @, lowercased. '' when the address has no domain. */
export function emailDomainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase();
}

// --- business-area selection ------------------------------------------------

export interface BusinessAreaSelectionProblem {
  readonly reason: 'too-many' | 'unknown-area' | 'duplicate';
  readonly message: string;
}

/**
 * Why this selection cannot be saved, or null when it can. `known` is the set
 * of slugs the catalog actually has: an unknown slug is refused rather than
 * silently dropped, because an organisation that asked for six areas and got
 * four would blame the filter for the roles it could not find.
 */
export function businessAreaSelectionProblem(
  slugs: readonly string[],
  known: ReadonlySet<string>,
  limit: number,
): BusinessAreaSelectionProblem | null {
  if (new Set(slugs).size !== slugs.length) {
    return { reason: 'duplicate', message: 'Each business area can only be chosen once.' };
  }
  if (slugs.length > limit) {
    return {
      reason: 'too-many',
      message: `Choose up to ${limit} business ${limit === 1 ? 'area' : 'areas'}. Ask the Questor team to raise the limit if you need more.`,
    };
  }
  const unknown = slugs.find((s) => !known.has(s));
  if (unknown) return { reason: 'unknown-area', message: 'One of the business areas chosen is not in the catalog.' };
  return null;
}

/**
 * Whether the catalog should be narrowed for this organisation.
 *
 * An organisation that chose nothing — every organisation that existed before
 * this feature — sees the whole catalog, exactly as it did before. The filter
 * is a default view and never a claim about who may see what: the catalog is
 * global and shared, and `scope=all` returns all of it to anyone signed in.
 */
export function shouldScopeCatalog(chosenAreaIds: readonly string[], scope: 'mine' | 'all'): boolean {
  return scope === 'mine' && chosenAreaIds.length > 0;
}
