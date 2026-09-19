export function normalizeTitle(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s+#]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugifyCatalogName(s: string): string {
  return normalizeTitle(s)
    .replace(/\+/g, ' plus ')
    .replace(/#/g, ' sharp ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Why a title may not go into the shared catalog, or null when it may. Every
 * organisation reads the catalog, so a title that carries an email address, a
 * link or a phone/requisition number would carry one company's details to all
 * of them.
 */
export function catalogTitleProblem(title: string): string | null {
  const t = title.trim();
  if (t.length < 2 || t.length > 120) return 'Title must be 2 to 120 characters.';
  if (/[\r\n]/.test(t)) return 'Title must be a single line.';
  if (!/\p{L}/u.test(t)) return 'Title must contain a letter.';
  if (/@|https?:\/\/|www\./i.test(t)) return 'Title must not contain contact details or links.';
  if (/\d{6,}/.test(t)) return 'Title must not contain requisition or phone numbers.';
  return null;
}
