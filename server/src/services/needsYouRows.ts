import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { candidateScope, capabilitiesOf } from './access.js';
import { getNeedsAttention } from './dashboardMetrics.js';
import { lookersByEntity, type Looker } from './assessmentViews.js';
import { interviewerIdOf, listActiveInterviewers } from './interviewers.js';
import { isOperator } from '../middleware/operator.js';
import { isPlatformOperator } from '../middleware/platformOperator.js';
import type { AuthClaims } from './auth.js';
import { identityCodeTroubleDrafts } from './identityCodeTrouble.js';
import { blockOfRound } from '../domain/observedRound.js';
import {
  actionFor, compareNeedsYou, isUrgent, mayActOn, maySee, NEEDS_YOU_KINDS, NOT_STARTED_STATES,
  type GateContext, type NeedsYouAction, type NeedsYouKind,
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
/**
 * How early a round you are seated on enters the queue, and how it leaves.
 *
 * Fifteen minutes, because that is when a person actually acts on an interview
 * they are about to run — it is the default every calendar reminds at, and it
 * is long enough to open the candidate before the candidate is waiting. Longer
 * and the row is a diary entry sitting in an action list; shorter and it
 * arrives after the person is already late.
 *
 * It leaves by itself when the round is over: the row's whole life is the span
 * in which "join" is the thing to do. The end is the round's own
 * `durationMinutes`, so a 30-minute screen does not linger for the length of a
 * panel day — which is why the rows are filtered here rather than counted by
 * the database (see `startingDrafts`).
 */
const STARTING_LEAD_MS = 15 * 60_000;
/** The longest a round may run (routes/roundMeetingSchemas.ts), which bounds the query. */
const LONGEST_ROUND_MS = 480 * 60_000;
/**
 * Always read at least this many seated rounds, whatever `scan` the caller
 * asked for. Every other kind counts with its own `count()` query, so the bell
 * can pass `scan: 1` and still get an exact total; this kind's count comes from
 * the rows, so a scan of 1 would have reported "1" to somebody seated on two
 * rounds at once. The window is minutes wide and scoped to one person's seats,
 * so nobody reaches this floor.
 */
const SEATED_SCAN_FLOOR = 50;
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
    readonly channel?: string;
    readonly certainty?: string;
    readonly reason?: string;
    /** For a blocked round: why it cannot go ahead, and what may be done instead. */
    readonly blockedReason?: string;
    readonly nextSteps?: readonly string[];
    readonly scheduledAt?: string;
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
  readonly action: NeedsYouAction;
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

/**
 * `meetingUrl` is draft-only: it decides where the row's action points and is
 * then dropped, rather than being published beside an action that already
 * carries it. One answer to "where do I join" is enough.
 */
type Draft = Omit<NeedsYouRow, 'urgent' | 'openedBy' | 'canAct' | 'action'> & { readonly meetingUrl?: string | null };

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

/**
 * Human rounds that cannot go ahead because somebody who would be in the room
 * has not agreed to it being recorded.
 *
 * It is in this queue rather than only on the round, because nobody should
 * discover it by opening an empty room at the scheduled time. The row carries
 * the round's own sentence and its next steps, so the feed says the same thing
 * the pipeline does rather than a shorter version of it.
 *
 * Only rounds still ahead of the team: once the round is completed or
 * cancelled it is no longer a blocker, it is a decision that was taken.
 */
async function blockedRoundDrafts(tenantId: string, candidate: Prisma.CandidateWhereInput, limit: number) {
  const where: Prisma.InterviewRoundWhereInput = {
    tenantId, status: 'SCHEDULED', conductedBy: 'HUMAN',
    pipeline: { status: 'ACTIVE', candidate },
    observation: {
      OR: [
        { status: { in: ['DECLINED', 'STOPPED'] } },
        { participants: { some: { declinedAt: { not: null }, party: { in: ['candidate', 'interviewer'] } } } },
      ],
    },
  };
  const [rows, count] = await Promise.all([
    prisma.interviewRound.findMany({
      where, orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }], take: limit,
      select: {
        id: true, scheduledAt: true, status: true,
        panel: { select: { userId: true } },
        observation: {
          select: {
            status: true, withdrawnReason: true, stoppedBy: true, declinedBy: true,
            _count: { select: { segments: { where: { kind: 'SPEECH' } } } },
            participants: { select: { party: true, personId: true, consentAt: true, declinedAt: true, admittedAt: true } },
          },
        },
        pipeline: { select: { candidate: { select: { id: true, fullName: true, role: { select: { id: true, title: true } } } } } },
      },
    }),
    prisma.interviewRound.count({ where }),
  ]);
  const drafts: Draft[] = rows.flatMap((round) => {
    const block = blockOfRound({
      roundStatus: round.status,
      seats: round.panel.map((seat) => seat.userId),
      observation: round.observation
        ? { ...round.observation, speechCount: round.observation._count.segments }
        : null,
    });
    // The query and the rule are allowed to disagree — the query is a coarse
    // filter over indexed columns, the rule is the answer. When they do, the
    // rule wins and the row is simply not listed.
    if (!block) return [];
    const person = round.pipeline.candidate;
    return [{
      id: `round_not_recordable:${round.id}`,
      kind: 'round_not_recordable' as const,
      since: round.scheduledAt.toISOString(),
      candidate: { id: person.id, name: person.fullName },
      role: person.role ? { id: person.role.id, title: person.role.title } : null,
      subject: null,
      sessionId: null,
      assessmentId: null,
      facts: { blockedReason: block.reason, nextSteps: block.nextSteps, scheduledAt: round.scheduledAt.toISOString() },
    }];
  });
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

