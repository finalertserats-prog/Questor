import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { HttpError } from '../middleware/index.js';
import {
  DEMO_EXTENSION_MS, capAtFor, furtherStage, mayExtend, msLeft, mustFinalise, mustStopAsking,
  type DemoEndReason, type DemoMode, type DemoRunClock,
} from '../domain/demoInterview.js';
import { DEMO_SPEND_PER_DAY, DEMO_SPEND_PER_RUN, refusalIsNotable, spendDayKey, spendVerdict } from '../domain/demoBudget.js';


/**
 * One sitting of the demo interview: its clock, its spend and how it ends.
 *
 * This is the only module that writes DemoInterviewRun, so the fifteen-minute
 * box and the spend ceiling have exactly one enforcement point each. The rules
 * themselves are in domain/demoInterview.ts and domain/demoBudget.ts; what
 * lives here is the reading and writing.
 */

export interface DemoRunRow extends DemoRunClock {
  readonly id: string;
  readonly tenantId: string;
  readonly demoGrantId: string | null;
  readonly sessionId: string;
  readonly mode: DemoMode;
  readonly scriptId: string;
  readonly endReason: string | null;
  readonly stage: string;
}

const SELECT = {
  id: true, tenantId: true, demoGrantId: true, sessionId: true, mode: true, scriptId: true,
  startedAt: true, capAt: true, extendedMs: true, endedAt: true, endReason: true, stage: true,
} as const;

function asRow(row: { mode: string } & Omit<DemoRunRow, 'mode'>): DemoRunRow {
  return { ...row, mode: row.mode as DemoMode };
}

export async function runForSession(sessionId: string): Promise<DemoRunRow | null> {
  const row = await prisma.demoInterviewRun.findUnique({ where: { sessionId }, select: SELECT });
  return row ? asRow(row) : null;
}

export async function runById(id: string): Promise<DemoRunRow | null> {
  const row = await prisma.demoInterviewRun.findUnique({ where: { id }, select: SELECT });
  return row ? asRow(row) : null;
}

/** The sitting this visitor has open, if any. One at a time, per grant. */
export async function liveRunForGrant(demoGrantId: string): Promise<DemoRunRow | null> {
  const row = await prisma.demoInterviewRun.findFirst({
    where: { demoGrantId, endedAt: null },
    orderBy: { startedAt: 'desc' },
    select: SELECT,
  });
  return row ? asRow(row) : null;
}

export async function startRun(input: {
  tenantId: string;
  demoGrantId: string | null;
  sessionId: string;
  mode: DemoMode;
  scriptId?: string;
  extendTime?: boolean;
  now?: Date;
}): Promise<DemoRunRow> {
  const now = input.now ?? new Date();
  // The extension is taken on the way IN, from the choice screen, so it is
  // never a control somebody has to find while a clock is running out.
  const extendedMs = input.extendTime ? DEMO_EXTENSION_MS : 0;
  const row = await prisma.demoInterviewRun.create({
    data: {
      tenantId: input.tenantId,
      demoGrantId: input.demoGrantId,
      sessionId: input.sessionId,
      mode: input.mode,
      scriptId: input.scriptId ?? '',
      startedAt: now,
      capAt: capAtFor(now, extendedMs),
      extendedMs,
      stage: 'chose_mode',
    },
    select: SELECT,
  });
  return asRow(row);
}

/** Move the recorded high-water mark forward. Never backwards. */
export async function noteStage(sessionId: string, stage: string): Promise<void> {
  const run = await runForSession(sessionId);
  if (!run) return;
  const next = furtherStage(run.stage, stage);
  if (next === run.stage) return;
  await prisma.demoInterviewRun.updateMany({ where: { id: run.id }, data: { stage: next } });
}

export async function noteStageForRun(runId: string, stage: string): Promise<void> {
  const run = await runById(runId);
  if (!run) return;
  const next = furtherStage(run.stage, stage);
  if (next === run.stage) return;
  await prisma.demoInterviewRun.updateMany({ where: { id: run.id }, data: { stage: next } });
}

/**
 * Close the sitting's record. Idempotent, and it never reopens one: the first
 * reason recorded is the true one, because the sweep and the visitor's own
 * last request race whenever a tab is closed near the cap.
 */
export async function endRun(runId: string, reason: DemoEndReason, now = new Date()): Promise<boolean> {
  const closed = await prisma.demoInterviewRun.updateMany({
    where: { id: runId, endedAt: null },
    data: { endedAt: now, endReason: reason },
  });
  return closed.count === 1;
}

/**
 * The one extension, taken while the sitting is already under way.
 *
 * Also offered on the choice screen; this is for someone who did not know they
 * would need it. Refused once used, so it cannot become an unbounded demo.
 */
