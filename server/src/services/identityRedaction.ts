/**
 * Removing the identifiers Questor holds about a candidate from free text.
 *
 * This module does the half of anonymisation that can be done RELIABLY. We know
 * the candidate's name, address, phone and LinkedIn URL exactly, so we can find
 * them wherever they were written or spoken — including inside a transcript,
 * which is where people put their own name without anyone asking.
 *
 * It does NOT do the half that cannot be done reliably. A transcript names
 * former employers, managers, universities and towns, and no list we hold can
 * find those. Nothing here should be read as a claim that it does; see
 * services/anonymise.ts for what is said out loud about the residual risk.
 *
 * TRADE-OFF, stated rather than hidden: matching is case-insensitive and covers
 * each part of the name on its own, so a candidate named Will or Grace loses
 * that word everywhere it appears in their transcript, including where it was
 * an ordinary English word. That is deliberate. The requirement here is
 * irreversibility, and over-redaction fails safe while under-redaction leaves
 * the person in the data and the word "anonymised" untrue. The damage is
 * bounded — one word becomes "[name]" in one candidate's transcript, and the
 * scores, structure and competency reads the interview is kept for are
 * untouched.
 */

/**
 * What a redacted identifier becomes. Readable placeholders rather than blanks:
 * a reader six months from now needs to see that something was removed and what
 * kind of thing it was, or they will read a mangled sentence as the model
 * behaving oddly. They carry no information about the person.
 */
export const NAME_PLACEHOLDER = '[name]';
export const EMAIL_PLACEHOLDER = '[email]';
export const PHONE_PLACEHOLDER = '[phone]';
export const LINK_PLACEHOLDER = '[link]';

/**
 * The identifiers that belong to exactly one person. No name.
 *
 * Split from `KnownIdentity` so that a function which must not touch names
 * cannot be handed one. `redactHandlesOnly` takes this, so passing a whole
 * candidate to it — and quietly reintroducing name matching into text shared
 * with other people — will not compile.
 */
export interface ContactIdentity {
  readonly email: string;
  readonly emailNormalized: string;
  readonly phone: string;
  readonly linkedinUrl: string;
}

/** The identifiers we hold for one candidate, exactly as the Candidate row stores them. */
export interface KnownIdentity extends ContactIdentity {
  readonly fullName: string;
}

/**
 * Titles are dropped when splitting a name into parts. A name field of
 * "Ms Kajal Vishwakarma" must not turn every "Ms" in the transcript into a
 * placeholder: a bare honorific identifies nobody, and redacting it would cost
 * transcript for no gain.
 */
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'sir', 'madam', 'shri', 'smt']);

/**
 * Shortest digit run we will treat as a phone number. Below this it is a
 * quantity, a year or a port, and redacting it would silently damage answers
 * about the very engineering work the interview is kept to study.
 */
const MIN_PHONE_DIGITS = 7;

/** Separators a phone number is written with between its digits, at most two in a row. */
const PHONE_GAP = String.raw`[\s().+\-]{0,2}`;

/**
 * Unicode-aware word boundaries. JavaScript's \b is ASCII-only, so "José"
 * followed by a space is a boundary but "José" itself contains one — a name
 * with an accent in it would be matched in the wrong places or not at all.
 */
const BEFORE = String.raw`(?<![\p{L}\p{N}_])`;
const AFTER = String.raw`(?![\p{L}\p{N}_])`;

/**
 * Shortest profile slug worth matching on its own. Below this it is not
 * distinctive enough to be safe — a four-letter slug could be a word.
 */
export const MIN_SLUG = 6;

/**
 * The distinctive part of a LinkedIn profile URL, or "" when there is not one
 * long enough to be safe.
 *
 * Shared with services/auditPayloads.ts so both the kept prose and the audit
 * payloads recognise a profile by the same rule. Matching the stored URL
 * literally was the original mistake: `http` for `https`, a trailing slash or
 * a `?utm_source=` on the end and it stops matching, and a candidate who types
 * the slug on its own into a transcript is not matched at all.
 */
export function linkedinSlug(url: string): string {
  const slug = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(url)?.[1] ?? '';
  return slug.length >= MIN_SLUG ? slug : '';
}

const escape = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

interface Needle {
  readonly pattern: RegExp;
  readonly replacement: string;
}

/** The parts of a name worth matching on their own: no titles, nothing shorter than two letters. */
function nameParts(fullName: string): readonly string[] {
  return fullName
    .split(/[\s.,\-–—]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && !HONORIFICS.has(part.toLowerCase()));
}

function nameNeedles(fullName: string): readonly Needle[] {
  const parts = nameParts(fullName);
  if (parts.length === 0) return [];

  // The whole name first, so "Kajal Vishwakarma" becomes one placeholder rather
  // than two — a sentence full of "[name] [name]" reads as though the system is
  // broken, and a reader cannot tell one redaction from two.
  const whole: readonly Needle[] = parts.length > 1
    ? [{
      pattern: new RegExp(`${BEFORE}${parts.map(escape).join(String.raw`[\s.\-]+`)}${AFTER}`, 'giu'),
      replacement: NAME_PLACEHOLDER,
    }]
    : [];

  // Then each part alone, longest first, so a surname is not half-eaten by a
  // shorter part that happens to be a prefix of it.
  const singles = [...parts]
    .sort((a, b) => b.length - a.length)
    .map((part) => ({ pattern: new RegExp(`${BEFORE}${escape(part)}${AFTER}`, 'giu'), replacement: NAME_PLACEHOLDER }));

  return [...whole, ...singles];
}

