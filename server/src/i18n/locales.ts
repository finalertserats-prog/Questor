// Multi-language interview DELIVERY.
//
// `InterviewSession.language` has existed since the first schema and, until
// now, reached exactly one place: the interview planner's prompt. Nothing else
// in the product changed when a session was created as `fr` — the disclosure
// stayed English, the voice stayed English, and the portal said nothing about
// it. That is the failure mode this module exists to stop: silently degrading
// while presenting as though the language were delivered.
//
// The hard rule here is that legally operative text is NEVER machine
// translated. A consent/disclosure notice is the artefact a Title VII or GDPR
// challenge is argued over; a plausible-looking but unreviewed translation of
// it is a liability, not a feature. So this registry stores a REVIEW FLAG, and
// the resolver below falls back to the English source text rather than
// inventing a translation. Adding a language means a human translator writes
// the text, a human reviewer approves it, and only then does
// `translationReviewed` flip to true in the same commit that adds the text.
//
// Deliberately code/config rather than a table: review status is a release
// artefact — it changes when someone lands reviewed copy, not when a tenant
// clicks something — and it belongs in the diff a reviewer reads.

export interface SupportedLanguage {
  /** BCP-47 primary subtag, lowercase. */
  readonly code: string;
  /** English display name, for HR-facing pickers. */
  readonly name: string;
  /**
   * True only when a human has written AND approved the disclosure/consent
   * copy for this language. False means the candidate will be shown the
   * English source text.
   */
  readonly translationReviewed: boolean;
  /**
   * Whether speech-to-text is likely to work for this language on the delivery
   * path the zero-key build actually ships (browser SpeechRecognition, plus
   * whichever server provider is configured). "Likely" is the honest word: it
   * is a per-browser, per-vendor matter we cannot probe from the server. False
   * is not a blocker — the typed-answer fallback covers every language — but it
   * must be shown, never hidden.
   */
  readonly sttLikelySupported: boolean;
}

/**
 * The only language this product can currently deliver end to end is English.
 * The remaining entries are SHAPE, not capability: they exist so HR can see,
 * before scheduling, that picking one of them means an English disclosure and
 * no promised voice support. They stay `translationReviewed: false` until
 * reviewed copy lands in REVIEWED_DISCLOSURES below.
 */
export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  { code: 'en', name: 'English', translationReviewed: true, sttLikelySupported: true },
  { code: 'es', name: 'Spanish', translationReviewed: false, sttLikelySupported: false },
  { code: 'fr', name: 'French', translationReviewed: false, sttLikelySupported: false },
  { code: 'hi', name: 'Hindi', translationReviewed: false, sttLikelySupported: false },
];

/**
 * Approved disclosure copy, keyed by language code.
 *
 * `en` is deliberately absent: the English text is whatever the tenant
 * configured (or the product default assembled in routes/interviews.ts), so
 * there is no second copy of it to drift out of date. Every other key added
 * here MUST be human-translated and human-reviewed — an entry in this map is a
 * claim that a person signed off on the wording.
 */
const REVIEWED_DISCLOSURES: Readonly<Record<string, string>> = {};

/**
 * Registry lookups use the primary subtag: a session stored as `en-GB` is still
 * English for the purpose of "do we have reviewed copy". Anything unrecognised
 * resolves to undefined, which the callers treat as "not reviewed, no STT
 * claim" — the safe direction.
 */
function normalizeCode(languageCode: string): string {
  return languageCode.trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

export function findLanguage(languageCode: string): SupportedLanguage | undefined {
  const code = normalizeCode(languageCode);
  return SUPPORTED_LANGUAGES.find((lang) => lang.code === code);
}

export interface ResolvedDisclosure {
  readonly text: string;
  readonly translationReviewed: boolean;
}

/**
 * Resolve the disclosure a candidate should actually be shown.
 *
 * For a reviewed language, returns the approved text for it. For everything
 * else — an unreviewed placeholder language, or a code we have never heard of —
 * returns `baseEnglishText` UNCHANGED with `translationReviewed: false`, so the
 * caller can say so out loud. It never translates, and it never returns empty
 * or partial text in place of a disclosure that failed to resolve.
 */
export function getDisclosureText(languageCode: string, baseEnglishText: string): ResolvedDisclosure {
  const lang = findLanguage(languageCode);
  if (!lang?.translationReviewed) {
    return { text: baseEnglishText, translationReviewed: false };
  }
  return { text: REVIEWED_DISCLOSURES[lang.code] ?? baseEnglishText, translationReviewed: true };
}

export interface LanguageSupport {
  readonly code: string;
  readonly translationReviewed: boolean;
  readonly sttLikelySupported: boolean;
}

/**
 * What the portal tells the candidate's browser about this session's language.
 * `code` echoes what the session actually stores — including an unrecognised
 * one — because hiding an unsupported code is the dishonesty this whole module
 * is here to prevent.
 */
export function describeLanguageSupport(languageCode: string): LanguageSupport {
  const lang = findLanguage(languageCode);
  return {
    code: languageCode,
    translationReviewed: lang?.translationReviewed ?? false,
    sttLikelySupported: lang?.sttLikelySupported ?? false,
  };
}
