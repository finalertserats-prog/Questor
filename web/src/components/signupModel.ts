/**
 * The rules behind asking for an account, and the signals the operator's queue
 * derives from a request. Kept free of React so they can be unit tested in the
 * node environment this workspace uses (see web/tests/signupModel.test.ts).
 */

export type SignupMode = 'new-org' | 'join';

export const PASSWORD_MIN_LENGTH = 12;

/**
 * Organisation codes are lowercase letters, digits and hyphens. The same shape
 * the sign-in page accepts for /o/:slug, because it is the same code: someone
 * joining types what their colleagues already sign in with. The pattern is
 * repeated there rather than shared, and the two must move together.
 */
const ORG_CODE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Enough of an address to be worth sending; the server is the real judge. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidOrgCode(code: string): boolean {
  return ORG_CODE.test(code);
}

/** What was typed, in the form the code is actually held in. */
export function normaliseOrgCode(raw: string): string {
  return raw.trim().toLowerCase();
}

export interface SignupForm {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly mode: SignupMode;
  readonly organisationName: string;
  readonly orgCode: string;
}

export interface SignupRequestBody {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly mode: SignupMode;
  readonly organisationName?: string;
  readonly orgCode?: string;
}

/**
 * The first thing stopping this form being sent, as a sentence, or null when it
 * is ready to go.
 *
 * Every check that can be made here is made here, because the server cannot
 * make them: it answers every request identically by design, so it has no way
 * to say "that password is too short" without also having a way to say "that
 * address is already known". The person gets a useful answer only if the page
 * gives it to them before the request leaves.
 */
