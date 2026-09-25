import { prisma, parseJsonOptional } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getEmail } from '../providers/email/index.js';
import { buildDigestEmail } from '../providers/email/digestEmail.js';
import { capabilitiesOf, ROLES } from '../domain/capabilities.js';
import { startJob, type LeaseHandle } from './jobs.js';
import { DEFAULT_ORG_TIME_ZONE, effectiveOrgTimeZone } from './tenantTimeZone.js';
import { isKnownTimeZone } from './roundTime.js';
import { zonedWallClock } from './zonedTime.js';
import { collectNeedsYou } from './needsYouRows.js';
import type { NeedsYouAction } from '../domain/needsYou.js';

/** A row's destination as a whole URL. Most are paths; a meeting is not. */
function hrefFor(action: NeedsYouAction, origin: string): string | null {
  if (!action.to) return null;
  return action.external ? action.to : `${origin}${action.to}`;
}

/**
 * HR-Box daily summary (DIGEST_ENABLED, off by default).
 *
 * Once a day, from DIGEST_HOUR on the READER's own clock, each HR user who can
 * read candidates and has not switched it off gets the rows of their "Needs
 * you" queue by email. Nothing waiting, no email. A DigestDelivery row per user
 * per reader day is claimed before sending, so a restart or a second instance
 * never mails the same summary twice.
 *
 * The reader's clock rather than the organisation's, because it used to be the
 * organisation's: a recruiter or an expert in London attached to an India-based
 * organisation had their "morning summary" delivered at about half past two in
 * the morning, and the "today" in it meant Bengaluru's today. The whole point of
 * a morning summary is that it is read in the morning. A user who has not set a
 * zone still falls back to the organisation's — and the email says so, rather
 * than leaving them to assume it is theirs.
 */

export const DIGEST_JOB = { name: 'daily-digest', intervalMs: 15 * 60_000, ttlMs: 10 * 60_000 } as const;
/** Rows written into the email; the rest are counted and left to the Home page. */
export const DIGEST_ROW_LIMIT = 10;
/** Users considered per run; a large deployment finishes over a few runs. */
const USERS_PER_RUN = 100;

/**
 * A morning summary that missed its morning (the server was down) is dropped,
 * not sent at night: it may go only this many hours after DIGEST_HOUR, and
 * never past midnight, since it is that organisation day's summary. A late
 * DIGEST_HOUR (say 22) therefore has a shorter window, not one into tomorrow.
 */
const DIGEST_WINDOW_HOURS = 6;

/**
 * How recently a summary must NOT have gone out for another to be allowed.
 *
 * The once-a-day claim is keyed on the reader's own calendar date, which is
 * what makes "today" mean their today — but a calendar date is not monotonic
 * when the person carrying it gets on a plane. Flying east their local date
 * jumps forward, which is a brand-new key hours after the last summary went
 * out, and the claim alone would let a second one through the same morning.
 *
 * Derived from the window rather than picked: the tightest legitimate pair of
 * mornings is the last moment of one day's window and the first of the next,
 * which is 24 - DIGEST_WINDOW_HOURS apart. Staying an hour inside that can
 * never block a first summary and always blocks a second.
 */
const RESEND_COOLDOWN_MS = (24 - DIGEST_WINDOW_HOURS - 1) * 3_600_000;

/** The organisation's day ("YYYY-MM-DD") while its summary window is open there, else null. */
export function digestDayFor(now: Date, timeZone: string, hour: number): string | null {
  const wall = zonedWallClock(now, timeZone);
  const local = Number(wall.slice(11, 13));
  return local >= hour && local < Math.min(hour + DIGEST_WINDOW_HOURS, 24) ? wall.slice(0, 10) : null;
}

interface Recipient {
  readonly id: string;
  readonly tenantId: string;
  readonly role: string;
  readonly email: string;
  readonly name: string;
  /** The reader's own calendar day, which is what "today" in the summary means. */
  readonly day: string;
  readonly timeZone: string;
  /** True when the zone above is the organisation's, because they have set none. */
  readonly orgClock: boolean;
}

