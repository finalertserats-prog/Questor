import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { seedPoolsFileSchema } from '../../src/library/seedExport.js';
import { SEED_LANES, type SeedLane } from '../../src/library/seedFormat.js';
import { loadState, newState, runLogger, saveState, withPools, writeJsonl } from './checkpoint.js';
import { spawnRunner } from './lanes.js';
import { cliProvider } from './provider.js';
import { runSeed } from './run.js';
import { LaneScheduler } from './scheduler.js';
import { summarize, type LogEvent } from './summary.js';

/**
 * Offline library seed run on the owner's laptop, with the Brahmastra CLIs:
 *
 *   npm run library:seed-generate -- --pools pools.json --out runs/pilot [options]
 *
 *   --lanes claude,codex,gemini   lanes to use (at least two; default all three)
 *   --generators claude,codex     lanes allowed to write (default: every lane); the rest only critique
 *   --per-pool 4                  questions asked for per pool batch (the worker asks for 10)
 *   --concurrency 2               pools in flight (each lane still runs one call at a time)
 *   --min-gap-sec 5               pause between calls on one lane
 *   --timeout-sec 420             one CLI call's limit; the process tree is killed after it
 *   --max-calls-per-lane N        stop using a lane after N calls this run
 *   --max-calls N                 stop starting pools after N calls in total
 *   --max-wait-hours 8            longest sleep for a lane to come back before stopping (resume later)
 *   --max-attempts 3              tries per pool before it is marked failed
 *   --no-tiebreak                 never ask the third lane
 *
 *   npm run library:seed-generate -- --probe [--lanes ...]   one tiny JSON call per lane: ok, ms, limit
 *
 * Writes into --out: state.json (resume), seed.jsonl (for library:seed-import),
 * run.log (one line per call, no text), summary.json. Re-running with the same
 * --out resumes. Ctrl-C finishes the calls in flight, saves and exits.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function num(name: string, fallback: number): number {
  const text = arg(name);
  const value = text === undefined ? fallback : Number(text);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a number`);
  return value;
}

function lanesArg(): SeedLane[] {
  const text = arg('lanes');
  const lanes = text ? text.split(',').map((s) => s.trim()) : [...SEED_LANES];
  const valid = lanes.filter((l): l is SeedLane => (SEED_LANES as readonly string[]).includes(l));
  if (valid.length !== lanes.length || new Set(valid).size < 2) throw new Error('--lanes needs at least two of claude, codex, gemini');
  return [...new Set(valid)];
}

function readLog(path: string): LogEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as LogEvent];
    } catch {
      return [];
    }
  });
}

/** One tiny call per lane, to see before a long run that each CLI answers with JSON. */
async function probe(): Promise<number> {
  const cwd = resolve(arg('out') ?? '.seed-probe');
  mkdirSync(cwd, { recursive: true });
  const results = await Promise.all(lanesArg().map(async (lane) => {
    try {
      const reply = await cliProvider(lane, spawnRunner, { timeoutMs: num('timeout-sec', 180) * 1000, cwd }).generate([
        { role: 'system', content: 'Respond ONLY with minified JSON: {"ok":true,"lane":"<your model family>"}' },
        { role: 'user', content: 'Probe.' },
      ]);
      return { lane, ok: /"ok"\s*:\s*true/.test(reply.text), ms: reply.latencyMs };
    } catch (err) {
      return { lane, ok: false, error: err instanceof Error ? err.message.slice(0, 160) : String(err) };
    }
  }));
  process.stdout.write(`${JSON.stringify(results)}\n`);
  return results.every((r) => r.ok) ? 0 : 1;
}

async function main(): Promise<number> {
  if (process.argv.includes('--probe')) return probe();
  const poolsPath = arg('pools');
  const outArg = arg('out');
  if (!poolsPath || !outArg) {
    process.stderr.write('Usage: library:seed-generate -- --pools pools.json --out <dir> [options]\n');
    return 2;
  }
  const out = resolve(outArg);
  const cliCwd = join(out, 'cli-cwd');
  mkdirSync(cliCwd, { recursive: true });
  const file = seedPoolsFileSchema.parse(JSON.parse(readFileSync(resolve(poolsPath), 'utf8')));
  const statePath = join(out, 'state.json');
  const now = () => new Date();
  const runId = `seed-${now().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')}`;
  let state = withPools(loadState(statePath) ?? newState(runId, now()), file.pools);
  saveState(statePath, state);
  const log = runLogger(join(out, 'run.log'), now);
  const lanes = lanesArg();
  const maxPerLane = arg('max-calls-per-lane');
  const generatorsText = arg('generators');
  const generators = generatorsText ? generatorsText.split(',').map((s) => s.trim()).filter((l): l is SeedLane => lanes.includes(l as SeedLane)) : undefined;
  if (generators && generators.length === 0) throw new Error('--generators must name at least one of the --lanes');
  const scheduler = new LaneScheduler(lanes, {
    minGapMs: num('min-gap-sec', 5) * 1000, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...(maxPerLane ? { maxCallsPerLane: num('max-calls-per-lane', 0) } : {}),
    ...(generators ? { generators } : {}),
  }, state.lanes);
  const timeoutMs = num('timeout-sec', 420) * 1000;

  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    process.stderr.write('Stopping after the calls in flight (Ctrl-C again to abort)...\n');
  });

  log({ event: 'run_start', runId: state.runId, pools: file.pools.length, lanes });
  const maxCalls = arg('max-calls');
  const result = await runSeed(file.pools, state, {
    perPool: num('per-pool', 4), concurrency: num('concurrency', 2), tiebreak: !process.argv.includes('--no-tiebreak'),
    maxAttempts: num('max-attempts', 3), maxWaitMs: num('max-wait-hours', 8) * 3_600_000,
    ...(maxCalls ? { maxCalls: num('max-calls', 0) } : {}),
  }, {
    scheduler, provider: (lane) => cliProvider(lane, spawnRunner, { timeoutMs, cwd: cliCwd }),
    now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log, save: (s) => saveState(statePath, s), stopped: () => stopping,
  });
  state = result.state;
  saveState(statePath, state);
  log({ event: 'run_end', exit: result.exit });
  writeJsonl(join(out, 'seed.jsonl'), state, file.pools.map((p) => p.key));
  const summary = summarize(state, readLog(join(out, 'run.log')));
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 1)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ exit: result.exit, pools: summary.pools, accepted: summary.accepted, rejected: summary.rejected, calls: summary.calls.total, out })}\n`);
  return result.exit === 'complete' ? 0 : 3;
}

main().then((code) => process.exit(code), (err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
