/**
 * What stands between the public onboarding form and the owner's queue.
 *
 * The form creates a row that a person then has to read. That makes it two
 * things at once: a flood surface (fill the queue so real requests are never
 * seen) and a name-reservation surface (keep re-asking for a competitor's name
 * so theirs looks like the duplicate). Four checks, because they stop four
 * different people.
 *
 * Each limit is decided twice, on purpose. The rows are the durable record —
 * they survive a restart, they hold whatever the deployment's rate-limit store
 * is, and an operator can look at them — but reading a count and then writing
 * against it has a window in the middle that a burst walks straight through.
 * So every limit is also claimed atomically through the shared rate-limit
 * store, whose increment is one write that returns its own count.
 *
 * None of it goes through the request middleware in `middleware/rateLimit.ts`,
 * which is switched off under NODE_ENV=test: that would have left every one of
 * these defences unexercised by the tests that matter most.
 *
 * The IP limiter in `app.ts` stays where it is. It is the cheap first door;
 * this is the one that knows what was asked for.
 */

import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { consume } from '../middleware/rateLimit.js';
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

  const key = input.mode === 'new-org' && input.organisationName ? orgNameKey(input.organisationName) : '';
  if (key) {
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

  return closeTheRace(email, domain, key);
}

/**
 * A minute. Everything above is the real limit, measured in rows over a day;
 * this only has to cover the gap between reading a count and writing the row
 * that count will include, and requests that race are milliseconds apart.
 *
 * Short on purpose. A claim is spent whether or not the row it was for ends up
 * standing — the operator-notice failure path deletes the row it just made —
 * and a claim that outlived its request by a day would lock a real applicant,
 * or a whole organisation name, out of a form because the mail server was
 * down. Outliving it by a minute costs nobody anything.
 */
const RACE_GUARD_MS = 60_000;

/**
 * The same limits again, as atomic claims rather than as reads.
 *
 * The counts above are read, judged, and only then written against — three
 * requests arriving together all read a count below the limit and all get
 * through. The rows stay the durable record; this closes the window in the
 * middle, through the shared rate-limit store, whose increment is one write
 * that returns the count it produced (middleware/rateLimitStores.ts). In
 * production that store is the database, so the claim holds across instances.
 *
 * The organisation name goes first, and that order is the whole point: a
 * suppressed duplicate must not spend the address's allowance. It creates no
 * row, so the row-backed check would never see it again — the allowance would
 * simply have gone, invisibly, and an attacker holding a name in cooldown
 * could have spent a stranger's allowance by submitting their address.
 */
async function closeTheRace(email: string, domain: string, orgKey: string): Promise<SignupGuardVerdict> {
  if (orgKey) {
    const held = await consume('signup-org-name-race', orgKey, RACE_GUARD_MS, 1, { failClosed: true });
    // Suppressed, not refused, so that which of the two checks noticed — this
    // one or the row-backed cooldown above — is not visible from outside.
    if (!held.allowed) return { kind: 'silently-drop', reason: 'org_name_cooldown_race' };
  }

  const claims = [
    { name: 'signup-email-race', key: email, max: MAX_REQUESTS_PER_EMAIL_PER_DAY },
    ...(domain ? [{ name: 'signup-email-domain-race', key: domain, max: MAX_REQUESTS_PER_EMAIL_DOMAIN_PER_DAY }] : []),
  ];
  for (const claim of claims) {
    const verdict = await consume(claim.name, claim.key, RACE_GUARD_MS, claim.max, { failClosed: true });
    if (!verdict.allowed) return { kind: 'refuse', status: 429, message: TOO_MANY, reason: claim.name };
  }
  return { kind: 'allow' };
}

/**
 * Whether to send the courtesy acknowledgement for a request that was
 * suppressed rather than created.
 *
 * It has to be sent, or the email that never arrives answers the question the
 * identical response refuses to. But a suppressed request writes no row, so
 * nothing else bounds it: without this, anyone could point the form at a
 * stranger's address with an organisation name they knew was in cooldown and
 * send them mail all day, with nothing appearing in any queue.
 *
 * Its own budget, not the applicant's, and set to the same number of messages
 * a day that a created request would have earned — so the volume a watcher
 * sees is the same either way, and neither path is the quiet one.
 */
export async function mayAcknowledgeSuppressed(email: string): Promise<boolean> {
  const verdict = await consume('signup-suppressed-ack', email.trim().toLowerCase(), DAY_MS, MAX_REQUESTS_PER_EMAIL_PER_DAY, { failClosed: true });
  return verdict.allowed;
}

/**
 * Organisation names on the platform, by their comparison key.
 *
 * Built once for a whole queue rather than per row: matching has to normalise
 * both sides (see `orgNameKey`), so it cannot be a database comparison, and
 * doing it per request would read every tenant once per row in the queue.
 */
export async function organisationNameIndex(): Promise<ReadonlyMap<string, string>> {
  const tenants = await prisma.tenant.findMany({ where: { isDemo: false }, select: { name: true } });
  const index = new Map<string, string>();
  for (const tenant of tenants) {
    const key = orgNameKey(tenant.name);
    if (key && !index.has(key)) index.set(key, tenant.name);
  }
  return index;
}

/**
 * Whether an organisation with a matching name is already on the platform.
 *
 * Shown to the owner in the queue and to nobody else — it is exactly the fact
 * the public form must never confirm, and exactly the fact the person deciding
 * needs in front of them.
 */
export function existingOrganisationMatch(
  organisationName: string,
  index: ReadonlyMap<string, string>,
): string | null {
  const key = orgNameKey(organisationName);
  return key ? index.get(key) ?? null : null;
}
