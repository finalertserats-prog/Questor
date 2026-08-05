/**
 * Sweep runner — the thing that produces the baseline.
 *
 * One cell is a permutation of the three peers: one plays the candidate, one
 * conducts the benchmark interview, and the third judges both, blind. That is
 * where the 3x3 matrix earns its keep — every interview is scored by a model
 * with no part in producing it, and across the six permutations each peer takes
 * every seat.
 *
 * Run: npm run sim -w server
 * Env:
 *   SIM_BANDS=emerging,senior     bands to cover (default: all six)
 *   SIM_FAMILIES=data_engineering role families (default: one, rotating)
 *   SIM_STRENGTHS=strong          candidate strengths (default: strong)
 *   SIM_LANE_A_ONLY=true          skip the benchmark lane (faster, no comparison)
 *   SIM_CONCURRENCY=2             cells in flight at once
 *   SIM_GENERATE=true             have a peer invent roles/candidates instead of templates
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { BANDS, type BandId } from '../engines/experienceBands.js';
import { PEER_IDS, otherPeers, type PeerId } from './peers.js';
import { ROLE_FAMILIES, templateRole, generateRole, type RoleFamily, type RoleSpec } from './roleFactory.js';
import {
  CANDIDATE_STRENGTHS,
  templateCandidate,
  generateCandidate,
  type CandidateStrength,
  type CandidateSpec,
} from './candidateFactory.js';
import { runLaneA } from './laneA.js';
import { runLaneB } from './laneB.js';
import { judgeTranscript, type JudgedTranscript } from './judge.js';
import type { SimTranscript } from './types.js';

interface Permutation {
  /** Conducts the Lane B benchmark interview. */
  interviewer: PeerId;
  /** Plays the candidate in both lanes. */
  candidate: PeerId;
  /** Judges both transcripts, blind. Has no hand in either. */
  judge: PeerId;
}

/** The six ordered pairs, each with the remaining peer as judge. */
export function permutations(): Permutation[] {
  const out: Permutation[] = [];
  for (const interviewer of PEER_IDS) {
    for (const candidate of otherPeers(interviewer)) {
      const judge = PEER_IDS.find((p) => p !== interviewer && p !== candidate);
      if (judge) out.push({ interviewer, candidate, judge });
    }
  }
  return out;
}

interface Cell {
  index: number;
  band: BandId;
  family: RoleFamily;
  strength: CandidateStrength;
  perm: Permutation;
}

export interface CellResult {
  cell: Omit<Cell, 'perm'> & { perm: Permutation };
  role: string;
  candidate: string;
  questor?: { transcript: SimTranscript; judged?: JudgedTranscript };
  benchmark?: { transcript: SimTranscript; judged?: JudgedTranscript };
  errors: string[];
}

function envList<T extends string>(name: string, allowed: readonly T[], fallback: T[]): T[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const picked = raw.split(',').map((s) => s.trim()).filter((s): s is T => (allowed as readonly string[]).includes(s));
  return picked.length ? picked : fallback;
}

function buildCells(): Cell[] {
  const bands = envList<BandId>('SIM_BANDS', BANDS.map((b) => b.id), BANDS.map((b) => b.id));
  const families = envList<RoleFamily>('SIM_FAMILIES', ROLE_FAMILIES, ['data_engineering']);
  const strengths = envList<CandidateStrength>('SIM_STRENGTHS', CANDIDATE_STRENGTHS, ['strong']);
  const perms = permutations();

  const cells: Cell[] = [];
  let i = 0;
  for (const band of bands) {
    for (const family of families) {
      for (const strength of strengths) {
        // Rotate the permutation across cells so no peer is stuck in one seat
        // for a whole sweep — a judge that only ever judges one band, or a
        // candidate only ever played by one model, is a confound.
        cells.push({ index: i, band, family, strength, perm: perms[i % perms.length] });
        i++;
      }
    }
  }
  return cells;
}

async function buildFixtures(cell: Cell, generate: boolean): Promise<{ role: RoleSpec; candidate: CandidateSpec }> {
  if (!generate) {
    const role = templateRole({ family: cell.family, band: cell.band });
    return { role, candidate: templateCandidate({ role, band: cell.band, strength: cell.strength }) };
  }
  // The generator agents. Deliberately the judge peer, which is the one seat
  // with no interview to conduct in this cell.
  const role = await generateRole({ family: cell.family, band: cell.band, peer: cell.perm.judge });
  const candidate = await generateCandidate({
    role, band: cell.band, strength: cell.strength, peer: cell.perm.judge,
  });
  return { role, candidate };
}