export function signupFormProblem(form: SignupForm): string | null {
  if (!form.name.trim()) return 'Please tell us your name.';
  if (!EMAIL_SHAPE.test(form.email.trim())) return 'Please enter an email address we can reach you at.';
  if (form.password.length < PASSWORD_MIN_LENGTH) {
    return `Please use a password of at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (form.mode === 'new-org' && !form.organisationName.trim()) {
    return 'Please give the organisation a name.';
  }
  if (form.mode === 'join' && !isValidOrgCode(normaliseOrgCode(form.orgCode))) {
    return 'Organisation codes use lowercase letters, numbers and hyphens, like "acme-hiring".';
  }
  return null;
}

/**
 * The request to send. The mode the person did not choose contributes nothing:
 * an organisation name they typed and then abandoned is not the server's
 * business, and sending it invites the two fields to disagree.
 */
export function signupRequestBody(form: SignupForm): SignupRequestBody {
  const base = {
    // Addresses are trimmed but not lowercased: the local part of an address is
    // the mail host's to interpret, not ours.
    name: form.name.trim(),
    email: form.email.trim(),
    password: form.password,
    mode: form.mode,
  };
  return form.mode === 'new-org'
    ? { ...base, organisationName: form.organisationName.trim() }
    : { ...base, orgCode: normaliseOrgCode(form.orgCode) };
}

/**
 * One sentence saying what an applicant is asking for.
 *
 * The organisation is optional because a response can arrive without it, and a
 * queue that throws rather than saying a little less is a queue nobody can get
 * into Questor through.
 */
export function applicantIntent(mode: SignupMode | null, organisation: string | null | undefined): string {
  const named = (organisation ?? '').trim();
  // A request whose kind did not survive the trip is still a request somebody
  // is waiting on. It says what is known rather than picking a kind.
  if (mode === null) return 'Asking for an account.';
  if (mode === 'new-org') {
    return named ? `Wants to start a new organisation called ${named}.` : 'Wants to start a new organisation.';
  }
  return named ? `Wants to join ${named}.` : 'Wants to join an organisation.';
}

/* --------------------------------------------------------------------------
   Does the address look like it belongs to the organisation?

   A junk request for an existing organisation looks exactly like a real one
   except for this: someone who came by a leaked organisation code signs up from
   whatever mailbox they have. So it is the one signal on the queue worth
   putting in front of the operator.

   It is derived here, on the client, from the email address and the
   organisation's name, because that is all the queue endpoint returns. That
   makes it a heuristic over a display name and nothing more — it is shown as a
   reason to look, never as a verdict, and it belongs on the server as soon as
   the server knows the organisation's real mail domains.
   -------------------------------------------------------------------------- */

export type EmailOrigin = 'matches-organisation' | 'consumer-mailbox' | 'unrelated-domain' | 'unknown';

/** Mailboxes anyone can open in a minute, which no organisation owns. */
const CONSUMER_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'mail.com', 'zoho.com',
  'yandex.com', 'qq.com', '163.com', 'rediffmail.com',
]);

/**
 * Words that appear in company names without identifying anybody. Matching on
 * these would call every address a match — "acme-ltd" and "globex-ltd" share
 * nothing that matters.
 */
const GENERIC_NAME_WORDS = new Set([
  'the', 'and', 'ltd', 'limited', 'inc', 'incorporated', 'llc', 'llp', 'plc', 'gmbh', 'ag', 'bv', 'nv',
  'sa', 'srl', 'spa', 'pty', 'pvt', 'private', 'corp', 'corporation', 'company', 'co', 'group',
  'holdings', 'partners', 'solutions', 'services', 'systems', 'technologies', 'international', 'global',
]);

/** The domain of an email address, lowercased, or null when there is not one. */
export function emailDomain(email: string): string | null {
  const at = email.trim().lastIndexOf('@');
  if (at < 1) return null;
  const domain = email.trim().slice(at + 1).toLowerCase();
  return domain.includes('.') ? domain : null;
}

/** The identifying words of an organisation's name. */
function identifyingWords(organisation: string): string[] {
  return organisation
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !GENERIC_NAME_WORDS.has(word));
}

/** How an applicant's address relates to the organisation they want to join. */
export function joinEmailOrigin(email: string, organisation: string): EmailOrigin {
  const domain = emailDomain(email);
  if (!domain) return 'unknown';
  if (CONSUMER_DOMAINS.has(domain)) return 'consumer-mailbox';

  const words = identifyingWords(organisation);
  // A name made entirely of words like "The Group" tells us nothing, and
  // guessing from it would be worse than staying quiet.
  if (words.length === 0) return 'unknown';

  const flattened = domain.replace(/[^a-z0-9]/g, '');
  return words.some((word) => flattened.includes(word)) ? 'matches-organisation' : 'unrelated-domain';
}

/**
 * What to show beside a request, or null when there is nothing worth saying.
 * Only join requests are checked: someone starting an organisation of their own
 * may use whatever address they like.
 */
export function joinEmailCaution(mode: SignupMode | null, email: string, organisation: string): string | null {
  if (mode !== 'join') return null;
  const origin = joinEmailOrigin(email, organisation);
  const named = organisation.trim() || 'that organisation';
  // Phrased to avoid an article before the organisation's name: "a Acme Corp"
  // and "an Globex" are both wrong and there is no way to know which is which.
  if (origin === 'consumer-mailbox') return `Personal email address, not one at ${named}.`;
  if (origin === 'unrelated-domain') return `Email domain does not look like ${named}.`;
  return null;
}

/* --------------------------------------------------------------------------
   The operator's queue
   -------------------------------------------------------------------------- */

/** One waiting request, in the shape the queue draws. */
export interface QueuedSignup {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  /** Null when the response did not say; the queue then says less, not wrong. */
  readonly mode: SignupMode | null;
  readonly organisation: string;
  readonly createdAt: string;
  /* What a self-serve organisation said on the onboarding form. Absent on a
     join request and on every request made before onboarding existed, so all
     four are optional and a row missing them simply says less. */
  readonly region: { readonly code: string; readonly name: string } | null;
  readonly orgSizeLabel: string;
  readonly businessAreas: readonly { readonly slug: string; readonly name: string }[];
  /** An organisation of this name is already here. The owner's to know, nobody else's. */
  readonly existingOrganisation: string;
}

/** A {slug, name} list, keeping only the entries that have both. */
function namedList(value: unknown): readonly { readonly slug: string; readonly name: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item && typeof item === 'object' ? item as Record<string, unknown> : {}))
    .map((item) => ({ slug: textOf(item.slug), name: textOf(item.name) || textOf(item.slug) }))
    .filter((item) => item.slug !== '');
}

function regionOf(value: unknown): { readonly code: string; readonly name: string } | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const code = textOf(row.code);
  return code ? { code, name: textOf(row.name) || code } : null;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The two kinds of request, or null for anything else. */
function signupMode(value: unknown): SignupMode | null {
  return value === 'new-org' || value === 'join' ? value : null;
}

/**
 * A row of `GET /api/admin/signups`, read rather than assumed.
 *
 * The applicant's details arrive nested under `applicant`, because the
 * "organisation" is `organisationName` for a new organisation and `orgSlug` for
 * a join and only the server can say which. The queue read them from the top
 * level, found `undefined`, and the page fell to its error boundary the first
 * time anyone was waiting in it — with no way back, since "Try again" re-ran
 * the same render. Approving a request is the only door into Questor, so this
 * is the one page that must render whatever it is handed: a row missing a field
 * says less, and a row with no id is left out rather than drawn with an
 * Approve button no decision could be sent for.
 */
export function queuedSignup(raw: unknown): QueuedSignup | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = textOf(row.id);
  if (!id) return null;
  const applicant = (row.applicant && typeof row.applicant === 'object' ? row.applicant : {}) as Record<string, unknown>;
  return {
    id,
    name: textOf(applicant.name) || textOf(row.name),
    email: textOf(applicant.email) || textOf(row.email),
    mode: signupMode(applicant.mode ?? row.mode),
    organisation: textOf(applicant.organisation),
    createdAt: textOf(row.createdAt),
    region: regionOf(row.region),
    orgSizeLabel: textOf(row.orgSizeLabel),
    businessAreas: namedList(row.businessAreas),
    existingOrganisation: textOf(row.existingOrganisation),
  };
}

/** The queue as the page will draw it, with unusable rows left out. */
export function queuedSignups(raw: unknown): QueuedSignup[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(queuedSignup).filter((row): row is QueuedSignup => row !== null);
}

/**
 * How to name an applicant in a sentence addressed to the operator. A request
 * that reached the queue without a name still has to be approvable, and
 * "'s request was approved" names nobody.
 */
export function applicantName(signup: { readonly name: string; readonly email: string }): string {
  return signup.name.trim() || signup.email.trim() || 'This applicant';
}

/** The queue with one request taken out, so the list settles after a decision. */
export function withoutSignup<T extends { readonly id: string }>(signups: readonly T[], id: string): T[] {
  return signups.filter((signup) => signup.id !== id);
}

/* --------------------------------------------------------------------------
   The operator's emailed decision link
   -------------------------------------------------------------------------- */

export type DecisionPhase =
  | 'loading' | 'open' | 'decided' | 'expired' | 'invalid' | 'failed' | 'approved' | 'declined';

/**
 * What a failed call to the decision endpoint means for the page. A link that
 * has been used and a link that has run out are different facts and the
 * operator deserves to be told which — "something went wrong" would leave them
 * pressing a dead button.
 */
export function decisionPhaseForStatus(status: number): DecisionPhase {
  if (status === 404) return 'invalid';
  if (status === 410) return 'expired';
  // 409 means the decision was already made -- by the other link, by another
  // admin, or by this operator in a tab they forgot. Saying so beats reporting
  // a success that did not happen.
  if (status === 409) return 'decided';
  return 'failed';
}
