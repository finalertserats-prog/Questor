/**
 * Inviting a colleague, kept free of React so it can be unit tested in the node
 * environment this workspace uses (web/tests/inviteModel.test.ts).
 */

/**
 * The roles an admin may invite somebody into, in the order the form offers
 * them, with the sentence that says what each one can do.
 *
 * Mirrors the capability map in server/src/domain/capabilities.ts. The two
 * workspaces share no code, so there is one copy on each side and they move
 * together — a role offered here that the server does not recognise would mail
 * somebody an invitation to an account with no capabilities at all, which is
 * not broken loudly but silently powerless.
 */
export const INVITABLE_ROLES = [
  { value: 'recruiter', label: 'Recruiter', blurb: 'Runs requisitions and the candidates on them.' },
  { value: 'manager', label: 'Hiring manager', blurb: 'Approves scorecards and signs off assessments.' },
  { value: 'reviewer', label: 'Reviewer', blurb: 'Reviews assessments, and nothing else.' },
  { value: 'sme', label: 'Subject-matter expert', blurb: 'Sees only the candidates they are asked to assess, and recommends. They move nobody.' },
  { value: 'auditor', label: 'Auditor', blurb: 'Sees that things happened, not candidate detail.' },
  { value: 'admin', label: 'Admin', blurb: 'Everything above, plus people, settings and the audit log.' },
] as const;

export type InvitableRole = (typeof INVITABLE_ROLES)[number]['value'];

export function isInvitableRole(value: string): value is InvitableRole {
  return INVITABLE_ROLES.some((role) => role.value === value);
}

/** What a role means, for the line under the picker. */
export function roleBlurb(value: string): string {
  return INVITABLE_ROLES.find((role) => role.value === value)?.blurb ?? '';
}

/**
 * A role in the words the product uses for it.
 *
 * Not `humanise(role)`, which title-cases the stored value: that turns `sme`
 * into "Sme" and `manager` into "Manager" where the product says "Hiring
 * manager". A stored value nothing here recognises still falls back to the
 * title-cased form rather than to a blank cell.
 */
export function roleLabel(value: string): string {
  const known = INVITABLE_ROLES.find((role) => role.value === value);
  if (known) return known.label;
  const words = value.replace(/_/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Enough of an address to be worth sending; the server is the real judge. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** One sentence naming what is wrong with the invitation form, or null. */
export function inviteFormProblem(name: string, email: string, role: string): string | null {
  if (!name.trim()) return 'Who is this for? A name goes in the invitation they receive.';
  if (!EMAIL_SHAPE.test(email.trim())) return 'Please enter the email address to send the invitation to.';
  if (!isInvitableRole(role)) return 'Choose what this colleague will be able to do.';
  return null;
}

/**
 * What a dead invitation says. The same for expired, withdrawn and never-issued.
 *
 * Any difference between the three would turn guessing at links into
 * confirming that an address was once invited.
 */
export const INVITE_DEAD_MESSAGE =
  'This invitation is no longer valid. It may have expired, already been used, or been withdrawn. Ask whoever invited you to send a new one.';

/**
 * How long is left on a pending invitation, in words.
 *
 * Days rather than a date, because what an admin is deciding is whether to
 * chase or to reissue, and "2 days left" answers that where "expires on the
 * 27th" makes them count.
 */
export function inviteExpiryLabel(expiresAt: string, now: Date = new Date()): string {
  const left = new Date(expiresAt).getTime() - now.getTime();
  if (Number.isNaN(left)) return '';
  if (left <= 0) return 'Expired';
  const days = Math.floor(left / (24 * 60 * 60_000));
  if (days >= 2) return `${days} days left`;
  const hours = Math.floor(left / (60 * 60_000));
  if (hours >= 1) return `${hours} ${hours === 1 ? 'hour' : 'hours'} left`;
  // Not "0 hours left", which reads as expired when it is not.
  return 'Less than an hour left';
}
