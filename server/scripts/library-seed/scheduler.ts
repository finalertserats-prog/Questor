import type { Lane } from './lanes.js';
import { LaneLimitError } from './provider.js';

/**
 * Pacing and rotation across the lanes. Each lane runs one call at a time, at
 * least `minGapMs` apart; a usage limit parks the lane until the time the lane
 * gave (or an hour); repeated failures back off exponentially. Roles rotate
 * across pools so no lane both writes and judges the same batch, and each
 * lane writes about a third of the library.
 */

export interface LaneSnapshot {
  readonly cooldownUntil: number;
  readonly failures: number;
  readonly calls: number;
}

export interface Assignment {
  readonly generator: Lane;
  readonly critic: Lane;
  /** The third lane, asked only when the critic fails a question. */
  readonly tiebreak: Lane | null;
}

/**
 * Lanes that write by default (owner decision 2026-09-22): in the pilot Gemini
 * wrote 3 accepted questions of 40 against 24 of 44 for each of the others,
 * so it judges and breaks ties only.
 */
export const DEFAULT_GENERATORS: readonly Lane[] = ['claude', 'codex'];

/** The writers for a run: the explicit list, or the default writers among the lanes in use. */
export function generatorsFor(lanes: readonly Lane[], explicit?: readonly string[]): Lane[] {
  if (explicit && explicit.length > 0) {
    const chosen = explicit.filter((l): l is Lane => (lanes as readonly string[]).includes(l));
    if (chosen.length !== explicit.length) throw new Error('--generators must name lanes that are in --lanes');
    return chosen;
  }
  const defaults = lanes.filter((l) => DEFAULT_GENERATORS.includes(l));
  return defaults.length > 0 ? defaults : [...lanes];
}

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}

export class LaneScheduler {
  private readonly state = new Map<Lane, { cooldownUntil: number; nextAt: number; failures: number; calls: number; queue: Promise<void> }>();

  constructor(
    readonly lanes: readonly Lane[],
    private readonly opts: {
      readonly minGapMs: number;
      readonly now: () => number;
      readonly sleep: (ms: number) => Promise<void>;
      readonly maxCallsPerLane?: number;
      /** Lanes allowed to write questions and standards; every lane may still critique. All when omitted. */
      readonly generators?: readonly Lane[];
    },
    saved: Partial<Record<Lane, LaneSnapshot>> = {},
  ) {
    for (const lane of lanes) {
      const s = saved[lane];
      this.state.set(lane, { cooldownUntil: s?.cooldownUntil ?? 0, nextAt: 0, failures: s?.failures ?? 0, calls: s?.calls ?? 0, queue: Promise.resolve() });
    }
  }

  private lane(lane: Lane) {
    const s = this.state.get(lane);
    if (!s) throw new Error(`lane ${lane} is not enabled`);
    return s;
  }

  usable(lane: Lane, at = this.opts.now()): boolean {
    const s = this.lane(lane);
    return s.cooldownUntil <= at && (this.opts.maxCallsPerLane === undefined || s.calls < this.opts.maxCallsPerLane);
  }

  /** True when a lane has spent its call allowance for this run (it never comes back). */
  exhausted(lane: Lane): boolean {
    return this.opts.maxCallsPerLane !== undefined && this.lane(lane).calls >= this.opts.maxCallsPerLane;
  }

  /**
   * Generator, critic and tie-break for the pool at `index`. The generator
   * rotates over the usable lanes allowed to generate; the critic and the
   * tie-break rotate over the rest, so every lane judges as well. Null when no
   * allowed generator or no second lane can run now.
   */
  assign(index: number, at = this.opts.now()): Assignment | null {
    const n = this.lanes.length;
    const allowed = this.opts.generators;
    const writers = this.lanes.filter((l) => (!allowed || allowed.includes(l)) && this.usable(l, at));
    if (writers.length === 0) return null;
    const generator = writers[index % writers.length];
    const judges = Array.from({ length: n }, (_, i) => this.lanes[(index + i) % n]).filter((l) => l !== generator && this.usable(l, at));
    if (judges.length === 0) return null;
    return { generator, critic: judges[0], tiebreak: judges[1] ?? null };
  }

  /** The earliest moment a parked lane comes back, or null when no parked lane will this run. */
  nextWake(at = this.opts.now()): number | null {
    const times = this.lanes.filter((l) => !this.exhausted(l)).map((l) => this.lane(l).cooldownUntil).filter((t) => t > at);
    return times.length === 0 ? null : Math.min(...times);
  }

  /** Runs `fn` on the lane after any earlier call on it and the pacing gap. */
  async run<T>(lane: Lane, fn: () => Promise<T>): Promise<T> {
    const s = this.lane(lane);
    const previous = s.queue;
    let release: () => void = () => undefined;
    s.queue = new Promise<void>((r) => { release = r; });
    await previous;
    try {
      // A lane parked while this call queued behind another fails fast, so the pool moves to a free lane instead of sleeping for hours.
      if (s.cooldownUntil > this.opts.now()) throw new LaneLimitError(lane, new Date(s.cooldownUntil), true, true);
      const wait = Math.max(s.nextAt, s.cooldownUntil) - this.opts.now();
      if (wait > 0) await this.opts.sleep(wait);
      s.calls += 1;
      return await fn();
    } finally {
      s.nextAt = this.opts.now() + this.opts.minGapMs;
      release();
    }
  }

  succeeded(lane: Lane): void {
    this.lane(lane).failures = 0;
  }

  limited(lane: Lane, until: Date): void {
    this.lane(lane).cooldownUntil = until.getTime();
  }

  failed(lane: Lane): void {
    const s = this.lane(lane);
    s.failures += 1;
    s.cooldownUntil = this.opts.now() + backoffMs(s.failures);
  }

  snapshot(): Partial<Record<Lane, LaneSnapshot>> {
    const out: Partial<Record<Lane, LaneSnapshot>> = {};
    for (const [lane, s] of this.state) out[lane] = { cooldownUntil: s.cooldownUntil, failures: s.failures, calls: s.calls };
    return out;
  }
}
