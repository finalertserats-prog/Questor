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
  readonly reservedCalls: number;
  readonly modelCalls: number;
}

const SELECT = {
  id: true, tenantId: true, demoGrantId: true, sessionId: true, mode: true, scriptId: true,
  startedAt: true, capAt: true, extendedMs: true, endedAt: true, endReason: true, stage: true,
  reservedCalls: true, modelCalls: true,
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
  /** Reactive model calls already claimed from the day for this sitting. */
  reservedCalls?: number;
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
      reservedCalls: input.reservedCalls ?? 0,
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
  if (run.endedAt) throw new HttpError(409, 'That demo interview has finished.');
  // Conditional, so a double press cannot extend twice; and the loser of the
  // race is handed the already-extended clock rather than an error, because
  // pressing a button twice is not a mistake worth explaining.
  await prisma.demoInterviewRun.updateMany({
    where: { id: runId, endedAt: null, extendedMs: 0 },
    data: { extendedMs: DEMO_EXTENSION_MS, capAt: capAtFor(run.startedAt, DEMO_EXTENSION_MS) },
  });
  const row = await runById(runId);
  if (!row) throw new HttpError(404, 'That demo interview is not running.');
  return row;
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
 * a burst of concurrent turns all read the same count and all spend. The claim
 * is one conditional statement against this sitting's own reservation, so the
 * database decides who gets its last unit rather than whichever turn read
 * first. The DAY was claimed whole, once, when the sitting started.
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

  const verdict = spendVerdict(fn, {
    mode: run.mode,
    ended: run.endedAt !== null,
    runSpent: run.modelCalls,
    reserved: run.reservedCalls,
  });
  if (verdict !== 'allow') {
    if (refusalIsNotable(verdict)) {
      logger.warn(
        { runId: run.id, reserved: run.reservedCalls },
        'A demo interview has used its whole model allowance; the rest of it runs on the built-in writer',
      );
    }
    return false;
  }

  // ONE conditional statement. The read above is only to decide WHY a refusal
  // happened; the claim itself is this, and the `modelCalls < reservedCalls`
  // guard lives in the WHERE clause. Read-then-write is exactly how two
  // concurrent turns both read eleven, both pass the ceiling, and both spend.
  const claimed = await prisma.demoInterviewRun.updateMany({
    where: { id: run.id, endedAt: null, modelCalls: { lt: run.reservedCalls } },
    data: { modelCalls: { increment: 1 } },
  });
  if (claimed.count !== 1) return false;

  try {
    await prisma.demoModelSpend.create({
      // The day this sitting's allowance came OUT of, not the day the call
      // happens to land on. A sitting that starts at 23:58 and answers at
      // 00:05 spent yesterday's reservation, and the record has to agree with
      // the counter or the two cannot be reconciled.
      data: { runId: run.id, tenantId: run.tenantId, dayKey: spendDayKey(run.startedAt), fn },
    });
  } catch (err) {
    // The unit is already claimed. Losing the audit row is worth a log, not a
    // refund: handing it back would need a second statement that can fail too.
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Could not record a demo model call against its sitting');
  }
  return true;
}

/**
 * Claim a whole sitting's worth of the day's allowance, or answer no.
 *
 * Taken ONCE, before the interview starts, for two reasons that both come from
 * the owner. Nothing may break character once an interview is under way, so
 * the decision has to be made before it begins. And readiness has already told
 * this visitor their interview would be properly delivered: a promise that is
 * re-checked every turn is not a promise.
 *
 * A sitting that ends early does not hand its unused reservation back. That is
 * deliberate and it is the conservative direction: the alternative is a refund
 * path that can itself fail, leaving the day's ceiling wrong in the direction
 * that costs money.
 */
export async function reserveSitting(now = new Date()): Promise<Reservation> {
  const dayKey = spendDayKey(now);
  // A conditional increment by the whole reservation, so two starts cannot
  // both take the day's last sitting.
  const taken = await prisma.demoSpendDay.updateMany({
    where: { dayKey, calls: { lte: DEMO_SPEND_PER_DAY - DEMO_SPEND_PER_RUN } },
    data: { calls: { increment: DEMO_SPEND_PER_RUN } },
  });
  if (taken.count === 1) return { calls: DEMO_SPEND_PER_RUN, dayKey };

  try {
    await prisma.demoSpendDay.create({ data: { dayKey, calls: DEMO_SPEND_PER_RUN } });
    return { calls: DEMO_SPEND_PER_RUN, dayKey };
  } catch {
    const retried = await prisma.demoSpendDay.updateMany({
      where: { dayKey, calls: { lte: DEMO_SPEND_PER_DAY - DEMO_SPEND_PER_RUN } },
      data: { calls: { increment: DEMO_SPEND_PER_RUN } },
    });
    if (retried.count === 1) return { calls: DEMO_SPEND_PER_RUN, dayKey };
  }
  logger.warn({ dayKey }, 'The day has no room for another demo interview; the candidate-side mode is withdrawn until tomorrow');
  return { calls: 0, dayKey };
}

/** What a start claimed, and the day it claimed it from. */
export interface Reservation {
  readonly calls: number;
  /** The day whose ceiling this came out of — NOT the day the calls happen. */
  readonly dayKey: string;
}

/**
 * Hand a reservation back, for a start that claimed one and then failed.
 *
 * Takes the day it was claimed FROM rather than reading the clock again: a
 * start that reserved at 23:59 and failed at 00:01 would otherwise refund
 * tomorrow, leaving yesterday over-counted and handing today free capacity.
 *
 * Clamped at zero so a double release can never push a day's count negative.
 * Best effort: a refund that fails leaves the ceiling wrong in the direction
 * that costs money rather than the direction that loses a demo.
 */
export async function releaseSitting(dayKey: string): Promise<void> {
  try {
    await prisma.demoSpendDay.updateMany({
      where: { dayKey, calls: { gte: DEMO_SPEND_PER_RUN } },
      data: { calls: { decrement: DEMO_SPEND_PER_RUN } },
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Could not hand back a demo interview reservation');
  }
}

export const DEMO_SPEND_CEILINGS = { perRun: DEMO_SPEND_PER_RUN, perDay: DEMO_SPEND_PER_DAY } as const;

/**
 * Whether this interview may use the paid voice.
 *
 * True only for a live candidate-side sitting — the one the readiness check
 * declined to offer at all unless real speech was configured. Observer mode is
 * written and never speaks; every other demo surface keeps the browser's own
 * voice, as it always has.
 */
export async function demoInterviewUsesRealVoice(sessionId: string): Promise<boolean> {
  const run = await runForSession(sessionId);
  return run !== null && run.mode === 'candidate' && run.endedAt === null;
}