async function runCell(cell: Cell, opts: { laneAOnly: boolean; generate: boolean }): Promise<CellResult> {
  const errors: string[] = [];
  const label = `[${cell.index}] ${cell.band}/${cell.family}/${cell.strength}`;

  let fixtures: { role: RoleSpec; candidate: CandidateSpec };
  try {
    fixtures = await buildFixtures(cell, opts.generate);
  } catch (e) {
    return {
      cell, role: '(failed)', candidate: '(failed)',
      errors: [`fixtures: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  console.log(`${label} · ${fixtures.role.title} · ${fixtures.candidate.fullName} · candidate=${cell.perm.candidate} benchmark=${cell.perm.interviewer} judge=${cell.perm.judge}`);

  const result: CellResult = {
    cell, role: fixtures.role.title, candidate: fixtures.candidate.fullName, errors,
  };

  const questorTranscript = await runLaneA({
    role: fixtures.role, candidate: fixtures.candidate, candidatePeer: cell.perm.candidate, durationMinutes: 20,
  });
  if (questorTranscript.error) errors.push(`laneA: ${questorTranscript.error}`);
  result.questor = { transcript: questorTranscript };

  if (!opts.laneAOnly) {
    const benchTranscript = await runLaneB({
      role: fixtures.role, candidate: fixtures.candidate,
      interviewerPeer: cell.perm.interviewer, candidatePeer: cell.perm.candidate,
    });
    if (benchTranscript.error) errors.push(`laneB: ${benchTranscript.error}`);
    result.benchmark = { transcript: benchTranscript };
  }

  // Judge whatever produced turns. A lane that broke is recorded as an error,
  // not silently scored as if it had run.
  for (const side of ['questor', 'benchmark'] as const) {
    const entry = result[side];
    if (!entry || entry.transcript.turns.length < 2) continue;
    try {
      entry.judged = await judgeTranscript({ transcript: entry.transcript, judge: cell.perm.judge });
      console.log(`${label} · ${side}: pitched=${entry.judged.verdict.pitchedBand} (true=${cell.band}) distance=${entry.judged.bandDistance} calibration=${entry.judged.objectiveCalibration}`);
    } catch (e) {
      errors.push(`judge(${side}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

/** Run cells with a bounded number in flight. */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// --- Reporting --------------------------------------------------------------

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : '—';
}

export function renderReport(results: CellResult[], startedAt: number): string {
  const lines: string[] = [];
  const judgedQ = results.map((r) => r.questor?.judged).filter((j): j is JudgedTranscript => !!j);
  const judgedB = results.map((r) => r.benchmark?.judged).filter((j): j is JudgedTranscript => !!j);

  lines.push('# Questor interview simulation — baseline');
  lines.push('');
  lines.push(`Cells: ${results.length} · judged Questor interviews: ${judgedQ.length} · judged benchmark interviews: ${judgedB.length}`);
  lines.push(`Wall clock: ${((Date.now() - startedAt) / 60000).toFixed(1)} min`);
  lines.push('');

  lines.push('## Headline');
  lines.push('');
  lines.push('| Metric | Questor | Benchmark peer |');
  lines.push('|---|---|---|');
  lines.push(`| Band distance (0 = pitched right) | ${fmt(mean(judgedQ.map((j) => j.bandDistance)))} | ${fmt(mean(judgedB.map((j) => j.bandDistance)))} |`);
  lines.push(`| Calibration (arithmetic, 0-10) | ${fmt(mean(judgedQ.map((j) => j.objectiveCalibration)))} | ${fmt(mean(judgedB.map((j) => j.objectiveCalibration)))} |`);
  lines.push(`| Engagement (judge, 0-10) | ${fmt(mean(judgedQ.map((j) => j.verdict.engagement)))} | ${fmt(mean(judgedB.map((j) => j.verdict.engagement)))} |`);
  lines.push(`| Evidence yield (judge, 0-10) | ${fmt(mean(judgedQ.map((j) => j.verdict.evidenceYield)))} | ${fmt(mean(judgedB.map((j) => j.verdict.evidenceYield)))} |`);
  lines.push(`| Fairness (judge, 0-10) | ${fmt(mean(judgedQ.map((j) => j.verdict.fairness)))} | ${fmt(mean(judgedB.map((j) => j.verdict.fairness)))} |`);
  lines.push('');

  lines.push('## Calibration by band');
  lines.push('');
  lines.push('| Candidate band | Questor pitched at | Distance | Benchmark pitched at | Distance |');
  lines.push('|---|---|---|---|---|');
  for (const band of BANDS) {
    const rows = results.filter((r) => r.cell.band === band.id);
    if (!rows.length) continue;
    const q = rows.map((r) => r.questor?.judged).filter((j): j is JudgedTranscript => !!j);
    const b = rows.map((r) => r.benchmark?.judged).filter((j): j is JudgedTranscript => !!j);
    const pitched = (js: JudgedTranscript[]) => (js.length ? [...new Set(js.map((j) => j.verdict.pitchedBand))].join(', ') : '—');
    lines.push(`| ${band.id} | ${pitched(q)} | ${fmt(mean(q.map((j) => j.bandDistance)))} | ${pitched(b)} | ${fmt(mean(b.map((j) => j.bandDistance)))} |`);
  }
  lines.push('');

  const misfits = results.flatMap((r) =>
    (r.questor?.judged?.verdict.misfitQuestions ?? []).map((q) => ({ band: r.cell.band, q })),
  );
  if (misfits.length) {
    lines.push('## Questions the judge called wrong for the level (Questor)');
    lines.push('');
    for (const m of misfits.slice(0, 40)) lines.push(`- **${m.band}** — ${m.q}`);
    lines.push('');
  }

  const errored = results.filter((r) => r.errors.length);
  if (errored.length) {
    lines.push('## Cells with errors');
    lines.push('');
    for (const r of errored) lines.push(`- [${r.cell.index}] ${r.cell.band}/${r.cell.family}: ${r.errors.join(' | ')}`);
    lines.push('');
    lines.push('These cells are excluded from the averages above rather than counted as zeros.');
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  const startedAt = Date.now();
  const cells = buildCells();
  const laneAOnly = process.env.SIM_LANE_A_ONLY === 'true';
  const generate = process.env.SIM_GENERATE === 'true';
  const concurrency = Number(process.env.SIM_CONCURRENCY ?? 2);

  console.log(`\n=== Questor interview simulation — ${cells.length} cells, concurrency ${concurrency}${laneAOnly ? ', Lane A only' : ''}${generate ? ', peer-generated fixtures' : ', template fixtures'} ===\n`);

  const dir = 'sim-results';
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');

  // Written as each cell lands, because a large sweep runs for hours and the
  // report is only produced at the end. Without this, a crash at cell 50 of 54
  // throws away every interview conducted so far.
  const checkpoint = `${dir}/checkpoint-${stamp}.jsonl`;
  let done = 0;

  const results = await runPool(cells, concurrency, async (cell) => {
    const r = await runCell(cell, { laneAOnly, generate });
    try {
      appendFileSync(checkpoint, `${JSON.stringify(r)}\n`, 'utf8');
    } catch (e) {
      // Never let a checkpoint write failure take down a running sweep.
      console.warn(`checkpoint write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    done++;
    const elapsedMin = (Date.now() - startedAt) / 60000;
    // No projection until at least one full concurrent wave has landed. Before
    // that, `elapsed / done` divides the whole warm-up by a single completion
    // while the other slots are nearly finished, and reports several times the
    // real figure — the first tick of a 4-hour run announced 12 hours.
    const projection = done >= concurrency
      ? `~${Math.max(0, (elapsedMin / done) * cells.length - elapsedMin).toFixed(0)} min remaining`
      : `(estimating — needs ${concurrency} completions)`;
    console.log(`--- progress ${done}/${cells.length} · ${elapsedMin.toFixed(1)} min elapsed · ${projection}`);
    return r;
  });

  const report = renderReport(results, startedAt);
  console.log(`\n${report}`);

  writeFileSync(`${dir}/baseline-${stamp}.md`, report, 'utf8');
  writeFileSync(`${dir}/baseline-${stamp}.json`, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\nWritten: ${dir}/baseline-${stamp}.md`);
  console.log(`Checkpoint: ${checkpoint}`);
}

// Only run when invoked directly, so the report helpers stay importable in tests.
if (process.argv[1] && process.argv[1].endsWith('run.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
