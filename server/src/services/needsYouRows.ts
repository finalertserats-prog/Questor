import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { candidateScope, capabilitiesOf } from './access.js';
import { getNeedsAttention } from './dashboardMetrics.js';
import { lookersByEntity, type Looker } from './assessmentViews.js';
import { interviewerIdOf, listActiveInterviewers } from './interviewers.js';
import { isOperator } from '../middleware/operator.js';
import { isPlatformOperator } from '../middleware/platformOperator.js';
import type { AuthClaims } from './auth.js';
import {
  actionFor, compareNeedsYou, isUrgent, mayActOn, maySee, NEEDS_YOU_KINDS, NOT_STARTED_STATES,
  type GateContext, type NeedsYouKind,
} from '../domain/needsYou.js';

/**
 * The rows of HR-Box's "Needs you" queue.
 *
 * The four kinds the dashboard already listed (review, accommodation, human
 * request, held feedback email) come from the dashboard's own query
 * (dashboardMetrics.getNeedsAttention) so the two views can never disagree.
 * This adds the rest: invitations about to lapse, interviews that stopped
 * part-way, and the operator's queues. Every candidate row is object-scoped
 * through candidateScope, and every kind is listed only for someone who may do
 * its action (domain/needsYou.ts KIND_GATE).
 */

const DAY_MS = 86_400_000;
/** An invitation this close to closing is worth a person's attention. */
export const EXPIRING_WITHIN_DAYS = 2;
/** Interviews that stopped longer ago than this have been let go; the queue stops asking. */
const STALLED_WINDOW_DAYS = 30;
/** Rows read per kind. The counts are exact; the list shows the oldest this many of each. */
export const PER_KIND_SCAN = 200;
/** Interviews that stopped part-way (services/incompleteInterviews.ts). */
const STALLED_STATES = ['INCOMPLETE', 'TECHNICAL_FAILURE'];
/** Invitations whose link a candidate may still hold. */
const OPEN_INVITATION_STATUSES = ['created', 'sent', 'opened', 'accepted'];

export interface NeedsYouRow {
  readonly id: string;
  readonly kind: NeedsYouKind;
  readonly urgent: boolean;
  /** When the wait began, ISO. */
  readonly since: string;
  readonly candidate: { readonly id: string; readonly name: string } | null;
  readonly role: { readonly id: string; readonly title: string } | null;
  /** For a row that is not about one candidate: who or what it is. */
  readonly subject: string | null;
  readonly sessionId: string | null;
  readonly assessmentId: string | null;
  readonly facts: {
    readonly interviewerName?: string | null;
    readonly expiresAt?: string;
    readonly opened?: boolean;
    readonly count?: number;
  };
  /** Colleagues who have already opened it, most recent first. */
  readonly openedBy: readonly Looker[];
  /**
   * Whether this reader may do the row's work, or only look. False on a review
   * row for a recruiter: they own the candidate and need to know the
   * assessment landed, but signing it off is somebody else's. The action below
   * already says so; this is what lets the page word the row honestly too.
   */
  readonly canAct: boolean;
  readonly action: { readonly label: string; readonly to: string | null };
}

export type NeedsYouCounts = Readonly<Record<NeedsYouKind, number>>;

export interface NeedsYouRows {
  readonly counts: NeedsYouCounts;
  readonly total: number;
  /** In queue order, at most PER_KIND_SCAN of each kind. */
  readonly rows: readonly NeedsYouRow[];
}

export function gateContextOf(auth: AuthClaims): GateContext {
  return { capabilities: capabilitiesOf(auth.role), operator: isOperator(auth), platformOperator: isPlatformOperator(auth) };
}

/** The kinds the dashboard's own needs-attention query already reads. */
const ATTENTION_KINDS = ['review', 'accommodation', 'human_request', 'feedback_held'] as const;

type Draft = Omit<NeedsYouRow, 'urgent' | 'openedBy' | 'canAct' | 'action'>;

const sessionSelect = {
  id: true,
  candidate: { select: { id: true, fullName: true } },
  role: { select: { id: true, title: true } },
} as const;

function emptyCounts(): Record<NeedsYouKind, number> {
  return Object.fromEntries(NEEDS_YOU_KINDS.map((kind) => [kind, 0])) as Record<NeedsYouKind, number>;
}

