import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { candidateScope, capabilitiesOf, SME_RELATION } from './access.js';
import { candidateSurfaceFor } from '../domain/candidateSurface.js';
import { getNeedsAttention } from './dashboardMetrics.js';
import { lookersByEntity, type Looker } from './assessmentViews.js';
import { interviewerIdOf, listActiveInterviewers } from './interviewers.js';
import { isOperator } from '../middleware/operator.js';
import { isPlatformOperator } from '../middleware/platformOperator.js';
import type { AuthClaims } from './auth.js';
import { identityCodeTroubleDrafts } from './identityCodeTrouble.js';
import { blockOfRound } from '../domain/observedRound.js';
import { parseStages, type StageKind } from '../domain/pipelineStages.js';
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
    /** For a stage decision: where the candidate stands and where the next move lands. */
    readonly stageLabel?: string;
    readonly nextStageLabel?: string;
    /** What made them ready, so the row can say why it is asking. */
    readonly readyBecause?: ReadyBecause;
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
 * `meetingUrl` and `candidatePath` are draft-only: between them they decide
 * where the row's action points, and are then dropped rather than published
 * beside an action that already carries the answer. One answer to "where do I
 * go" is enough, and a second copy is a second thing to keep in step.
 */
type Draft = Omit<NeedsYouRow, 'urgent' | 'openedBy' | 'canAct' | 'action'> & {
  readonly meetingUrl?: string | null;
  readonly candidatePath?: string | null;
};

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

/**
 * Why a candidate is being put in front of a person, which is also what has
 * happened to them that a person can act on.
 *
 *  - `profile_read`       their CV has been read and a fit computed.
 *  - `interview_reviewed` a person has read and recorded a verdict on their
 *                         AI interview.
 *
 * Note what `profile_read` is NOT gated on: the Bronze award. Bronze is struck
 * only when the fit was measured against an APPROVED scorecard, and a role
 * whose scorecard is still a draft produces candidates with a CV, a fit, a
 * pipeline at Bronze — and no award, for ever, because nothing re-strikes one
 * when the scorecard is approved later. Gating on the award would have meant
 * that on the day the autonomous moves were removed, the row replacing them
 * appeared for nobody who already existed: production holds no awards at all.
 * The decision this row asks for is possible as soon as the CV has been read.
 * Whether that reading was against an approved scorecard is a fact about the
 * candidate, shown on their page, not a reason to say nothing.
 */
export type ReadyBecause = 'profile_read' | 'interview_reviewed';

/**
 * What makes a candidate standing at each kind of stage ready to be moved.
 *
 * `intake` takes either, and that is not tidiness. A candidate can be
 * interviewed and assessed while their pipeline still says Participation —
 * booking an interview needs an approved ROLE scorecard, not a candidate
 * profile — and before the autonomous moves were removed, `interview.scheduled`
 * carried them off it. Now nothing does, so without this they would never be
 * mentioned anywhere again. It also catches a candidate whose CV was read but
 * whose `candidate.profiled` event was lost: that event is raised through
 * `notePipelineEvent`, which swallows its own failures by design.
 *
 * `human_interview` takes nothing. Finalisation is a person's own act with its
 * own button and its own refusals, and nothing about it changed.
 */
const READY_AT: Readonly<Partial<Record<StageKind, readonly ReadyBecause[]>>> = {
  intake: ['interview_reviewed', 'profile_read'],
  profile_review: ['profile_read'],
  ai_interview: ['interview_reviewed'],
};

/**
 * How deep the scan goes before the count stops being exact.
 *
 * Every other kind in this file pushes its limit into the query, because its
 * `where` clause IS its rule. This one's cannot be: the stage a candidate
 * stands at is a key inside `stagesJson`, and no `where` reaches inside it. So
 * the rule is applied in Node, over a window that is bounded rather than the
 * whole tenant. Two thousand is far above any real backlog — and far enough
 * above the page size that it is nothing like capping at `limit`, which on the
 * count endpoint is 1.
 */
const STAGE_DECISION_SCAN = 2_000;

interface StageWait {
  readonly pipelineId: string;
  readonly candidateId: string;
  readonly roleId: string;
  readonly wants: readonly ReadyBecause[];
  readonly stageLabel: string;
  readonly nextStageLabel: string;
}