export async function extendRun(runId: string): Promise<DemoRunRow> {
  const run = await runById(runId);
  if (!run) throw new HttpError(404, 'That demo interview is not running.');
  if (!mayExtend(run)) throw new HttpError(409, 'This demo has already been given extra time.');
  const row = await prisma.demoInterviewRun.update({
    where: { id: runId },
    data: { extendedMs: DEMO_EXTENSION_MS, capAt: capAtFor(run.startedAt, DEMO_EXTENSION_MS) },
    select: SELECT,
  });
  return asRow(row);
}

export interface DemoClockView {
  readonly msLeft: number;
  readonly mayExtend: boolean;
  readonly closing: boolean;
  readonly ended: boolean;
}

export function clockView(run: DemoRunRow, now = new Date()): DemoClockView {
  return {
    msLeft: msLeft(now, run),
    mayExtend: mayExtend(run),
    closing: mustStopAsking(now, run),
    ended: run.endedAt !== null,
  };
}

/**
 * Whether this interview must now be carried to its close.
 *
 * Called from the engine as it decides the next turn. Answering true does NOT
 * end anything: it swaps the director's decision for the close the director
 * already knows how to make, so the interviewer speaks a whole closing turn.
 * Nothing is ever cut mid-sentence — the server declines to produce the NEXT
 * turn, it never interrupts one.
 */
export async function sessionMustClose(sessionId: string, now = new Date()): Promise<boolean> {
  const run = await runForSession(sessionId);
  return run !== null && mustStopAsking(now, run);
}

export async function sessionMustFinalise(sessionId: string, now = new Date()): Promise<boolean> {
  const run = await runForSession(sessionId);
  return run !== null && mustFinalise(now, run);
}

/**
 * Claim one reactive model call for this interview, or refuse.
 *
 * Claims BEFORE the call, not after: a call that is made and then counted lets
 * a burst of concurrent turns all read the same count and all spend. The day's
 * unit is taken with a single conditional statement (see `claimDayUnit`), so
 * two instances cannot both believe they hold the day's last one.
 *
 * Refusing is silent by design. The interview carries on with the built-in
 * writer and the visitor is told nothing, because there is nothing they could
 * do and an interviewer that announced its own funding would be the least
 * convincing thing in the demo.
 */
export async function claimModelCall(fn: string, sessionId: string | undefined, now = new Date()): Promise<boolean> {
  if (!sessionId) return false;
  const run = await runForSession(sessionId);
  if (!run) return false;

  const dayKey = spendDayKey(now);
  const runSpent = await prisma.demoModelSpend.count({ where: { runId: run.id } });
  const day = await prisma.demoSpendDay.findUnique({ where: { dayKey }, select: { calls: true } });

  const verdict = spendVerdict(fn, { mode: run.mode, ended: run.endedAt !== null, runSpent, daySpent: day?.calls ?? 0 });
  if (verdict !== 'allow') {
    if (refusalIsNotable(verdict)) {
      logger.warn(
        { dayKey, daySpent: day?.calls ?? 0, ceiling: DEMO_SPEND_PER_DAY },
        'Demo model spend for today is used up; demo interviews are now running on the built-in writer',
      );
    }
    return false;
  }
  if (!(await claimDayUnit(dayKey))) return false;

  try {
    await prisma.demoModelSpend.create({ data: { runId: run.id, tenantId: run.tenantId, dayKey, fn } });
  } catch (err) {
    // The unit is already claimed. Losing the audit row is worth a log, not a
    // refund: handing it back would need a second statement that can fail too.
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Could not record a demo model call against its sitting');
  }
  return true;
}

/**
 * Take one of the day's units, or answer no.
 *
 * A conditional increment in ONE statement, because read-then-write is exactly
 * how a burst of concurrent turns all read the same count and all spend. The
 * `calls < ceiling` guard lives in the WHERE clause, so the database decides
 * who gets the last unit rather than whichever instance read first.
 */
async function claimDayUnit(dayKey: string): Promise<boolean> {
  const taken = await prisma.demoSpendDay.updateMany({
    where: { dayKey, calls: { lt: DEMO_SPEND_PER_DAY } },
    data: { calls: { increment: 1 } },
  });
  if (taken.count === 1) return true;

  // No row for today yet. Create it already holding this call; if another
  // instance created it first, take the ordinary path once more.
  try {
    await prisma.demoSpendDay.create({ data: { dayKey, calls: 1 } });
    return true;
  } catch {
    const retried = await prisma.demoSpendDay.updateMany({
      where: { dayKey, calls: { lt: DEMO_SPEND_PER_DAY } },
      data: { calls: { increment: 1 } },
    });
    return retried.count === 1;
  }
}

export const DEMO_SPEND_CEILINGS = { perRun: DEMO_SPEND_PER_RUN, perDay: DEMO_SPEND_PER_DAY } as const;
