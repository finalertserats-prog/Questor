import { prisma, parseJsonOptional } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getEmail } from '../providers/email/index.js';
import { buildDigestEmail } from '../providers/email/digestEmail.js';
import { capabilitiesOf } from '../domain/capabilities.js';
import { startJob, type LeaseHandle } from './jobs.js';
import { effectiveOrgTimeZone } from './tenantTimeZone.js';
import { zonedWallClock } from './zonedTime.js';
import { collectNeedsYou } from './needsYouRows.js';

/**
 * HR-Box daily summary (DIGEST_ENABLED, off by default).
 *
 * Once a day, from DIGEST_HOUR on the organisation's own clock, each HR user
 * who can read candidates and has not switched it off gets the rows of their
 * "Needs you" queue by email. Nothing waiting, no email. A DigestDelivery row
 * per user per organisation day is claimed before sending, so a restart or a
 * second instance never mails the same summary twice.
 */

export const DIGEST_JOB = { name: 'daily-digest', intervalMs: 15 * 60_000, ttlMs: 10 * 60_000 } as const;
/** Rows written into the email; the rest are counted and left to the Home page. */
export const DIGEST_ROW_LIMIT = 10;
/** Users considered per run; a large deployment finishes over a few runs. */
const USERS_PER_RUN = 100;

/**
 * A morning summary that missed its morning (the server was down) is dropped,
 * not sent at night: it may go only this many hours after DIGEST_HOUR.
 */
const DIGEST_WINDOW_HOURS = 6;

/** The organisation's day ("YYYY-MM-DD") while its summary window is open there, else null. */
export function digestDayFor(now: Date, timeZone: string, hour: number): string | null {
  const wall = zonedWallClock(now, timeZone);
  const local = Number(wall.slice(11, 13));
  return local >= hour && local < hour + DIGEST_WINDOW_HOURS ? wall.slice(0, 10) : null;
}

interface Recipient { readonly id: string; readonly tenantId: string; readonly role: string; readonly email: string; readonly name: string; readonly day: string }

async function recipients(now: Date, limit: number): Promise<Recipient[]> {
  const tenants = await prisma.tenant.findMany({ where: { isDemo: false }, select: { id: true, policyJson: true } });
  const dayOf = new Map<string, string>();
  for (const t of tenants) {
    const zone = effectiveOrgTimeZone(parseJsonOptional<{ timeZone?: unknown }>(t.policyJson, {}, { model: 'Tenant', id: t.id, field: 'policyJson' }));
    const day = digestDayFor(now, zone, config.hrBox.digestHour);
    if (day) dayOf.set(t.id, day);
  }
  if (dayOf.size === 0) return [];
  const readers = ['recruiter', 'manager', 'reviewer', 'admin'].filter((role) => capabilitiesOf(role).includes('candidate:read'));
  const users = await prisma.user.findMany({
    where: { tenantId: { in: [...dayOf.keys()] }, digestOptOut: false, role: { in: readers } },
    orderBy: { id: 'asc' },
    select: { id: true, tenantId: true, role: true, email: true, name: true, digestDeliveries: { orderBy: { day: 'desc' }, take: 1, select: { day: true } } },
  });
  return users
    .map((u) => ({ id: u.id, tenantId: u.tenantId, role: u.role, email: u.email, name: u.name, day: dayOf.get(u.tenantId) ?? '', last: u.digestDeliveries[0]?.day ?? '' }))
    .filter((u) => u.day && u.last < u.day)
    .slice(0, limit)
    .map(({ last: _last, ...u }) => u);
}

async function claim(user: Recipient): Promise<string | null> {
  try {
    const row = await prisma.digestDelivery.create({ data: { userId: user.id, tenantId: user.tenantId, day: user.day }, select: { id: true } });
    return row.id;
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'P2002') return null;
    throw err;
  }
}

async function sendOne(user: Recipient, now: Date): Promise<'sent' | 'empty' | 'failed' | 'taken'> {
  const id = await claim(user);
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
    homeUrl: `${origin}/?tab=home`, settingsUrl: `${origin}/settings`,
    rows: rows.slice(0, DIGEST_ROW_LIMIT).map((r) => ({
      kind: r.kind, urgent: r.urgent, who: r.candidate?.name ?? r.subject ?? '', role: r.role?.title ?? null,
      since: new Date(r.since), href: r.action.to ? `${origin}${r.action.to}` : null,
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
