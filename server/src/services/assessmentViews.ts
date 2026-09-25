import { prisma } from '../db.js';
import { logAudit } from './audit.js';
import type { AuthClaims } from './auth.js';
import { initialsOf } from '../domain/needsYou.js';

/**
 * Who has already opened something, for HR-Box's "who else has looked" column.
 *
 * Opening an interview was already audited (interview.detail_read). Opening an
 * assessment was not, so a reviewer could not tell that a colleague had read it
 * and not decided. It is now recorded as `assessment.opened`: an audit row with
 * the user id and the assessment id and nothing else, written at most once per
 * user per assessment per hour so rereading a page does not flood the log.
 */

export const ASSESSMENT_OPENED = 'assessment.opened';
const OPENED_ACTIONS = [ASSESSMENT_OPENED, 'interview.detail_read', 'interview.transcript_read'];
const REOPEN_QUIET_MS = 60 * 60_000;
/** Older looks than this are not "someone is on it". */
export const OPENED_WINDOW_DAYS = 30;

export async function recordAssessmentOpened(auth: AuthClaims, assessmentId: string, now: Date = new Date()): Promise<void> {
  const recent = await prisma.auditEvent.findFirst({
    where: {
      tenantId: auth.tenantId, action: ASSESSMENT_OPENED, actorId: auth.userId, entityId: assessmentId,
      createdAt: { gte: new Date(now.getTime() - REOPEN_QUIET_MS) },
    },
    select: { id: true },
  });
  if (recent) return;
  await logAudit({
    tenantId: auth.tenantId, actorId: auth.userId, actorType: 'user', action: ASSESSMENT_OPENED,
    entityType: 'AssessmentVersion', entityId: assessmentId,
  });
}

export interface Looker {
  readonly userId: string;
  readonly name: string;
  readonly initials: string;
}

/**
 * Colleagues (never the caller) who opened each of `entityIds` in the window,
 * most recent first. Tenant-scoped by the audit rows themselves; the names come
 * from the same tenant's users, so nothing outside the organisation is read.
 */
export async function lookersByEntity(
  tenantId: string, entityIds: readonly string[], exceptUserId: string, now: Date = new Date(),
): Promise<ReadonlyMap<string, readonly Looker[]>> {
  const ids = [...new Set(entityIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const since = new Date(now.getTime() - OPENED_WINDOW_DAYS * 86_400_000);
  const events = await prisma.auditEvent.findMany({
    where: {
      tenantId, action: { in: OPENED_ACTIONS }, actorType: 'user', entityId: { in: ids },
      actorId: { not: exceptUserId }, createdAt: { gte: since },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    // Each row is a look, not a person; a ceiling keeps one busy assessment from pulling the log.
    take: 2_000,
    select: { entityId: true, actorId: true },
  });
  const userIds = [...new Set(events.map((e) => e.actorId))];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { tenantId, id: { in: userIds } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const byEntity = new Map<string, Looker[]>();
  for (const event of events) {
    const name = nameOf.get(event.actorId);
    if (name === undefined) continue;
    const seen = byEntity.get(event.entityId) ?? [];
    if (seen.some((l) => l.userId === event.actorId)) continue;
    byEntity.set(event.entityId, [...seen, { userId: event.actorId, name, initials: initialsOf(name) }]);
  }
  return byEntity;
}
