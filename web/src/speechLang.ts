/**
 * The language the browser's speech recognizer listens in.
 *
 * It used to be 'en-US' for everyone, so an English speaker in India, the UK
 * or Australia was heard by the US-English model and their answers came out
 * less accurately — lower-quality evidence for scoring. The session's own
 * language comes first; when it names only a language ('en'), the region
 * comes from the candidate's browser, and failing that a sensible default.
 */

const TAG = /^([a-z]{2,3})(?:-([a-z]{2}|\d{3}))?$/i;

/** The region used when neither the session nor the browser names one. */
const DEFAULT_REGION: Readonly<Record<string, string>> = {
  en: 'US', es: 'ES', fr: 'FR', hi: 'IN', de: 'DE', pt: 'BR', it: 'IT', ja: 'JP',
};

const FALLBACK = 'en-US';

function parseTag(tag: string): { readonly language: string; readonly region: string | null } | null {
  const match = TAG.exec(tag.trim());
  if (!match) return null;
  return { language: match[1].toLowerCase(), region: match[2] ? match[2].toUpperCase() : null };
}

export function recognitionLang(sessionLanguage: string | null | undefined, browserLanguages: readonly string[]): string {
  const session = sessionLanguage ? parseTag(sessionLanguage) : null;
  if (!session) return FALLBACK;
  if (session.region) return `${session.language}-${session.region}`;
  const fromBrowser = browserLanguages
    .map(parseTag)
    .find((tag) => tag !== null && tag.language === session.language && tag.region !== null);
  if (fromBrowser?.region) return `${session.language}-${fromBrowser.region}`;
  const region = DEFAULT_REGION[session.language];
  return region ? `${session.language}-${region}` : session.language;
}
