import type { RunState } from './checkpoint.js';

/**
 * Counts for the owner: what was generated, accepted and rejected (by reason),
 * how many lane calls each accepted entry cost, and how long it took. Built
 * from the saved state and the run log, never from prompt or question text.
 */

export interface LogEvent {
  readonly at: string;
  readonly event: string;
  readonly lane?: string;
  readonly role?: string;
  readonly ok?: boolean;
  readonly ms?: number;
  readonly reason?: string;
}

export interface RunSummary {
  readonly pools: { readonly total: number; readonly done: number; readonly failed: number; readonly pending: number };
  readonly standardsCreated: number;
  readonly generated: number;
  readonly accepted: number;
  readonly acceptedWithTiebreak: number;
  readonly rejected: number;
  readonly rejectedByStage: Record<string, number>;
  readonly rejectedByReason: Record<string, number>;
  readonly calls: { readonly total: number; readonly ok: number; readonly failed: number; readonly byLane: Record<string, { calls: number; ok: number; usageLimits: number; avgMs: number }>; readonly byRole: Record<string, number> };
  readonly wallClockMinutes: number;
  readonly callsPerAccepted: number;
  readonly acceptedPerHour: number;
  readonly acceptedByLane: Record<string, number>;
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

export function summarize(state: RunState, events: readonly LogEvent[]): RunSummary {
  const progress = Object.values(state.pools);
  const accepted = progress.flatMap((p) => p.accepted);
  const rejected = progress.flatMap((p) => p.rejected);
  const rejectedByStage: Record<string, number> = {};
  const rejectedByReason: Record<string, number> = {};
  for (const r of rejected) {
    bump(rejectedByStage, r.stage);
    for (const reason of new Set(r.reasons)) bump(rejectedByReason, reason);
  }
  const acceptedByLane: Record<string, number> = {};
  for (const q of accepted) bump(acceptedByLane, q.provenance.generatorLane);

  const calls = events.filter((e) => e.event === 'call');
  const byLane: RunSummary['calls']['byLane'] = {};
  const byRole: Record<string, number> = {};
  const msByLane: Record<string, number> = {};
  for (const c of calls) {
    const lane = c.lane ?? 'unknown';
    const entry = byLane[lane] ?? { calls: 0, ok: 0, usageLimits: 0, avgMs: 0 };
    byLane[lane] = { ...entry, calls: entry.calls + 1, ok: entry.ok + (c.ok ? 1 : 0), usageLimits: entry.usageLimits + (c.reason === 'usage_limit' ? 1 : 0) };
    if (c.ok && typeof c.ms === 'number') bump(msByLane, lane, c.ms);
    bump(byRole, c.role ?? 'unknown');
  }
  for (const [lane, entry] of Object.entries(byLane)) byLane[lane] = { ...entry, avgMs: entry.ok > 0 ? Math.round((msByLane[lane] ?? 0) / entry.ok) : 0 };

  const times = events.map((e) => Date.parse(e.at)).filter(Number.isFinite);
  const wallMs = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
  const okCalls = calls.filter((c) => c.ok).length;
  return {
    pools: {
      total: progress.length, done: progress.filter((p) => p.status === 'done').length,
      failed: progress.filter((p) => p.status === 'failed').length, pending: progress.filter((p) => p.status === 'pending').length,
    },
    standardsCreated: Object.keys(state.standards).length,
    generated: accepted.length + rejected.filter((r) => r.stage !== 'parse' || r.questionText).length,
    accepted: accepted.length,
    acceptedWithTiebreak: accepted.filter((q) => q.tiebreak).length,
    rejected: rejected.length,
    rejectedByStage, rejectedByReason,
    calls: { total: calls.length, ok: okCalls, failed: calls.length - okCalls, byLane, byRole },
    wallClockMinutes: Math.round(wallMs / 600) / 100,
    callsPerAccepted: accepted.length > 0 ? Math.round((calls.length / accepted.length) * 100) / 100 : 0,
    acceptedPerHour: wallMs > 0 ? Math.round((accepted.length / (wallMs / 3_600_000)) * 10) / 10 : 0,
    acceptedByLane,
  };
}