/**
 * Rounds this person is seated on that are about to start, or are running now.
 *
 * Scoped on the seat itself, never on `candidateScope`. A colleague entitled to
 * the candidate but not in the room has nothing to join, and handing them a row
 * would both mislead them and tell them who is interviewing whom — which the
 * candidate's own page already says to people who should know, and the queue
 * has no business repeating to people who should not.
 *
 * Human rounds only. On an AI round the seat is an observer, not a conductor,
 * and "join" is not what they would be doing.
 *
 * The count comes from the rows rather than from a second `count()` query,
 * because whether a round is over depends on its own `durationMinutes` — an
 * expression Prisma cannot filter on, and two queries that disagree about the
 * total is worse than one bounded read. See SEATED_SCAN_FLOOR for what keeps
 * the read deep enough for that count to be true.
 */
async function startingDrafts(tenantId: string, userId: string, now: Date, limit: number) {
  const rows = await prisma.interviewRound.findMany({
    where: {
      tenantId, status: 'SCHEDULED', conductedBy: 'HUMAN',
      panel: { some: { userId } },
      scheduledAt: { gte: new Date(now.getTime() - LONGEST_ROUND_MS), lte: new Date(now.getTime() + STARTING_LEAD_MS) },
    },
    orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }], take: Math.max(limit, SEATED_SCAN_FLOOR),
    select: { id: true, scheduledAt: true, durationMinutes: true, meetingUrl: true, pipeline: { select: sessionSelect } },
  });
  const live = rows.filter((r) => r.scheduledAt.getTime() + r.durationMinutes * 60_000 > now.getTime());
  const drafts: Draft[] = live.map((r) => ({
    id: `round_starting:${r.id}`,
    kind: 'round_starting',
    since: r.scheduledAt.toISOString(),
    candidate: { id: r.pipeline.candidate.id, name: r.pipeline.candidate.fullName },
    role: { id: r.pipeline.role.id, title: r.pipeline.role.title },
    subject: null,
    // No session, even where the round has one. `enrichRows` reads a session
    // to name the AI interviewer who ran it and to list who else has opened it;
    // neither says anything true about a human round somebody is walking into.
    sessionId: null,
    assessmentId: null,
    meetingUrl: r.meetingUrl,
    facts: {},
  }));
  return { count: live.length, drafts };
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

  const [attention, expiring, stalled, identity, blockedRounds, catalog, demo, starting] = await Promise.all([
    ATTENTION_KINDS.some(may) ? attentionDrafts(tenantId, candidate, now, scan) : null,
    may('invitation_expiring') ? expiringDrafts(tenantId, candidate, now, scan) : none,
    may('stalled') ? stalledDrafts(tenantId, candidate, now, scan) : none,
    may('identity_code_stuck') ? identityCodeTroubleDrafts(tenantId, candidate, now, scan) : none,
    may('round_not_recordable') ? blockedRoundDrafts(tenantId, candidate, scan) : none,
    may('catalog_proposals') ? catalogDrafts() : none,
    may('demo_request') ? demoDrafts(now, scan) : none,
    may('round_starting') ? startingDrafts(tenantId, auth.userId, now, scan) : none,
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
  counts.identity_code_stuck = identity.count;
  counts.round_not_recordable = blockedRounds.count;
  counts.catalog_proposals = catalog.count;
  counts.demo_request = demo.count;
  counts.round_starting = starting.count;
  drafts.push(...expiring.drafts, ...stalled.drafts, ...identity.drafts, ...blockedRounds.drafts, ...catalog.drafts, ...demo.drafts, ...starting.drafts);

  // Which surface this reader's role can open a candidate on. Read once from
  // the capabilities already in hand rather than per row.
  const expertLane = !gate.capabilities.includes('candidate:read');
  const rows = drafts
    .map(({ meetingUrl, ...d }): NeedsYouRow => ({
      ...d, urgent: isUrgent(d.kind), openedBy: [], canAct: canAct(d.kind),
      action: actionFor(d.kind, { ...d, candidateId: d.candidate?.id, meetingUrl, expertLane }, canAct(d.kind)),
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