async function attentionDrafts(tenantId: string, candidate: Prisma.CandidateWhereInput, now: Date, limit: number) {
  const attention = await getNeedsAttention(tenantId, candidate, now, limit);
  const drafts: Draft[] = attention.items.map((item) => ({
    id: `${item.kind}:${item.sessionId}`,
    kind: item.kind,
    since: item.at,
    candidate: item.candidate,
    role: item.role,
    subject: null,
    sessionId: item.sessionId,
    assessmentId: item.assessmentId,
    facts: {},
  }));
  return { counts: attention.counts, drafts };
}

async function expiringDrafts(tenantId: string, candidate: Prisma.CandidateWhereInput, now: Date, limit: number) {
  const where: Prisma.InvitationWhereInput = {
    expiresAt: { gt: now, lte: new Date(now.getTime() + EXPIRING_WITHIN_DAYS * DAY_MS) },
    status: { in: OPEN_INVITATION_STATUSES },
    session: { tenantId, candidate, state: { in: [...NOT_STARTED_STATES] }, role: { status: { not: 'archived' } } },
  };
  const [rows, count] = await Promise.all([
    prisma.invitation.findMany({
      where, orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }], take: limit,
      select: { id: true, sentAt: true, createdAt: true, openedAt: true, expiresAt: true, session: { select: sessionSelect } },
    }),
    prisma.invitation.count({ where }),
  ]);
  const drafts: Draft[] = rows.map((inv) => ({
    id: `invitation_expiring:${inv.session.id}`,
    kind: 'invitation_expiring',
    since: (inv.sentAt ?? inv.createdAt).toISOString(),
    candidate: { id: inv.session.candidate.id, name: inv.session.candidate.fullName },
    role: { id: inv.session.role.id, title: inv.session.role.title },
    subject: null,
    sessionId: inv.session.id,
    assessmentId: null,
    facts: { expiresAt: inv.expiresAt?.toISOString(), opened: inv.openedAt !== null },
  }));
  return { count, drafts };
}

async function stalledDrafts(tenantId: string, candidate: Prisma.CandidateWhereInput, now: Date, limit: number) {
  const where: Prisma.InterviewSessionWhereInput = {
    tenantId, candidate, state: { in: STALLED_STATES },
    updatedAt: { gte: new Date(now.getTime() - STALLED_WINDOW_DAYS * DAY_MS) },
  };
  const [rows, count] = await Promise.all([
    prisma.interviewSession.findMany({
      where, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: limit,
      select: { ...sessionSelect, interruptedAt: true, updatedAt: true },
    }),
    prisma.interviewSession.count({ where }),
  ]);
  const drafts: Draft[] = rows.map((s) => ({
    id: `stalled:${s.id}`,
    kind: 'stalled',
    since: (s.interruptedAt ?? s.updatedAt).toISOString(),
    candidate: { id: s.candidate.id, name: s.candidate.fullName },
    role: { id: s.role.id, title: s.role.title },
    subject: null,
    sessionId: s.id,
    assessmentId: null,
    facts: {},
  }));
  return { count, drafts };
}

async function catalogDrafts(): Promise<{ count: number; drafts: Draft[] }> {
  const where = { status: 'pending' };
  const [count, oldest] = await Promise.all([
    prisma.catalogProposal.count({ where }),
    prisma.catalogProposal.findFirst({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { createdAt: true } }),
  ]);
  if (count === 0 || !oldest) return { count: 0, drafts: [] };
  // One row for the whole queue: it is one errand, done on its own page.
  return {
    count: 1,
    drafts: [{
      id: 'catalog_proposals', kind: 'catalog_proposals', since: oldest.createdAt.toISOString(),
      candidate: null, role: null, subject: `${count} catalog ${count === 1 ? 'proposal' : 'proposals'}`,
      sessionId: null, assessmentId: null, facts: { count },
    }],
  };
}

