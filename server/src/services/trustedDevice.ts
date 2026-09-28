import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { logAudit } from './audit.js';
import { serverPepper } from './pepper.js';

// "Keep me signed in on this device for a week."
//
// Opt-in, never assumed. It skips the CODE, never the password: a stolen laptop
// with a live grant still cannot be signed into without knowing the password,
// which is what keeps this a convenience rather than a second key under the mat.
//
// A grant is bound to three things that are allowed to change underneath it —
// the account's session generation, the person's role, and the organisation's
// code policy. Each is recorded on the grant and compared on use, so a password
// change, a role change and a policy change all retire every grant without
// anything having to go and find them. Revoking, from Settings or by an admin,
// is the fourth and is explicit.

export const TRUST_TTL_MS = 7 * 24 * 60 * 60_000;
export const TRUST_COOKIE = 'questor_device';
/** 32 bytes. Guessing is not the threat, but there is no reason to make it one. */
const TOKEN_BYTES = 32;

export function hashDeviceToken(token: string): string {
  return createHmac('sha256', serverPepper()).update(`trusted-device:v1:${token}`).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * "Chrome on Windows", from the user agent, so Settings can name the device
 * rather than showing a row of identifiers.
 *
 * Deliberately coarse. A finer label would be a fingerprint, and a list of
 * fingerprints is a thing worth stealing; "Chrome on Windows" is enough for
 * someone to recognise their own laptop and useless to anyone else.
 */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = (userAgent ?? '').slice(0, 400);
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\//.test(ua) ? 'Chrome'
          : /Safari\//.test(ua) ? 'Safari'
            : '';
  const platform = /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android'
      : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
          : /Linux/.test(ua) ? 'Linux'
            : '';
  if (browser && platform) return `${browser} on ${platform}`;
  return browser || platform || 'A browser';
}

export interface GrantBinding {
  readonly userId: string;
  readonly tenantId: string;
  readonly sessionsEpoch: number;
  readonly role: string;
  readonly mfaEpoch: number;
}

/**
 * Remember this device, and set the cookie that proves it next time.
 *
 * The cookie is httpOnly (no page script needs it), SameSite=Strict (it is only
 * ever sent to our own sign-in) and Secure in production. It is scoped to the
 * whole origin because sign-in and the API share it.
 */
export async function trustDevice(
  res: Response,
  req: Request,
  binding: GrantBinding,
  ctx: { ip: string; requestId?: string },
  now = new Date(),
): Promise<void> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(now.getTime() + TRUST_TTL_MS);
  await prisma.trustedDevice.create({
    data: {
      userId: binding.userId,
      tokenHash: hashDeviceToken(token),
      label: deviceLabel(req.headers['user-agent']),
      expiresAt,
      sessionsEpoch: binding.sessionsEpoch,
      role: binding.role,
      mfaEpoch: binding.mfaEpoch,
      createdAt: now,
    },
  });
  res.cookie(TRUST_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.nodeEnv === 'production',
    maxAge: TRUST_TTL_MS,
    path: '/',
  });
  await logAudit({
    tenantId: binding.tenantId, actorType: 'user', actorId: binding.userId, action: 'auth.device_trusted',
    entityType: 'User', entityId: binding.userId, requestId: ctx.requestId,
    after: { ip: ctx.ip, label: deviceLabel(req.headers['user-agent']), expiresAt: expiresAt.toISOString() },
  });
}

/** Stop sending the cookie. Options must match those it was set with. */
export function clearTrustCookie(res: Response): void {
  res.clearCookie(TRUST_COOKIE, { httpOnly: true, sameSite: 'strict', secure: config.nodeEnv === 'production', path: '/' });
}

/**
 * Whether the cookie on this request is a live grant for this person, under the
 * conditions it was made. Marks it used, so Settings can show when.
 *
 * Every reason to refuse gives the same answer: false. The caller then asks for
 * a code, which is what someone with no grant at all gets, so a revoked grant
 * and a forged cookie are indistinguishable from the outside.
 */