async function recipients(now: Date, limit: number): Promise<Recipient[]> {
  const tenants = await prisma.tenant.findMany({ where: { isDemo: false }, select: { id: true, policyJson: true } });
  const orgZoneOf = new Map<string, string>();
  for (const t of tenants) {
    orgZoneOf.set(t.id, effectiveOrgTimeZone(parseJsonOptional<{ timeZone?: unknown }>(t.policyJson, {}, { model: 'Tenant', id: t.id, field: 'policyJson' })));
  }
  if (orgZoneOf.size === 0) return [];
  // Every organisation, not only the ones whose own window is open: a reader's
  // morning is no longer required to coincide with their employer's. The list
  // is narrowed per user below, and USERS_PER_RUN still caps what one run sends.
  //
  // Over ROLES rather than over a hand-written list of four. The capability
  // filter was doing nothing: it can only remove from whatever it is given, so
  // the four were the rule and the filter was decoration — and a role added
  // later was silently left out of the digest however many capabilities it
  // held. Derived from the set, the rule is the rule. The answer today is the
  // same four names; `auditor` and `sme` are excluded because neither holds
  // `candidate:read`, which is the reason rather than the coincidence.
  const readers = ROLES.filter((role) => capabilitiesOf(role).includes('candidate:read'));
  const users = await prisma.user.findMany({
    where: { tenantId: { in: [...orgZoneOf.keys()] }, digestOptOut: false, role: { in: readers } },
    orderBy: { id: 'asc' },
    // Ordered by when it was claimed, not by its date string: the date string
    // is the reader's local one and can go backwards when they move zones, so
    // "the newest" has to be asked of the clock rather than of the calendar.
    select: { id: true, tenantId: true, role: true, email: true, name: true, timeZone: true, digestDeliveries: { orderBy: { claimedAt: 'desc' }, take: 1, select: { day: true, claimedAt: true } } },
  });
  return users
    .map((u) => {
      const own = u.timeZone && isKnownTimeZone(u.timeZone) ? u.timeZone : null;
      const timeZone = own ?? orgZoneOf.get(u.tenantId) ?? DEFAULT_ORG_TIME_ZONE;
      return {
        id: u.id, tenantId: u.tenantId, role: u.role, email: u.email, name: u.name,
        timeZone, orgClock: own === null,
        // digestDayFor is unchanged: still six hours wide, still never across
        // the day's own midnight. It is measured on the reader's clock now
        // rather than their employer's, which is the only thing that moved.
        day: digestDayFor(now, timeZone, config.hrBox.digestHour) ?? '',
        lastClaimedAt: u.digestDeliveries[0]?.claimedAt ?? null,
      };
    })
    // Two conditions, and neither is an ordering of date strings. The claim on
    // (userId, day) is what makes it at most one per reader per local day —
    // that is enforced by the database, not here (see `claim`). This only adds
    // the cooling-off period, which is what a local date cannot express,
    // because a reader who changes zone changes what their dates mean.
    //
    // The previous `last < day` compared two local date strings and assumed
    // they only ever move forward. They do not: flying west makes today's
    // string SMALLER than the one already claimed, and the reader was then
    // skipped until the calendar caught up.
    .filter((u) => u.day && (u.lastClaimedAt === null || now.getTime() - u.lastClaimedAt.getTime() >= RESEND_COOLDOWN_MS))
    .slice(0, limit)
    .map(({ lastClaimedAt: _lastClaimedAt, ...u }) => u);
}

/**
 * `claimedAt` is the run's own instant, not the database's default.
 *
 * The cooling-off period is measured against it, and the run already carries
 * the clock every other decision here is made on — leaving the two to separate
 * sources would make "has a summary gone out recently" answerable differently
 * from "is it morning for this reader", which is how a job becomes untestable
 * and, worse, inconsistent across a clock skew between app and database.
 */
async function claim(user: Recipient, now: Date): Promise<string | null> {
  try {
    const row = await prisma.digestDelivery.create({ data: { userId: user.id, tenantId: user.tenantId, day: user.day, claimedAt: now }, select: { id: true } });
    return row.id;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'P2002') return null;
    throw err;
  }
}

async function sendOne(user: Recipient, now: Date): Promise<'sent' | 'empty' | 'failed' | 'taken'> {
  // They may have switched it off since the list was read.
  const still = await prisma.user.findFirst({ where: { id: user.id, digestOptOut: false }, select: { id: true } });
  if (!still) return 'taken';
  const id = await claim(user, now);
  if (!id) return 'taken';
  const auth = { userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email };
  const { total, rows } = await collectNeedsYou(auth, now, DIGEST_ROW_LIMIT);
  if (total === 0) {
    await prisma.digestDelivery.update({ where: { id }, data: { status: 'empty' } });
    return 'empty';
  }
  const origin = config.webOrigin.replace(/\/+$/, '');
  const message = buildDigestEmail({
    userName: user.name, total, now,
    timeZone: user.timeZone, onOrgClock: user.orgClock,
    homeUrl: `${origin}/?tab=home`, settingsUrl: `${origin}/settings`,
    rows: rows.slice(0, DIGEST_ROW_LIMIT).map((r) => ({
      kind: r.kind, urgent: r.urgent, who: r.candidate?.name ?? r.subject ?? '', role: r.role?.title ?? null,
      // An external destination is already a whole URL — the meeting the round
      // is held in. Prefixing the origin would have produced a link to nothing.
      since: new Date(r.since), href: hrefFor(r.action, origin),
    })),
  });
  try {
    await getEmail().send({ ...message, to: user.email });
    await prisma.digestDelivery.update({ where: { id }, data: { status: 'sent', rowCount: total, sentAt: new Date() } });
    return 'sent';
  } catch (err) {
    logger.warn({ userId: user.id, err: err instanceof Error ? err.message : String(err) }, 'Daily summary not sent');
    await prisma.digestDelivery.update({ where: { id }, data: { status: 'failed', rowCount: total } });
    return 'failed';
  }
}

export async function runDailyDigest(lease: LeaseHandle | null = null, now: Date = new Date()): Promise<string> {
  if (!getEmail().delivers) return 'email does not deliver; nothing claimed';
  const tally = { sent: 0, empty: 0, failed: 0, taken: 0 };
  for (const user of await recipients(now, USERS_PER_RUN)) {
    if (lease && !(await lease.renew(DIGEST_JOB.ttlMs))) break;
    tally[await sendOne(user, now)] += 1;
  }
  return `digest: ${tally.sent} sent, ${tally.empty} nothing waiting, ${tally.failed} failed`;
}

export function startDailyDigest(): (() => void) | null {
  if (!config.hrBox.digestEnabled) return null;
  return startJob({ ...DIGEST_JOB, delayFirst: true, fn: (lease) => runDailyDigest(lease) });
}
