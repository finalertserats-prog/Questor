import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { candidateScope } from './access.js';
import { COMPLETED_STATES } from './dashboardMetrics.js';
import { interviewerIdOf, listActiveInterviewers } from './interviewers.js';
import { LIVE_INTERVIEW_STATES } from './observerPolicy.js';
import { tenantTimeZone } from './tenantTimeZone.js';
import { zonedLocalToUtc, zonedWallClock } from './zonedTime.js';
import { EXCEPTION_STATES } from '../domain/stateMachine.js';
import { collectNeedsYou, enrichRows, type NeedsYouCounts, type NeedsYouRow } from './needsYouRows.js';
import type { AuthClaims } from './auth.js';
import type { Paging } from './listPaging.js';

/**
 * HR-Box: what needs the caller (the queue), what is coming up (interviews
 * today and this week) and what was done recently, plus the five interviewers
 * and what each is doing now. All of it scoped to the caller's candidates.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const UPCOMING_DAYS = 7;
const DONE_DAYS = 7;
const UPCOMING_LIMIT = 20;
const DONE_LIMIT = 12;
/**
 * A live-looking state with no activity for this long is a tab someone closed
 * before the interview began (the stalled sweep only closes out interviews that
 * got as far as the disclosure). It is not shown as live.
 */
const LIVE_QUIET_MS = 2 * HOUR_MS;
const NOT_UPCOMING = [...EXCEPTION_STATES, ...COMPLETED_STATES, ...LIVE_INTERVIEW_STATES];

export interface ComingUpItem {
  readonly id: string;
  readonly kind: 'ai' | 'human';
  readonly at: string;
  readonly timeZone: string | null;
  readonly live: boolean;
  readonly candidate: { readonly id: string; readonly name: string };
  readonly role: { readonly id: string; readonly title: string };
  readonly interviewerId: string | null;
  readonly interviewerName: string | null;
  readonly to: string;
}

export type DoneKind = 'interview_completed' | 'review_completed' | 'decision' | 'reminder_sent';

export interface DoneItem {
  readonly id: string;
  readonly kind: DoneKind;
  readonly at: string;
  readonly candidate: { readonly id: string; readonly name: string };
  readonly role: { readonly id: string; readonly title: string } | null;
  /** The interviewer for a completed interview, the reviewer for a review. */
  readonly by: string | null;
  /** A decision's outcome, or a review's disposition. */
  readonly outcome: string | null;
  readonly interviewerId: string | null;
  readonly to: string;
}

export type CrewStatus = 'live' | 'scheduled' | 'done' | 'idle';

export interface CrewMember {
  readonly id: string;
  readonly name: string;
  readonly status: CrewStatus;
  /** First name of the candidate they are with, next with, or last finished with (today). */
  readonly candidateFirstName: string | null;
  readonly at: string | null;
}

export interface NeedsYouFeed {
  readonly generatedAt: string;
  /** The organisation's zone, which "today" is counted in. */
  readonly timeZone: string;
  readonly needsYou: {
    readonly total: number;
    readonly counts: NeedsYouCounts;
    readonly items: readonly NeedsYouRow[];
    readonly page: number;
    readonly pageSize: number;
  };
  readonly comingUp: readonly ComingUpItem[];
  readonly doneRecently: readonly DoneItem[];
  readonly crew: readonly CrewMember[];
}

/** Midnight today on the organisation's clock. */
export function startOfDay(now: Date, timeZone: string): Date {
  const day = zonedWallClock(now, timeZone).slice(0, 10);
  const midnight = zonedLocalToUtc(`${day}T00:00`, timeZone);
  // A zone that skips midnight (a few do, on the changeover day) has no such instant.
  return midnight.ok ? midnight.at : new Date(now.getTime() - DAY_MS);
}

const personSelect = {
  candidate: { select: { id: true, fullName: true } },
  role: { select: { id: true, title: true } },
} as const;

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

