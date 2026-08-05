/**
 * Render a report from a checkpoint file, complete or not.
 *
 * A sweep runs for hours, and waiting for the last cell before looking at any of
 * it wastes the wait — the first complete band already carries a signal worth
 * reading. This reuses the same `renderReport` the runner finishes with, so a
 * partial read and the final report cannot disagree about what the numbers mean.
 *
 * Run: npm run sim:report -w server -- sim-results/checkpoint-<stamp>.jsonl
 */
import { readCheckpoint, renderReport, type CellResult } from './run.js';
import { BANDS } from '../engines/experienceBands.js';
import type { JudgedTranscript } from './judge.js';

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function fmt(n: number, dp = 1): string {
  return Number.isFinite(n) ? n.toFixed(dp) : '—';
}

/**
 * Paired comparison, band by band.
 *
 * The benchmark column is what makes the Questor column mean anything. A
 * distance of 2 is only damning once a general-purpose model handed the same
 * job description and the same CV scores 0 on the same cell.
 */
export function renderComparison(results: CellResult[]): string {
  const out: string[] = [];
  out.push('## Questor vs benchmark peer, by band');
  out.push('');
  out.push('| Band | n | Questor distance | Benchmark distance | Questor calib | Benchmark calib |');
  out.push('|---|---|---|---|---|---|');

  for (const band of BANDS) {
    const rows = results.filter((r) => r.cell.band === band.id);
    if (!rows.length) continue;
    const q = rows.map((r) => r.questor?.judged).filter((j): j is JudgedTranscript => !!j);
    const b = rows.map((r) => r.benchmark?.judged).filter((j): j is JudgedTranscript => !!j);
    out.push(
      `| ${band.id} | ${rows.length} | ${fmt(mean(q.map((j) => j.bandDistance)), 2)} | ${fmt(mean(b.map((j) => j.bandDistance)), 2)} | ` +
      `${fmt(mean(q.map((j) => j.objectiveCalibration)))} | ${fmt(mean(b.map((j) => j.objectiveCalibration)))} |`,
    );
  }
  out.push('');

  // Where the pitch lands when it misses, which says more than the average does.
  out.push('## Where Questor pitched, per candidate band');
  out.push('');
  for (const band of BANDS) {
    const q = results
      .filter((r) => r.cell.band === band.id)
      .map((r) => r.questor?.judged)
      .filter((j): j is JudgedTranscript => !!j);
    if (!q.length) continue;
    const tally = new Map<string, number>();
    for (const j of q) tally.set(j.verdict.pitchedBand, (tally.get(j.verdict.pitchedBand) ?? 0) + 1);
    const spread = [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}×${v}${k === band.id ? ' ✓' : ''}`)
      .join(', ');
    out.push(`- **${band.id}** (n=${q.length}) → ${spread}`);
  }
  out.push('');
  return out.join('\n');
}

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: npm run sim:report -w server -- <checkpoint.jsonl>');
    process.exit(2);
  }
  const results = [...readCheckpoint(path).values()].sort((a, b) => a.cell.index - b.cell.index);
  if (!results.length) {
    console.error(`No completed cells found in ${path}`);
    process.exit(1);
  }
  console.log(`# Interim report — ${results.length} cells complete\n`);
  console.log(renderComparison(results));
  console.log(renderReport(results, Date.now()));
}

if (process.argv[1] && process.argv[1].endsWith('report.ts')) main();
