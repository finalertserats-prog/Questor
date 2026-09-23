/**
 * What stands between the public onboarding form and the owner's queue.
 *
 * The form creates a row that a person then has to read. That makes it two
 * things at once: a flood surface (fill the queue so real requests are never
 * seen) and a name-reservation surface (keep re-asking for a competitor's name
 * so theirs looks like the duplicate). Four checks, because they stop four
 * different people.
 *
 * All of it is decided from the database rather than the in-process rate
 * limiter: these limits have to hold across instances and across restarts, and
 * the request limiter in `middleware/rateLimit.ts` is switched off under test,
 * which would have left the defences unexercised by every test that matters.
 *
 * The IP limiter in `app.ts` stays where it is. It is the cheap first door;
 * this is the one that knows what was asked for.
 */

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import {
  DAY_MS, MAX_PENDING_REQUESTS, MAX_REQUESTS_PER_EMAIL_PER_DAY,
  MAX_REQUESTS_PER_EMAIL_DOMAIN_PER_DAY, ORG_NAME_COOLDOWN_HOURS,
  emailDomainOf, orgNameKey,
} from '../domain/orgOnboarding.js';

/**
 * Deliberately generic, and deliberately the same text the limiter in
 * `middleware/rateLimit.ts` uses. Which of the limits was hit is not the
 * applicant's business, and saying would tell a prober which knob to turn.
 */
const TOO_MANY = 'Too many requests. Please wait a moment and try again.';
const UNAVAILABLE = 'Signup is temporarily unavailable.';

export type SignupGuardVerdict =
  | { readonly kind: 'allow' }
  /**
   * Answer exactly as a successful request is answered, and create nothing.
   *
   * This is the only honest response to "has someone already asked for this
   * organisation name?": a 409, a different message, or even a different
   * status code would answer it. The applicant sees the same "your request has
   * been sent" page either way.
   */
  | { readonly kind: 'silently-drop'; readonly reason: string }
  | { readonly kind: 'refuse'; readonly status: number; readonly message: string; readonly reason: string };

export interface SignupGuardInput {
  readonly email: string;
  readonly mode: 'new-org' | 'join';
  readonly organisationName?: string;
  readonly now?: Date;
}

/**
 * Whether this request may be created, and on what terms.
 *
 * Checked in the order that reveals least: the two volume limits answer before
 * the name check, so a prober measuring responses runs into an undifferentiated
 * wall rather than into a signal about one name.
 */
export async function guardSignupRequest(input: SignupGuardInput): Promise<SignupGuardVerdict> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - DAY_MS);
  const email = input.email.trim().toLowerCase();
  const domain = emailDomainOf(email);

  // The queue is a person's working list, not a log. Past a point, one more row
  // does not get read — it buries the ones that would have been.
  const pending = await prisma.signupRequest.count({ where: { status: 'PENDING' } });
  if (pending >= MAX_PENDING_REQUESTS) {
    logger.warn({ pending }, 'Signup requests refused: the approval queue is full');
    return { kind: 'refuse', status: 503, message: UNAVAILABLE, reason: 'queue_full' };
  }

  const fromEmail = await prisma.signupRequest.count({ where: { email, createdAt: { gte: since } } });
  if (fromEmail >= MAX_REQUESTS_PER_EMAIL_PER_DAY) {
    return { kind: 'refuse', status: 429, message: TOO_MANY, reason: 'email_rate' };
  }

  // One domain, many addresses: the shape of a script working through
  // first.last@ at a company, and of a competitor using colleagues' addresses.
  if (domain) {
    const fromDomain = await prisma.signupRequest.count({ where: { emailDomain: domain, createdAt: { gte: since } } });
    if (fromDomain >= MAX_REQUESTS_PER_EMAIL_DOMAIN_PER_DAY) {
      return { kind: 'refuse', status: 429, message: TOO_MANY, reason: 'email_domain_rate' };
    }
  }

  if (input.mode === 'new-org' && input.organisationName) {
    const key = orgNameKey(input.organisationName);
    const cooldownSince = new Date(now.getTime() - ORG_NAME_COOLDOWN_HOURS * 60 * 60_000);
    const recent = await prisma.signupRequest.findFirst({
      where: { orgNameKey: key, createdAt: { gte: cooldownSince } },
      select: { id: true },
    });
    if (recent) {
      logger.info({ signupRequestId: recent.id }, 'Signup request not created: an organisation name asked for again inside its cooldown');
      return { kind: 'silently-drop', reason: 'org_name_cooldown' };
    }
  }

  return { kind: 'allow' };
}

/**
 * Whether an organisation with a matching name is already on the platform.
 *
 * Shown to the owner in the queue and to nobody else — it is exactly the fact
 * the public form must never confirm, and exactly the fact the person deciding
 * needs in front of them.
 */
export async function existingOrganisationMatch(organisationName: string): Promise<string | null> {
  const key = orgNameKey(organisationName);
  if (!key) return null;
  const tenants = await prisma.tenant.findMany({ where: { isDemo: false }, select: { name: true } });
  return tenants.find((t) => orgNameKey(t.name) === key)?.name ?? null;
}