async function comingUp(tenantId: string, candidate: Prisma.CandidateWhereInput, now: Date, dayStart: Date, names: ReadonlyMap<string, string>): Promise<ComingUpItem[]> {
  const horizon = new Date(now.getTime() + UPCOMING_DAYS * DAY_MS);
  const [live, scheduled, rounds] = await Promise.all([
    prisma.interviewSession.findMany({
      where: { tenantId, candidate, state: { in: [...LIVE_INTERVIEW_STATES] }, updatedAt: { gte: new Date(now.getTime() - LIVE_QUIET_MS) } },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }], take: UPCOMING_LIMIT,
      select: { id: true, startedAt: true, updatedAt: true, scheduledTimeZone: true, personaJson: true, ...personSelect },
    }),
    prisma.interviewSession.findMany({
      where: { tenantId, candidate, scheduledAt: { gte: dayStart, lt: horizon }, state: { notIn: NOT_UPCOMING } },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }], take: UPCOMING_LIMIT,
      select: { id: true, scheduledAt: true, scheduledTimeZone: true, personaJson: true, ...personSelect },
    }),
    prisma.interviewRound.findMany({
      where: { tenantId, pipeline: { candidate }, conductedBy: 'HUMAN', status: 'SCHEDULED', scheduledAt: { gte: dayStart, lt: horizon } },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }], take: UPCOMING_LIMIT,
      select: { id: true, scheduledAt: true, scheduledTimeZone: true, pipeline: { select: personSelect } },
    }),
  ]);
  const ai = (s: { id: string; personaJson: string; scheduledTimeZone: string | null; candidate: { id: string; fullName: string }; role: { id: string; title: string } }, at: Date, isLive: boolean): ComingUpItem => {
    const interviewerId = interviewerIdOf(s.personaJson, s.id);
    return {
      id: s.id, kind: 'ai', at: at.toISOString(), timeZone: s.scheduledTimeZone, live: isLive,
      candidate: { id: s.candidate.id, name: s.candidate.fullName }, role: s.role,
      interviewerId, interviewerName: interviewerId ? names.get(interviewerId) ?? null : null, to: `/interviews/${s.id}`,
    };
  };
  const items = [
    ...live.map((s) => ai(s, s.startedAt ?? s.updatedAt, true)),
    ...scheduled.map((s) => ai(s, s.scheduledAt ?? now, false)),
    ...rounds.map((r): ComingUpItem => ({
      id: r.id, kind: 'human', at: r.scheduledAt.toISOString(), timeZone: r.scheduledTimeZone, live: false,
      candidate: { id: r.pipeline.candidate.id, name: r.pipeline.candidate.fullName }, role: r.pipeline.role,
      interviewerId: null, interviewerName: null, to: `/candidates/${r.pipeline.candidate.id}`,
    })),
  ];
  return items
    .sort((a, b) => Number(b.live) - Number(a.live) || a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    .slice(0, UPCOMING_LIMIT);
}

async function doneRecently(tenantId: string, candidate: Prisma.CandidateWhereInput, now: Date, names: ReadonlyMap<string, string>): Promise<DoneItem[]> {
  const since = new Date(now.getTime() - DONE_DAYS * DAY_MS);
  const [interviews, reviews, decisions, reminders] = await Promise.all([
    prisma.interviewSession.findMany({
      where: { tenantId, candidate, completedAt: { gte: since }, state: { in: COMPLETED_STATES } },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }], take: DONE_LIMIT,
      select: { id: true, completedAt: true, personaJson: true, ...personSelect },
    }),
    prisma.humanReview.findMany({
      where: { status: 'COMPLETED', completedAt: { gte: since }, supersededAt: null, assessment: { session: { tenantId, candidate } } },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }], take: DONE_LIMIT,
      select: { id: true, completedAt: true, disposition: true, assessmentId: true, reviewer: { select: { name: true } }, assessment: { select: { session: { select: personSelect } } } },
    }),
    prisma.candidatePipeline.findMany({
      where: { tenantId, candidate, status: 'DECIDED', decidedAt: { gte: since } },
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }], take: DONE_LIMIT,
      select: { id: true, decidedAt: true, decision: true, ...personSelect },
    }),
    prisma.invitationReminder.findMany({
      where: { tenantId, status: 'sent', recipientKey: 'candidate', sentAt: { gte: since }, session: { candidate } },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }], take: DONE_LIMIT,
      select: { id: true, sentAt: true, sessionId: true, session: { select: personSelect } },
    }),
  ]);
  const items: DoneItem[] = [
    ...interviews.map((s): DoneItem => {
      const interviewerId = interviewerIdOf(s.personaJson, s.id);
      return {
        id: `interview:${s.id}`, kind: 'interview_completed', at: (s.completedAt ?? now).toISOString(),
        candidate: { id: s.candidate.id, name: s.candidate.fullName }, role: s.role,
        by: interviewerId ? names.get(interviewerId) ?? null : null, outcome: null, interviewerId, to: `/interviews/${s.id}`,
      };
    }),
    ...reviews.map((r): DoneItem => ({
      id: `review:${r.id}`, kind: 'review_completed', at: (r.completedAt ?? now).toISOString(),
      candidate: { id: r.assessment.session.candidate.id, name: r.assessment.session.candidate.fullName }, role: r.assessment.session.role,
      by: r.reviewer.name, outcome: r.disposition || null, interviewerId: null, to: `/assessments/${r.assessmentId}`,
    })),
    ...decisions.map((p): DoneItem => ({
      id: `decision:${p.id}`, kind: 'decision', at: (p.decidedAt ?? now).toISOString(),
      candidate: { id: p.candidate.id, name: p.candidate.fullName }, role: p.role,
      by: null, outcome: p.decision, interviewerId: null, to: `/candidates/${p.candidate.id}`,
    })),
    ...reminders.map((r): DoneItem => ({
      id: `reminder:${r.id}`, kind: 'reminder_sent', at: (r.sentAt ?? now).toISOString(),
      candidate: { id: r.session.candidate.id, name: r.session.candidate.fullName }, role: r.session.role,
      by: null, outcome: null, interviewerId: null, to: `/interviews/${r.sessionId}`,
    })),
  ];
  return items.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id)).slice(0, DONE_LIMIT);
}