/**
 * Candidates who are ready to move and whom only a person may move.
 *
 * WHY THE ROW EXISTS. An interview being scheduled used to carry a candidate
 * to Silver and an assessment used to carry them to Gold. Both stopped, because
 * a tier is struck by whoever promotes a candidate out of it and an autonomous
 * move struck nothing (domain/pipelineAutonomy.ts). Without a prompt, that
 * change would simply have stalled every candidate quietly — the endpoint to
 * move them has always existed and nothing ever asked.
 *
 * WHEN SOMEBODY IS READY. `READY_AT`, above, with the reasoning for each kind.
 * The shared principle is that a row nobody can clear teaches people to stop
 * reading the list it sits in, so each reason is something that has already
 * happened to that candidate rather than a stage they merely occupy.
 *
 * Moving a candidate OFF the AI round is refused until a person has read their
 * interview — `advancePipeline` enforces the promise on exactly the moves it is
 * about (domain/humanReviewRule.ts, moveNeedsHumanReview). Waiting for the
 * review before listing them is therefore not a preference: the button this row
 * points at is the one the server would turn down. It also keeps one person off
 * the queue as two jobs, because the `review` row already owns the hours
 * between "the assessment landed" and "somebody read it", and recording the
 * verdict moves the session REVIEW_READY → HUMAN_REVIEWED as this row appears.
 *
 * A Proceed verdict moves the candidate by itself, so a reviewed interview
 * usually leaves no row at all. What is left is the real gap: Consider, or a
 * review recorded without applying it to the journey.
 *
 * Archived roles are left out. There is no decision to make about a
 * requisition nobody is hiring for.
 */
async function stageDecisionDrafts(tenantId: string, candidate: Prisma.CandidateWhereInput, limit: number) {
  const open = await prisma.candidatePipeline.findMany({
    where: { tenantId, status: 'ACTIVE', candidate, role: { status: { not: 'archived' } } },
    // The stage plan and the two ids, no joins: this is the pass the rule is
    // applied over, and the names are read afterwards for the page alone.
    select: { id: true, candidateId: true, roleId: true, currentStageKey: true, stagesJson: true },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: STAGE_DECISION_SCAN,
  });
  // A plan too corrupt to read falls back to the defaults, whose keys this
  // candidate's stage will not be among, so the pipeline is simply not listed.
  // The queue is not the place to raise a corrupt record.
  const standing = open.flatMap((p) => {
    const stages = parseStages(p.stagesJson);
    const at = stages.findIndex((stage) => stage.key === p.currentStageKey);
    const next = at >= 0 ? stages[at + 1] : undefined;
    if (!next) return [];
    const wants = READY_AT[stages[at].kind];
    if (!wants) return [];
    return [{
      pipelineId: p.id, candidateId: p.candidateId, roleId: p.roleId, wants,
      stageLabel: stages[at].label, nextStageLabel: next.label,
    } satisfies StageWait];
  });
  if (standing.length === 0) return { count: 0, drafts: [] as Draft[] };

  const wantedBy = (because: ReadyBecause) => standing.filter((s) => s.wants.includes(because));
  const [profiles, reviews] = await Promise.all([
    profileReadAt(wantedBy('profile_read')),
    interviewReviewedAt(tenantId, wantedBy('interview_reviewed')),
  ]);

  const ready = standing
    .flatMap((s) => {
      // In `READY_AT` order, so a candidate whose interview has been read is
      // described by that rather than by the CV reading that came first.
      for (const because of s.wants) {
        const since = because === 'profile_read'
          ? profiles.get(s.candidateId)
          : reviews.get(`${s.candidateId}:${s.roleId}`);
        if (since) return [{ ...s, because, since }];
      }
      return [];
    })
    // Longest wait first, then by id so two from the same instant never swap
    // places between two reads of the same queue.
    .sort((a, b) => a.since.getTime() - b.since.getTime() || a.pipelineId.localeCompare(b.pipelineId));

  const page = ready.slice(0, limit);
  // Tenant-scoped again, although these ids came from a read that already was.
  // Every other query in this file carries its own scope rather than inheriting
  // one from a previous step, and a name is the single most sensitive thing a
  // row carries — so the second read is narrowed the same way as the first.
  const named = page.length === 0 ? [] : await prisma.candidatePipeline.findMany({
    where: { tenantId, id: { in: page.map((r) => r.pipelineId) } },
    select: { id: true, candidate: { select: { id: true, fullName: true } }, role: { select: { id: true, title: true } } },
  });
  const nameOf = new Map(named.map((row) => [row.id, row]));
  const drafts: Draft[] = page.flatMap((r) => {
    const row = nameOf.get(r.pipelineId);
    if (!row) return [];
    return [{
      id: `stage_decision:${r.pipelineId}`,
      kind: 'stage_decision' as const,
      since: r.since.toISOString(),
      candidate: { id: row.candidate.id, name: row.candidate.fullName },
      role: { id: row.role.id, title: row.role.title },
      subject: null,
      // No session and no assessment: the row is about the person, and naming
      // one interview of theirs would send `enrichRows` off to fetch an AI
      // interviewer's name that says nothing about the decision being asked for.
      sessionId: null,
      assessmentId: null,
      facts: { stageLabel: r.stageLabel, nextStageLabel: r.nextStageLabel, readyBecause: r.because },
    }];
  });
  return { count: ready.length, drafts };
}

