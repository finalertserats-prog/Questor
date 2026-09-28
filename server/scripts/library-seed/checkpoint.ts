import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { SeedPool } from '../../src/library/seedExport.js';
import type { QuestionRecord, StandardRecord } from '../../src/library/seedFormat.js';
import type { Lane } from './lanes.js';
import type { RejectedItem } from './pipeline.js';
import type { Assignment, LaneSnapshot } from './scheduler.js';

/**
 * Run state for resume. Saved atomically (write, then rename) after every
 * pool, with the lanes' cool-downs, so a run stopped by Ctrl-C, a reboot or a
 * usage limit picks up where it left off. The JSONL for the import is always
 * rewritten from this state, so it can never hold half a pool.
 */

export type PoolStatus = 'pending' | 'done' | 'failed';

export interface PoolProgress {
  readonly status: PoolStatus;
  readonly attempts: number;
  readonly accepted: readonly QuestionRecord[];
  readonly rejected: readonly RejectedItem[];
  readonly errors: readonly string[];
  readonly assignment?: Assignment;
  readonly finishedAt?: string;
}

export interface RunState {
  readonly version: 1;
  readonly runId: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly pools: Readonly<Record<string, PoolProgress>>;
  readonly standards: Readonly<Record<string, StandardRecord>>;
  readonly lanes: Partial<Record<Lane, LaneSnapshot>>;
}

const PENDING: PoolProgress = { status: 'pending', attempts: 0, accepted: [], rejected: [], errors: [] };

export function newState(runId: string, now: Date): RunState {
  return { version: 1, runId, startedAt: now.toISOString(), updatedAt: now.toISOString(), pools: {}, standards: {}, lanes: {} };
}

/** Adds any pool of the file the state has not seen, leaving finished ones alone. */
export function withPools(state: RunState, pools: readonly SeedPool[]): RunState {
  const next = { ...state.pools };
  for (const pool of pools) if (!next[pool.key]) next[pool.key] = PENDING;
  return { ...state, pools: next };
}

export function loadState(path: string): RunState | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as RunState;
  if (parsed.version !== 1 || typeof parsed.runId !== 'string') throw new Error(`${path} is not a seed run state file`);
  return parsed;
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

export function saveState(path: string, state: RunState): void {
  writeAtomic(path, `${JSON.stringify(state, null, 1)}\n`);
}

/** Standards first (the import needs them before the questions that use them), then questions in pool order. */
export function jsonlFrom(state: RunState, poolOrder: readonly string[]): string {
  const standards = Object.keys(state.standards).sort().map((k) => JSON.stringify(state.standards[k]));
  const questions = poolOrder.flatMap((key) => (state.pools[key]?.accepted ?? []).map((q) => JSON.stringify(q)));
  return [...standards, ...questions].map((l) => `${l}\n`).join('');
}

export function writeJsonl(path: string, state: RunState, poolOrder: readonly string[]): void {
  writeAtomic(path, jsonlFrom(state, poolOrder));
}

/** The run log: one JSON line per event, never prompt or question text. */
export function runLogger(path: string, now: () => Date): (event: Record<string, unknown>) => void {
  return (event) => appendFileSync(path, `${JSON.stringify({ at: now().toISOString(), ...event })}\n`, 'utf8');
}