/**
 * The five interviewers and what each is doing for the caller's candidates:
 * live with someone, next up today, finished with someone today, or free.
 */
export function crewOf(
  interviewers: readonly { id: string; name: string }[], upcoming: readonly ComingUpItem[], done: readonly DoneItem[], dayStart: Date, dayEnd: Date,
): CrewMember[] {
  return interviewers.map((iv) => {
    const live = upcoming.find((u) => u.live && u.interviewerId === iv.id);
    if (live) return { id: iv.id, name: iv.name, status: 'live', candidateFirstName: firstName(live.candidate.name), at: live.at };
    const next = upcoming.find((u) => !u.live && u.interviewerId === iv.id && u.at < dayEnd.toISOString() && u.at >= dayStart.toISOString());
    if (next) return { id: iv.id, name: iv.name, status: 'scheduled', candidateFirstName: firstName(next.candidate.name), at: next.at };
    const finished = done.find((d) => d.kind === 'interview_completed' && d.interviewerId === iv.id && d.at >= dayStart.toISOString());
    if (finished) return { id: iv.id, name: iv.name, status: 'done', candidateFirstName: firstName(finished.candidate.name), at: finished.at };
    return { id: iv.id, name: iv.name, status: 'idle', candidateFirstName: null, at: null };
  });
}

export async function getNeedsYou(auth: AuthClaims, paging: Paging, now: Date = new Date()): Promise<NeedsYouFeed> {
  const [candScope, timeZone, interviewers] = await Promise.all([candidateScope(auth), tenantTimeZone(auth.tenantId), listActiveInterviewers()]);
  const candidate = candScope as Prisma.CandidateWhereInput;
  const dayStart = startOfDay(now, timeZone);
  const dayEnd = startOfDay(new Date(dayStart.getTime() + DAY_MS + 2 * HOUR_MS), timeZone);
  const names = new Map(interviewers.map((i) => [i.id, i.name]));
  const [queue, upcoming, done] = await Promise.all([
    collectNeedsYou(auth, now),
    comingUp(auth.tenantId, candidate, now, dayStart, names),
    doneRecently(auth.tenantId, candidate, now, names),
  ]);
  const start = (paging.page - 1) * paging.pageSize;
  const items = await enrichRows(auth, queue.rows.slice(start, start + paging.pageSize), now);
  return {
    generatedAt: now.toISOString(),
    timeZone,
    needsYou: { total: queue.total, counts: queue.counts, items, page: paging.page, pageSize: paging.pageSize },
    comingUp: upcoming,
    doneRecently: done,
    crew: crewOf(interviewers, upcoming, done, dayStart, dayEnd),
  };
}

/** The bell's number: how many rows wait on the caller. Counts only. */
export async function countNeedsYou(auth: AuthClaims, now: Date = new Date()): Promise<{ total: number; urgent: number }> {
  const { counts, total } = await collectNeedsYou(auth, now, 1);
  return { total, urgent: counts.human_request + counts.accommodation };
}
