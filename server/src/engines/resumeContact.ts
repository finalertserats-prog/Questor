/**
 * Who a CV belongs to, read from its own text: name, email, phone and a
 * LinkedIn link. Used by bulk import to fill each preview row; everything it
 * finds is shown for the person to check before anything is saved, so a
 * wrong guess costs an edit, not a wrong record.
 */

export interface CvContact {
  readonly fullName: string;
  readonly email: string;
  readonly phone: string;
  readonly linkedinUrl: string;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// Digits with the usual spacing and punctuation; see phoneIn for the rest.
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;
// Fewer digits than any real number, and more than a date range such as 2019 - 2023 has.
const MIN_PHONE_DIGITS = 9;
const LINKEDIN_RE = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/[^\s|,;)]+/i;
const HEADINGS = /^(curriculum vitae|resume|résumé|cv|profile|summary|contact|personal details|objective)$/i;
const FILE_NOISE = new Set(['cv', 'resume', 'résumé', 'curriculum', 'vitae', 'final', 'updated', 'latest', 'new', 'copy', 'profile']);
const MAX_NAME_WORDS = 5;

/** Two to five words of letters (with ' . -), nothing else on the line. */
function looksLikeName(line: string): boolean {
  if (HEADINGS.test(line)) return false;
  const words = line.split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.length <= MAX_NAME_WORDS && words.every((w) => /^\p{L}[\p{L}'.-]*$/u.test(w));
}

const titleCase = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

/** "ana-lopez-resume-2024.docx" → "Ana Lopez"; empty when nothing name-like is left. */
export function nameFromFilename(filename: string): string {
  const words = filename
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .split(/[\s_.-]+/)
    .filter((w) => /^\p{L}+$/u.test(w) && !FILE_NOISE.has(w.toLowerCase()));
  return words.length >= 2 && words.length <= MAX_NAME_WORDS ? words.map(titleCase).join(' ') : '';
}

/** A LinkedIn profile address as an https link on linkedin.com, or '' for anything else. */
export function normalizeLinkedinUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return '';
    return `https://${url.host}${url.pathname}${url.search}`.slice(0, 300);
  } catch {
    return '';
  }
}

function phoneIn(text: string): string {
  const found = [...text.matchAll(PHONE_RE)].map((m) => m[0].trim())
    .find((candidate) => candidate.replace(/\D/g, '').length >= MIN_PHONE_DIGITS);
  return found ?? '';
}

export function extractContact(text: string, filename: string): CvContact {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  // The name is at the top of a CV if it is anywhere; lower lines are job titles and places.
  const nameLine = lines.slice(0, 8).find(looksLikeName);
  const linkedin = LINKEDIN_RE.exec(text)?.[0] ?? '';
  const phone = phoneIn(text.replace(LINKEDIN_RE, '').replace(new RegExp(EMAIL_RE.source, 'g'), ''));
  return {
    fullName: (nameLine ?? nameFromFilename(filename)).slice(0, 200),
    email: (EMAIL_RE.exec(text)?.[0] ?? '').slice(0, 254),
    phone: phone.replace(/\s+/g, ' ').slice(0, 40),
    linkedinUrl: normalizeLinkedinUrl(linkedin),
  };
}
