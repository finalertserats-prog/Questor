/**
 * The onboarding form's rules, with no React in them.
 *
 * Kept separate from the page so each rule is testable on its own, and so the
 * page never becomes the only place a rule is written down. The server
 * enforces every one of these again: this half exists to say what is wrong
 * before someone waits for a round trip, not to be the check.
 */

export const PASSWORD_MIN_LENGTH = 12;
export const DEFAULT_BUSINESS_AREA_LIMIT = 5;

export interface BusinessAreaOption {
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
}

export interface RegionOption {
  readonly code: string;
  readonly name: string;
}

export interface SizeOption {
  readonly id: string;
  readonly label: string;
}

export interface OnboardOptions {
  readonly regions: readonly RegionOption[];
  readonly businessAreas: readonly BusinessAreaOption[];
  readonly sizes: readonly SizeOption[];
  readonly businessAreaLimit: number;
}

export interface OnboardForm {
  readonly organisationName: string;
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly regionCode: string;
  readonly orgSize: string;
  readonly businessAreas: readonly string[];
}

export const EMPTY_ONBOARD_FORM: OnboardForm = {
  organisationName: '', name: '', email: '', password: '', regionCode: '', orgSize: '', businessAreas: [],
};

/**
 * Why this form cannot be sent yet, in the order a person fills it in, or null
 * when it can. One message at a time: a wall of red beside every field reads
 * as "this form is broken" rather than "this line needs a moment".
 */
export function onboardFormProblem(form: OnboardForm, limit = DEFAULT_BUSINESS_AREA_LIMIT): string | null {
  if (!form.organisationName.trim()) return 'Tell us your organisation\'s name.';
  if (form.organisationName.trim().length > 200) return 'That organisation name is too long.';
  if (/[\r\n]/.test(form.organisationName)) return 'The organisation name has to be a single line.';
  if (!form.name.trim()) return 'Tell us your name.';
  if (!isPlausibleEmail(form.email)) return 'Use a work email address we can reply to.';
  if (form.password.length < PASSWORD_MIN_LENGTH) return `Choose a password of at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (!form.regionCode) return 'Choose where your organisation hires.';
  if (!form.orgSize) return 'Tell us roughly how big your organisation is.';
  if (form.businessAreas.length === 0) return 'Choose at least one business area you hire for.';
  if (form.businessAreas.length > limit) return `Choose up to ${limit} business areas.`;
  return null;
}

/**
 * Deliberately loose. The address is confirmed by an email arriving, not by a
 * regex, and a stricter pattern only ever turns away real addresses.
 */
export function isPlausibleEmail(value: string): boolean {
  const trimmed = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) && trimmed.length <= 254;
}

/** The body the public endpoint takes. */
export function onboardRequestBody(form: OnboardForm) {
  return {
    mode: 'new-org' as const,
    organisationName: form.organisationName.trim(),
    name: form.name.trim(),
    email: form.email.trim().toLowerCase(),
    password: form.password,
    regionCode: form.regionCode,
    orgSize: form.orgSize,
    businessAreas: [...form.businessAreas],
  };
}

/**
 * Add or remove one area, refusing to go past the limit rather than dropping
 * whichever was chosen first. Order is preserved so the summary reads back in
 * the order they were picked.
 */
export function toggleBusinessArea(chosen: readonly string[], slug: string, limit: number): readonly string[] {
  if (chosen.includes(slug)) return chosen.filter((s) => s !== slug);
  if (chosen.length >= limit) return chosen;
  return [...chosen, slug];
}

/** Whether this area can still be added. Drives the disabled state, not a message. */
export function canAddBusinessArea(chosen: readonly string[], slug: string, limit: number): boolean {
  return chosen.includes(slug) || chosen.length < limit;
}

/** "2 of 5 chosen" — the count a person needs while choosing, not after. */
export function businessAreaCountLabel(chosen: readonly string[], limit: number): string {
  return `${chosen.length} of ${limit} chosen`;
}

/**
 * Narrow a long list of areas by what someone typed. 35 areas is more than a
 * page of checkboxes, and the name alone misses "we hire nurses" against
 * "Healthcare, Clinical & HealthTech" — so the summary is searched too.
 */
export function filterBusinessAreas(areas: readonly BusinessAreaOption[], query: string): readonly BusinessAreaOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return areas;
  return areas.filter((a) => `${a.name} ${a.summary}`.toLowerCase().includes(needle));
}

/**
 * What to tell someone whose request did not go through.
 *
 * Never the server's own text. The endpoint answers every request identically
 * on purpose — so that it cannot be used to find out whether an organisation
 * or an address is already here — and relaying its message is exactly how that
 * guarantee would quietly stop holding. Being asked to slow down is the one
 * refusal that says nothing about anyone else, so it is passed on as itself.
 */
export function onboardErrorMessage(status: number | undefined): string {
  if (status === 429) return 'That is a lot of requests in a short time. Please try again in a few minutes.';
  if (status === 400) return 'Something on this form was not accepted. Check the details and try again.';
  return 'We could not send your request just now. Please try again in a moment.';
}