export async function deviceIsTrusted(
  req: Request,
  binding: GrantBinding,
  ctx: { ip: string },
  now = new Date(),
): Promise<boolean> {
  const token = readTrustCookie(req);
  if (!token) return false;
  const hash = hashDeviceToken(token);
  const row = await prisma.trustedDevice.findUnique({
    where: { tokenHash: hash },
    select: { id: true, userId: true, tokenHash: true, expiresAt: true, revokedAt: true, sessionsEpoch: true, role: true, mfaEpoch: true },
  });
  if (!row || !sameHash(hash, row.tokenHash)) return false;
  if (row.userId !== binding.userId) return false;

  // Re-stated as conditions on the write rather than trusted from the read.
  // A revoke landing between the two — the person pressing "Forget" on their
  // phone while a sign-in is in flight — would otherwise stamp the revoked row
  // as just used and let the sign-in past the code step on a grant that no
  // longer exists. The route that revoked it had already answered "done".
  //
  // The three bindings are here for the same reason they are checked at all:
  // any of them having moved on means the grant was agreed to under conditions
  // that no longer hold.
  const used = await prisma.trustedDevice.updateMany({
    where: {
      id: row.id,
      userId: binding.userId,
      revokedAt: null,
      expiresAt: { gt: now },
      sessionsEpoch: binding.sessionsEpoch,
      role: binding.role,
      mfaEpoch: binding.mfaEpoch,
    },
    data: { lastUsedAt: now, lastUsedIp: ctx.ip },
  });
  return used.count === 1;
}

function readTrustCookie(req: Request): string {
  const header = req.headers.cookie;
  if (!header) return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    if (part.slice(0, eq).trim() !== TRUST_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    try { return decodeURIComponent(value); } catch { return value; }
  }
  return '';
}

export interface TrustedDeviceView {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly lastUsedFrom: string;
  /** Whether this is the browser making the request. */
  readonly thisDevice: boolean;
}

/** Coarse enough to recognise, not precise enough to be a location log. */
export function roughOrigin(ip: string): string {
  if (!ip) return '';
  const clean = ip.replace(/^::ffff:/, '');
  if (clean === '127.0.0.1' || clean === '::1') return 'this machine';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(clean);
  // The first two octets only. Enough to tell "somewhere I have been before"
  // from "somewhere I have not"; not enough to be a record of where someone was.
  if (v4) return `${v4[1]}.${v4[2]}.x.x`;
  const v6 = clean.split(':').slice(0, 3).join(':');
  return v6 ? `${v6}::` : '';
}

/** The live grants a person can see and revoke in Settings. */
export async function listTrustedDevices(req: Request, userId: string, now = new Date()): Promise<TrustedDeviceView[]> {
  const current = readTrustCookie(req);
  const currentHash = current ? hashDeviceToken(current) : '';
  const rows = await prisma.trustedDevice.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((row) => ({
    id: row.id,
    label: row.label || 'A browser',
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastUsedFrom: roughOrigin(row.lastUsedIp),
    thisDevice: Boolean(currentHash) && row.tokenHash === currentHash,
  }));
}

/** Revoke one grant. Tenant-scoped through the userId the caller is bound to. */
export async function revokeTrustedDevice(
  userId: string, tenantId: string, deviceId: string, ctx: { ip: string; requestId?: string; actorId?: string }, now = new Date(),
): Promise<boolean> {
  const revoked = await prisma.trustedDevice.updateMany({
    where: { id: deviceId, userId, revokedAt: null },
    data: { revokedAt: now },
  });
  if (revoked.count !== 1) return false;
  await logAudit({
    tenantId, actorType: 'user', actorId: ctx.actorId ?? userId, action: 'auth.device_revoked',
    entityType: 'User', entityId: userId, requestId: ctx.requestId, after: { ip: ctx.ip, deviceId },
  });
  return true;
}

/**
 * Revoke every grant for one person — what an admin reaches for when a laptop
 * is lost, and what a reset does on the way past.
 */
export async function revokeAllTrustedDevices(
  userId: string, tenantId: string, ctx: { ip: string; requestId?: string; actorId?: string; reason: string }, now = new Date(),
): Promise<number> {
  const { count } = await prisma.trustedDevice.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  if (count > 0) {
    await logAudit({
      tenantId, actorType: 'user', actorId: ctx.actorId ?? userId, action: 'auth.device_revoked',
      entityType: 'User', entityId: userId, requestId: ctx.requestId, after: { ip: ctx.ip, devices: count, reason: ctx.reason },
    });
  }
  return count;
}

/** Clear grants that ended a while ago. */
export async function purgeEndedTrustedDevices(now = new Date()): Promise<number> {
  const { count } = await prisma.trustedDevice.deleteMany({
    where: { expiresAt: { lt: new Date(now.getTime() - 24 * 60 * 60_000) } },
  });
  return count;
}