/**
 * When each candidate's CV was first read, by candidate.
 *
 * Keyed on the candidate alone, because a profile version has no role of its
 * own — a Candidate row belongs to one role, and a second application is a
 * second row (services/candidateReuse.ts). Earliest wins: the wait began when
 * the CV was first read, not when it was last re-read.
 */
async function profileReadAt(waiting: readonly StageWait[]): Promise<ReadonlyMap<string, Date>> {
  if (waiting.length === 0) return new Map();
  const rows = await prisma.candidateProfileVersion.findMany({
    where: { candidateId: { in: [...new Set(waiting.map((w) => w.candidateId))] } },
    select: { candidateId: true, createdAt: true },
  });
  return earliestBy(rows.map((r) => ({ key: r.candidateId, at: r.createdAt })));
}

/**
 * When a person's verdict on each candidate's AI interview was recorded, by
 * candidate and role.
 *
 * Both parts of the key, because a session carries the role it was run for and
 * a candidate could in principle hold a pipeline for another one. A session
 * with no role cannot belong to any pipeline, so it is dropped rather than
 * given an empty key that would silently match nothing.
 */
async function interviewReviewedAt(tenantId: string, waiting: readonly StageWait[]): Promise<ReadonlyMap<string, Date>> {
  if (waiting.length === 0) return new Map();
  const rows = await prisma.humanReview.findMany({
    where: {
      status: 'COMPLETED', activeForAssessmentId: { not: null },
      assessment: { session: { tenantId, candidateId: { in: [...new Set(waiting.map((w) => w.candidateId))] } } },
    },
    select: { createdAt: true, completedAt: true, assessment: { select: { session: { select: { candidateId: true, roleId: true } } } } },
  });
  return earliestBy(rows.flatMap((r) => {
    const { candidateId, roleId } = r.assessment.session;
    return roleId ? [{ key: `${candidateId}:${roleId}`, at: r.completedAt ?? r.createdAt }] : [];
  }));
}

