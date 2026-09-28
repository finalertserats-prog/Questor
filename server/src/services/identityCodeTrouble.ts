import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import type { SendCertainty, SendFailureReason } from '../providers/email/failure.js';

/**
 * Candidates who asked for an identity code and did not get one.
 *
 * Until 2026-09-23 this was invisible: a failed send deleted the challenge
 * row, wrote no audit event, and answered the candidate `503 … try again in a
 * moment`. `identityCodeStatus()` counts challenge rows, so even the interview
 * page showed nothing. A candidate who could not get past the identity gate
 * existed only as a `logger.error` line
 * (docs/qa/resilience-2026-09-23.md, R6 / S2).
 *
 * WHERE THE DATA COMES FROM. `identity.code_send_failed`, written by
 * services/identityCode.ts for every failed send. AuditEvent is durable,
 * already indexed by `[tenantId, action]`, and outlives the challenge row the
 * refusal path deletes — so no new table, and nothing to migrate.
 *
 * WHAT THIS FILE IS FOR. The "Needs you" feed is assembled in
 * domain/needsYou.ts + services/needsYouRows.ts, which another lane owns right
 * now. So this publishes the ROW, ready to drop in, rather than editing those
 * files. To wire it up, that lane adds:
 *
 *   domain/needsYou.ts
 *     NEEDS_YOU_KINDS  += 'identity_code_stuck'
 *     KIND_GATE         += identity_code_stuck: { capability: 'interview:invite' }
 *                          (the fix is to resend the invitation or reach the
 *                          candidate another way — the same capability the
 *                          invitation_expiring row already gates on)
 *     KIND_LABEL        += identity_code_stuck: 'Could not send an identity code'
 *     actionFor          += case 'identity_code_stuck': { label: 'Check the address', to: interview }
 *
 *   services/needsYouRows.ts
 *     one more drafts source, exactly like expiringDrafts:
 *       const { count, drafts } = await identityCodeTroubleDrafts(tenantId, candidate, now, limit)
 *
 * `identityCodeTroubleDrafts` below returns precisely the `Draft` shape that
 * file already uses (id, kind, since, candidate, role, subject, sessionId,
 * assessmentId, facts), so the wiring is additive.
 *
 * PRIVACY. The row names the candidate and the role. It never carries the
 * address — that is the thing that failed, and it is not needed to act: the
 * person opens the interview, where the address is already shown to someone
 * who may see it.
 */

/** The `NeedsYouKind` this row will be listed under once the feed adopts it. */
export const IDENTITY_TROUBLE_KIND = 'identity_code_stuck' as const;

/** How far back a failure is still worth a person's attention. */
export const IDENTITY_TROUBLE_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;

export interface IdentityTroubleFacts {
  readonly channel: 'email';
  readonly certainty: SendCertainty;
  readonly reason: SendFailureReason;
}

export interface IdentityTroubleRow {
  readonly id: string;
  readonly kind: typeof IDENTITY_TROUBLE_KIND;
  /** When the send failed, ISO. The feed orders on this. */
  readonly since: string;
  readonly candidate: { readonly id: string; readonly name: string };
  readonly role: { readonly id: string; readonly title: string };
  readonly subject: null;
  readonly sessionId: string;
  readonly assessmentId: null;
  readonly facts: IdentityTroubleFacts;
}

const FAILED_ACTION = 'identity.code_send_failed';
/** A later code that went out, or one the candidate entered, ends the trouble. */
const RESOLVING_ACTIONS = ['identity.code_sent', 'identity.code_confirmed'];

function factsOf(afterJson: string): IdentityTroubleFacts {
  try {
    const parsed: unknown = JSON.parse(afterJson || '{}');
    const o = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
    return {
      channel: 'email',
      certainty: o.certainty === 'not_delivered' ? 'not_delivered' : 'unknown',
      reason: typeof o.reason === 'string' ? (o.reason as SendFailureReason) : 'unknown',
    };
  } catch {
    return { channel: 'email', certainty: 'unknown', reason: 'unknown' };
  }
}

/**
 * The newest unresolved failure per interview, newest first.
 *
 * "Unresolved" means no `identity.code_sent` or `identity.code_confirmed` for
 * that interview AFTER the failure — a candidate who asked again and got a
 * code needs nothing from anyone.
 */
export async function identityCodeTrouble(
  tenantId: string,
  candidate: Prisma.CandidateWhereInput,
  now: Date,
  limit = 50,
): Promise<IdentityTroubleRow[]> {
  const since = new Date(now.getTime() - IDENTITY_TROUBLE_WINDOW_DAYS * DAY_MS);
  const failures = await prisma.auditEvent.findMany({
    where: { tenantId, action: FAILED_ACTION, createdAt: { gte: since } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    // Read a little wider than the page: the newest failures may all belong to
    // interviews that have since recovered.
    take: limit * 4,
    select: { id: true, entityId: true, afterJson: true, createdAt: true },
  });
  if (!failures.length) return [];

  // One row per interview: the newest failure is the one worth showing.
  const newest = new Map<string, (typeof failures)[number]>();
  for (const row of failures) if (!newest.has(row.entityId)) newest.set(row.entityId, row);
  const sessionIds = [...newest.keys()];

  const [resolutions, sessions] = await Promise.all([
    prisma.auditEvent.findMany({
      where: { tenantId, action: { in: RESOLVING_ACTIONS }, entityId: { in: sessionIds }, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      select: { entityId: true, createdAt: true },
    }),
    prisma.interviewSession.findMany({
      where: { id: { in: sessionIds }, tenantId, candidate },
      select: { id: true, candidate: { select: { id: true, fullName: true } }, role: { select: { id: true, title: true } } },
    }),
  ]);
  const resolvedAt = resolutions.reduce((acc, r) => (acc.has(r.entityId) ? acc : acc.set(r.entityId, r.createdAt)), new Map<string, Date>());
  const byId = new Map(sessions.map((s) => [s.id, s]));

  return sessionIds
    .flatMap((sessionId) => {
      const failure = newest.get(sessionId)!;
      const session = byId.get(sessionId);
      // Not in scope for this caller, or the interview is gone.
      if (!session) return [];
      const resolved = resolvedAt.get(sessionId);
      if (resolved && resolved.getTime() >= failure.createdAt.getTime()) return [];
      return [{
        id: `${IDENTITY_TROUBLE_KIND}:${sessionId}`,
        kind: IDENTITY_TROUBLE_KIND,
        since: failure.createdAt.toISOString(),
        candidate: { id: session.candidate.id, name: session.candidate.fullName },
        role: { id: session.role.id, title: session.role.title },
        subject: null,
        sessionId,
        assessmentId: null,
        facts: factsOf(failure.afterJson),
      } satisfies IdentityTroubleRow];
    })
    .sort((a, b) => b.since.localeCompare(a.since))
    .slice(0, limit);
}

/**
 * The same rows plus a count, in the shape services/needsYouRows.ts takes from
 * every other source. The reminders lane calls this one.
 */
export async function identityCodeTroubleDrafts(
  tenantId: string,
  candidate: Prisma.CandidateWhereInput,
  now: Date,
  limit: number,
): Promise<{ count: number; drafts: IdentityTroubleRow[] }> {
  // Counted from the same scan rather than with a second query: "unresolved"
  // is not expressible as a where clause, so a count(*) would over-report.
  const all = await identityCodeTrouble(tenantId, candidate, now, Math.max(limit, 200));
  return { count: all.length, drafts: all.slice(0, limit) };
}