async function demoDrafts(now: Date, limit: number): Promise<{ count: number; drafts: Draft[] }> {
  const where = { status: 'reaccess_requested', decisionExpiresAt: { gt: now } };
  const [rows, count] = await Promise.all([
    prisma.demoGrant.findMany({ where, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: limit, select: { id: true, name: true, company: true, updatedAt: true } }),
    prisma.demoGrant.count({ where }),
  ]);
  const drafts: Draft[] = rows.map((g) => ({
    id: `demo_request:${g.id}`, kind: 'demo_request', since: g.updatedAt.toISOString(),
    candidate: null, role: null, subject: g.company ? `${g.name} · ${g.company}` : g.name,
    sessionId: null, assessmentId: null, facts: {},
  }));
  return { count, drafts };
}

/**
 * Every row the caller may act on, in queue order, with exact counts.
 * `scan` bounds the rows read per kind; the count endpoint passes 1.
 */
export async function collectNeedsYou(auth: AuthClaims, now: Date, scan: number = PER_KIND_SCAN): Promise<NeedsYouRows> {
  const gate = gateContextOf(auth);
  const may = (kind: NeedsYouKind) => maySee(kind, gate);
  const canAct = (kind: NeedsYouKind) => mayActOn(kind, gate);
  const candidate = (await candidateScope(auth)) as Prisma.CandidateWhereInput;
  const { tenantId } = auth;
  const none = Promise.resolve({ count: 0, drafts: [] as Draft[] });

  const [attention, expiring, stalled, catalog, demo] = await Promise.all([
    ATTENTION_KINDS.some(may) ? attentionDrafts(tenantId, candidate, now, scan) : null,
    may('invitation_expiring') ? expiringDrafts(tenantId, candidate, now, scan) : none,
    may('stalled') ? stalledDrafts(tenantId, candidate, now, scan) : none,
    may('catalog_proposals') ? catalogDrafts() : none,
    may('demo_request') ? demoDrafts(now, scan) : none,
  ]);

  const counts = emptyCounts();
  const drafts: Draft[] = [];
  if (attention) {
    for (const kind of ATTENTION_KINDS) {
      if (may(kind)) counts[kind] = attention.counts[kind];
    }
    drafts.push(...attention.drafts.filter((d) => may(d.kind)));
  }
  counts.invitation_expiring = expiring.count;
  counts.stalled = stalled.count;
  counts.catalog_proposals = catalog.count;
  counts.demo_request = demo.count;
  drafts.push(...expiring.drafts, ...stalled.drafts, ...catalog.drafts, ...demo.drafts);

  const rows = drafts
    .map((d): NeedsYouRow => ({
      ...d, urgent: isUrgent(d.kind), openedBy: [], canAct: canAct(d.kind),
      action: actionFor(d.kind, { ...d, candidateId: d.candidate?.id }, canAct(d.kind)),
    }))
    .sort(compareNeedsYou);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { counts, total, rows };
}

/**
 * Fill in what only the rows on screen need: who else has opened each one, and
 * which interviewer ran it. Two queries for the page, not two per row.
 */
export async function enrichRows(auth: AuthClaims, rows: readonly NeedsYouRow[], now: Date): Promise<NeedsYouRow[]> {
  const sessionIds = rows.map((r) => r.sessionId).filter((id): id is string => !!id);
  const entityIds = [...sessionIds, ...rows.map((r) => r.assessmentId).filter((id): id is string => !!id)];
  const [lookers, sessions, interviewers] = await Promise.all([
    lookersByEntity(auth.tenantId, entityIds, auth.userId, now),
    sessionIds.length
      ? prisma.interviewSession.findMany({ where: { tenantId: auth.tenantId, id: { in: sessionIds } }, select: { id: true, personaJson: true } })
      : Promise.resolve([]),
    listActiveInterviewers(),
  ]);
  const names = new Map(interviewers.map((i) => [i.id, i.name]));
  const interviewerOf = new Map(sessions.map((s) => [s.id, names.get(interviewerIdOf(s.personaJson, s.id) ?? '') ?? null]));
  return rows.map((row) => {
    const seen = [...(row.assessmentId ? lookers.get(row.assessmentId) ?? [] : []), ...(row.sessionId ? lookers.get(row.sessionId) ?? [] : [])];
    const openedBy = seen.filter((l, i) => seen.findIndex((o) => o.userId === l.userId) === i);
    const interviewerName = row.sessionId ? interviewerOf.get(row.sessionId) ?? null : undefined;
    return { ...row, openedBy, facts: interviewerName === undefined ? row.facts : { ...row.facts, interviewerName } };
  });
}