/** The earliest time recorded against each key. */
function earliestBy(rows: readonly { key: string; at: Date }[]): ReadonlyMap<string, Date> {
  const earliest = new Map<string, Date>();
  for (const row of rows) {
    const held = earliest.get(row.key);
    if (!held || row.at < held) earliest.set(row.key, row.at);
  }
  return earliest;
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
 * Whether a round is over depends on its own `durationMinutes`, which is not an
 * expression Prisma can filter on — so the end is decided here rather than by
 * the database. That is why this reads twice: once for two scalar columns over
 * the whole window, which makes the count EXACT the way every other kind's
 * `count()` is, and once for the rows the page will actually show. A single
 * capped read would have given a number that quietly stopped being true past
 * the cap, and a count nobody can trust is worse than a slower one.
 *
 * Who the candidate is travels only to a reader entitled to know
 * (`candidateSurfaceFor`). A seat is not an assignment, so an expert holding
 * one gets the row without the name — see domain/candidateSurface.ts.
 */
async function startingDrafts(tenantId: string, userId: string, role: string, now: Date, limit: number) {
  const where: Prisma.InterviewRoundWhereInput = {
    tenantId, status: 'SCHEDULED', conductedBy: 'HUMAN',
    panel: { some: { userId } },
    scheduledAt: { gte: new Date(now.getTime() - LONGEST_ROUND_MS), lte: new Date(now.getTime() + STARTING_LEAD_MS) },
  };
  const order = [{ scheduledAt: 'asc' as const }, { id: 'asc' as const }];
  // Two columns and no join: the cost of a `count()`, and seat-scoped to a
  // window a few hours wide, so there is nothing here to bound.
  const windowed = await prisma.interviewRound.findMany({
    where, orderBy: order, select: { id: true, scheduledAt: true, durationMinutes: true },
  });
  const live = windowed.filter((r) => r.scheduledAt.getTime() + r.durationMinutes * 60_000 > now.getTime());
  if (live.length === 0) return { count: 0, drafts: [] as Draft[] };

  // By id, so a page of rows cannot be crowded out by rounds that have already
  // finished sitting ahead of them in the window.
  const wanted = live.slice(0, limit).map((r) => r.id);
  const rows = await prisma.interviewRound.findMany({
    where: { id: { in: wanted } }, orderBy: order,
    select: { id: true, scheduledAt: true, meetingUrl: true, pipeline: { select: sessionSelect } },
  });
  // One assignment read for the page, not one per row — and none at all on the
  // common path, where the reader works in candidate scope and the answer
  // cannot change what they are shown.
  const assigned = capabilitiesOf(role).includes('candidate:read')
    ? new Set<string>()
    : await smeAssignedAmong(userId, rows.map((r) => r.pipeline.candidate.id));

  const drafts: Draft[] = rows.map((r) => {
    const surface = candidateSurfaceFor({
      role, candidateId: r.pipeline.candidate.id, smeAssigned: assigned.has(r.pipeline.candidate.id),
    });
    return {
      id: `round_starting:${r.id}`,
      kind: 'round_starting',
      since: r.scheduledAt.toISOString(),
      candidate: surface.mayName ? { id: r.pipeline.candidate.id, name: r.pipeline.candidate.fullName } : null,
      role: surface.mayName ? { id: r.pipeline.role.id, title: r.pipeline.role.title } : null,
      // What the row is about when it may not say who. Enough to act on — they
      // know whose interview it is once they are in the room — without the
      // queue being the thing that names a person nobody assigned them.
      subject: surface.mayName ? null : 'An interview you are conducting',
      // No session, even where the round has one. `enrichRows` reads a session
      // to name the AI interviewer who ran it and to list who else has opened it;
      // neither says anything true about a human round somebody is walking into.
      sessionId: null,
      assessmentId: null,
      meetingUrl: r.meetingUrl,
      candidatePath: surface.path,
      facts: {},
    };
  });
  return { count: live.length, drafts };
}

/** Which of these candidates this person holds the SME assignment for. */
async function smeAssignedAmong(userId: string, candidateIds: readonly string[]): Promise<ReadonlySet<string>> {
  if (candidateIds.length === 0) return new Set();
  const rows = await prisma.candidateAssignment.findMany({
    where: { userId, relation: SME_RELATION, candidateId: { in: [...new Set(candidateIds)] } },
    select: { candidateId: true },
  });
  return new Set(rows.map((row) => row.candidateId));
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

  const [attention, expiring, stalled, identity, blockedRounds, catalog, demo, starting, stageDecisions] = await Promise.all([
    ATTENTION_KINDS.some(may) ? attentionDrafts(tenantId, candidate, now, scan) : null,
    may('invitation_expiring') ? expiringDrafts(tenantId, candidate, now, scan) : none,
    may('stalled') ? stalledDrafts(tenantId, candidate, now, scan) : none,
    may('identity_code_stuck') ? identityCodeTroubleDrafts(tenantId, candidate, now, scan) : none,
    may('round_not_recordable') ? blockedRoundDrafts(tenantId, candidate, scan) : none,
    may('catalog_proposals') ? catalogDrafts() : none,
    may('demo_request') ? demoDrafts(now, scan) : none,
    may('round_starting') ? startingDrafts(tenantId, auth.userId, auth.role, now, scan) : none,
    may('stage_decision') ? stageDecisionDrafts(tenantId, candidate, scan) : none,
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
  counts.stage_decision = stageDecisions.count;
  drafts.push(...expiring.drafts, ...stalled.drafts, ...identity.drafts, ...blockedRounds.drafts, ...catalog.drafts, ...demo.drafts, ...starting.drafts, ...stageDecisions.drafts);

  const rows = drafts
    .map(({ meetingUrl, candidatePath, ...d }): NeedsYouRow => ({
      ...d, urgent: isUrgent(d.kind), openedBy: [], canAct: canAct(d.kind),
      action: actionFor(d.kind, { ...d, candidateId: d.candidate?.id, meetingUrl, candidatePath }, canAct(d.kind)),
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