/**
 * Match a phone number by its DIGITS, not by the string we stored.
 *
 * Nobody writes a number back the way it went into the database. "+91 98765
 * 43210" is said as "9876543210" and typed as "+91-98765-43210", and a literal
 * match would find none of them. The digits are matched in order with the
 * separators people actually use between them.
 *
 * A number longer than ten digits also gets a pattern for its last ten, because
 * the country code is the part people leave off. Bounded on both sides so a
 * number is never matched inside a longer run of digits.
 */
function phoneNeedles(phone: string): readonly Needle[] {
  const digits = phone.replace(/\D/gu, '');
  if (digits.length < MIN_PHONE_DIGITS) return [];

  const runs = digits.length > 10 ? [digits, digits.slice(-10)] : [digits];
  return runs.map((run) => ({
    pattern: new RegExp(String.raw`(?<![0-9])\+?${run.split('').join(PHONE_GAP)}(?![0-9])`, 'gu'),
    replacement: PHONE_PLACEHOLDER,
  }));
}

/**
 * Match the profile by its slug, in every shape it is written in.
 *
 * Any scheme, any subdomain, any trailing path or query — and the bare slug on
 * its own, because "my LinkedIn is priya-sharma-4417" is a sentence people say.
 * A stored URL with no usable slug falls back to matching the literal string,
 * which is all there is to go on.
 */
function linkedinNeedles(linkedinUrl: string): readonly Needle[] {
  const url = linkedinUrl.trim();
  if (!url) return [];
  const slug = linkedinSlug(url);
  if (!slug) return [{ pattern: new RegExp(escape(url), 'giu'), replacement: LINK_PLACEHOLDER }];
  return [
    // The full URL first, so a link becomes one placeholder rather than a
    // scheme followed by one.
    {
      pattern: new RegExp(String.raw`(?:https?:\/\/)?(?:[\w-]+\.)*linkedin\.com\/in\/${escape(slug)}[^\s"'<>)\]]*`, 'giu'),
      replacement: LINK_PLACEHOLDER,
    },
    // Then the slug alone. Hyphens count as part of the token, so a slug is
    // never matched inside a longer hyphenated string.
    {
      pattern: new RegExp(`(?<![\p{L}\p{N}_-])${escape(slug)}(?![\p{L}\p{N}_-])`, 'giu'),
      replacement: LINK_PLACEHOLDER,
    },
  ];
}

/**
 * Every pattern that removes this candidate, in the order it must be applied.
 *
 * ORDER IS LOAD-BEARING. The address contains the name
 * ("kajal.vishwakarma@example.com"), so redacting the name first would leave
 * "[name].[name]@example.com" — which the address pattern can then no longer
 * match, and which still says the domain the person works at. Longest and most
 * structured identifiers go first; the loose name parts go last.
 */
export function identityNeedles(identity: KnownIdentity): readonly Needle[] {
  return [...handleNeedles(identity), ...nameNeedles(identity.fullName)];
}

/**
 * The identifiers that belong to exactly one person: the LinkedIn profile, the
 * address, the phone number. Everything except the name.
 *
 * Separated out because there are places where the name must NOT be redacted —
 * free text on a row shared by many candidates, where matching a name part
 * would mangle everybody else's record to satisfy one person's timer ("grace
 * under pressure" is not a candidate called Grace). A handle has no such
 * problem: it is unique, so removing it takes nothing from anyone else.
 */
export function handleNeedles(identity: ContactIdentity): readonly Needle[] {
  // Both spellings of the address: the stored one and the normalised one may
  // differ in case, and either may be the form that ended up in the text.
  const emails = [...new Set([identity.email, identity.emailNormalized].map((e) => e.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);

  return [
    ...linkedinNeedles(identity.linkedinUrl),
    ...emails.map((email) => ({ pattern: new RegExp(escape(email), 'giu'), replacement: EMAIL_PLACEHOLDER })),
    ...phoneNeedles(identity.phone),
  ];
}

/**
 * Remove only the unique handles, leaving the name in place.
 *
 * For text that is not this candidate's to rewrite — a calibration theme, an
 * import batch's record — where taking out an address harms nobody and taking
 * out a name would.
 */
export function redactHandlesOnly(text: string, identity: ContactIdentity): string {
  if (!text) return text;
  return handleNeedles(identity).reduce((redacted, n) => redacted.replace(n.pattern, n.replacement), text);
}

/**
 * Remove every identifier we hold for this candidate from `text`.
 *
 * Idempotent: the placeholders contain none of the patterns, so a second pass
 * over already-redacted text changes nothing. That matters because a sweep that
 * fails part-way is re-run, and a redaction that compounded on each attempt
 * would eat the transcript one retry at a time.
 *
 * Safe on JSON: it substitutes inside string values and the placeholders need
 * no escaping, so a scrubbed JSON column still parses. Most of what has to be
 * scrubbed here is a JSON column.
 */
export function redactIdentity(text: string, identity: KnownIdentity): string {
  if (!text) return text;
  return identityNeedles(identity).reduce(
    (redacted, needle) => redacted.replace(needle.pattern, needle.replacement),
    text,
  );
}

/** Whether we hold anything to redact. A candidate with no identifiers needs no pass. */
export function hasRedactableIdentity(identity: KnownIdentity): boolean {
  return identityNeedles(identity).length > 0;
}
