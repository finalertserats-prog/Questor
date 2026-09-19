/**
 * How a role is named wherever it is listed. Kept free of React so it can be
 * unit tested (see web/tests/roleLabelModel.test.ts).
 *
 * WHY: a tenant can hold two roles with the same title — one per region, one
 * per level — and every list and dropdown printed them identically, so the
 * person picking one had no way to tell which was which.
 */

import { formatDate, formatDateTime } from './dateFormat';

/** The fields a role label can be disambiguated with. All optional: older servers do not send them. */
export interface RoleLabelSource {
  readonly id?: string;
  readonly title: string;
  readonly level?: string | null;
  readonly regionCode?: string | null;
  readonly experienceBand?: string | null;
  readonly createdAt?: string | null;
}

export const LABEL_SEPARATOR = ' · ';

type FieldReader = (item: RoleLabelSource) => string;

// In the order a reader reaches for them: level first, the creation date last.
const DISTINGUISHING_FIELDS: readonly FieldReader[] = [
  (item) => (item.level ?? '').trim(),
  (item) => (item.regionCode ?? '').trim(),
  (item) => (item.experienceBand ?? '').trim(),
  (item) => (item.createdAt ? formatDate(item.createdAt) : ''),
];

function titleKey(title: string): string {
  return title.trim().toLowerCase();
}

function suffixFor(item: RoleLabelSource, fields: readonly FieldReader[]): string {
  return fields.map((read) => read(item)).filter(Boolean).join(LABEL_SEPARATOR);
}

/**
 * The fields that tell the distinct roles in one same-titled group apart:
 * each field is added only if it separates at least two of them, and adding
 * stops as soon as every role reads differently.
 */
function chooseFields(group: readonly RoleLabelSource[]): readonly FieldReader[] {
  const chosen: FieldReader[] = [];
  for (const read of DISTINGUISHING_FIELDS) {
    const values = new Set(group.map(read));
    if (values.size < 2) continue;
    chosen.push(read);
    if (new Set(group.map((item) => suffixFor(item, chosen))).size === group.length) break;
  }
  return chosen;
}

/**
 * Display labels for `items`, index for index. A title no other role shares is
 * returned as is. Where two or more distinct roles share a title, each gets the
 * first fields (level, region code, experience band, creation date) needed to
 * tell them apart, e.g. "Senior Backend Engineer (Payments) · Senior · IN".
 * The same role appearing twice (same id) is not a collision.
 */
export function roleDisplayLabels(items: readonly RoleLabelSource[]): string[] {
  const groups = new Map<string, RoleLabelSource[]>();
  items.forEach((item) => {
    const key = titleKey(item.title);
    const members = groups.get(key) ?? [];
    const alreadyListed = item.id !== undefined && members.some((m) => m.id === item.id);
    if (!alreadyListed) groups.set(key, [...members, item]);
  });
  const fieldsByTitle = new Map<string, readonly FieldReader[]>();
  groups.forEach((group, key) => {
    fieldsByTitle.set(key, group.length > 1 ? chooseFields(group) : []);
  });
  return items.map((item) => {
    const suffix = suffixFor(item, fieldsByTitle.get(titleKey(item.title)) ?? []);
    return suffix ? `${item.title.trim()}${LABEL_SEPARATOR}${suffix}` : item.title;
  });
}

/** The label for the role with `id`, disambiguated against the rest of `items`. */
export function roleDisplayLabel(items: readonly RoleLabelSource[], id: string): string {
  const index = items.findIndex((item) => item.id === id);
  return index === -1 ? '' : roleDisplayLabels(items)[index];
}

/** Names for the catalog's experience bands, as a person reads them. */
const BAND_NAMES: Readonly<Record<string, string>> = {
  emerging: 'Emerging', developing: 'Developing', established: 'Established',
  senior: 'Senior', principal: 'Principal', executive: 'Executive',
};

/** The catalog's eight regions by name: a bare "NA" reads as "not applicable". */
const REGION_NAMES: Readonly<Record<string, string>> = {
  NA: 'North America', LATAM: 'Latin America', UKI: 'UK & Ireland', EU: 'Europe',
  MENA: 'Middle East & North Africa', IN: 'India', APAC: 'Asia-Pacific', ANZ: 'Australia & New Zealand',
};

/**
 * The line under a role's title in the roles list. A role linked to the
 * catalog shows its chosen experience level, domain and region by name; the
 * level read from the JD is shown only when no level was chosen, so the line
 * never says "Senior" and "Established" at once.
 */
export function roleDetailLine(role: {
  readonly level?: string | null;
  readonly domain?: string | null;
  readonly regionCode?: string | null;
  readonly experienceBand?: string | null;
}): string {
  const band = role.experienceBand ? (BAND_NAMES[role.experienceBand] ?? role.experienceBand) : null;
  const region = role.regionCode ? (REGION_NAMES[role.regionCode] ?? role.regionCode) : null;
  const parts = role.domain
    ? [band ?? role.level, role.domain, region]
    : [role.level, 'Not linked to catalog'];
  return parts.map((part) => (part ?? '').trim()).filter(Boolean).join(LABEL_SEPARATOR);
}

/** Labels for a session picker: date and time, so two sessions on the same day differ. */
export function sessionOptionLabels(sessions: readonly { readonly id: string; readonly createdAt: string; readonly text: string }[]): string[] {
  return sessions.map((s) => `${formatDateTime(s.createdAt)}${LABEL_SEPARATOR}${s.text}`);
}
