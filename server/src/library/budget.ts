import { prisma } from '../db.js';

/**
 * What the worker may spend: model calls per UTC day (generator and critic
 * together, as `catalogRefreshChunk` counts) and tokens over any rolling 30
 * days. A day row is written before a batch runs, so a crash mid-batch
 * counts the calls it made rather than forgetting them.
 */

export interface BudgetRoomInput {
  readonly callsUsedToday: number;
  readonly dailyCap: number;
  readonly tokens30d: number;
  readonly monthlyCap: number;
  readonly callsNeeded: number;
  /** Tokens the work about to start is expected to cost; the rolling cap must leave room for it. */
  readonly tokensNeeded?: number;
}

export type BudgetRefusal = 'daily_cap' | 'monthly_cap';

export function budgetRoom(input: BudgetRoomInput): { readonly ok: boolean; readonly reason?: BudgetRefusal } {
  if (input.tokens30d + (input.tokensNeeded ?? 0) > input.monthlyCap || input.tokens30d >= input.monthlyCap) return { ok: false, reason: 'monthly_cap' };
  if (input.callsUsedToday + input.callsNeeded > input.dailyCap) return { ok: false, reason: 'daily_cap' };
  return { ok: true };
}

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function msUntilNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return next - now.getTime();
}

export const ROLLING_WINDOW_DAYS = 30;

export interface BudgetStatus {
  readonly day: string;
  readonly callsUsedToday: number;
  readonly dailyCap: number;
  readonly tokens30d: number;
  readonly monthlyCap: number;
  readonly tokensToday: number;
}

export async function budgetStatus(caps: { readonly dailyCap: number; readonly monthlyCap: number }, now = new Date()): Promise<BudgetStatus> {
  const day = utcDay(now);
  const today = await prisma.libraryBudget.findUnique({ where: { day } });
  const sinceDay = utcDay(new Date(now.getTime() - ROLLING_WINDOW_DAYS * 24 * 60 * 60_000));
  const window = await prisma.libraryBudget.aggregate({ where: { day: { gte: sinceDay } }, _sum: { inputTokens: true, outputTokens: true } });
  return {
    day,
    callsUsedToday: today?.callsUsed ?? 0,
    dailyCap: caps.dailyCap,
    tokens30d: (window._sum.inputTokens ?? 0) + (window._sum.outputTokens ?? 0),
    monthlyCap: caps.monthlyCap,
    tokensToday: (today?.inputTokens ?? 0) + (today?.outputTokens ?? 0),
  };
}

/**
 * Take `calls` from today's allowance if they fit under both caps. The day
 * row is created on first use; the conditional update means two concurrent
 * batches cannot both squeeze under the cap.
 */
export async function reserveCalls(caps: { readonly dailyCap: number; readonly monthlyCap: number }, calls: number, tokensNeeded: number, now = new Date()): Promise<{ readonly ok: boolean; readonly reason?: BudgetRefusal }> {
  const status = await budgetStatus(caps, now);
  const room = budgetRoom({ callsUsedToday: status.callsUsedToday, dailyCap: caps.dailyCap, tokens30d: status.tokens30d, monthlyCap: caps.monthlyCap, callsNeeded: calls, tokensNeeded });
  if (!room.ok) return room;
  await prisma.libraryBudget.upsert({ where: { day: status.day }, create: { day: status.day, callsCap: caps.dailyCap, callsUsed: 0 }, update: {} });
  const taken = await prisma.libraryBudget.updateMany({
    where: { day: status.day, callsUsed: { lte: caps.dailyCap - calls } },
    data: { callsUsed: { increment: calls }, callsCap: caps.dailyCap },
  });
  return taken.count === 1 ? { ok: true } : { ok: false, reason: 'daily_cap' };
}

/** Add what a batch actually cost in tokens (calls were reserved up front). */
export async function recordTokens(tokens: { readonly input: number; readonly output: number }, now = new Date()): Promise<void> {
  const day = utcDay(now);
  await prisma.libraryBudget.upsert({
    where: { day },
    create: { day, callsCap: 0, inputTokens: tokens.input, outputTokens: tokens.output },
    update: { inputTokens: { increment: tokens.input }, outputTokens: { increment: tokens.output } },
  });
}

/** Give back calls reserved for a batch that never reached the provider. */
export async function releaseCalls(calls: number, now = new Date()): Promise<void> {
  await prisma.libraryBudget.updateMany({ where: { day: utcDay(now), callsUsed: { gte: calls } }, data: { callsUsed: { decrement: calls } } });
}
