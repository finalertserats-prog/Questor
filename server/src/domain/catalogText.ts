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
