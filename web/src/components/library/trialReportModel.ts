/**
 * The interleaved trial's paired report (GET /api/library/admin/trial-report),
 * as the owner reads it. Pure; tested in web/tests/trialReportModel.test.ts.
 */

export interface SideStats {
  readonly blocks: number;
  readonly meanYield: number | null;
  readonly nonAnswerRate: number | null;
  readonly confusionRate: number | null;
  readonly meanProbes: number | null;
  readonly reviewerAgreement: number | null;
  readonly reviewedBlocks: number;
}

export interface TrialReport {
  readonly interviews: number;
  readonly library: SideStats;
  readonly builtin: SideStats;
  readonly pairedYieldDifference: number | null;
  readonly firstAskedAt: string | null;
  readonly targetBlocks: number;
}

/** A difference in evidence yield smaller than this is read as even. */
const EVEN_WITHIN = 0.02;

export function share(n: number | null): string {
  return n === null ? '—' : `${Math.round(n * 100)}%`;
}

export function decimal(n: number | null): string {
  return n === null ? '—' : n.toFixed(2);
}

/** One sentence on where the trial stands. Never a verdict before the library blocks reach the target. */
export function trialStanding(report: TrialReport): string {
  if (report.interviews === 0) return 'No paired interviews yet. The trial starts once an organisation (the demo sandbox first) runs interviews in trial mode.';
  const progress = `${report.library.blocks} of ${report.targetBlocks} library blocks so far, across ${report.interviews} paired interview${report.interviews === 1 ? '' : 's'}.`;
  if (report.library.blocks < report.targetBlocks || report.pairedYieldDifference === null) return `${progress} Too early to compare.`;
  const diff = report.pairedYieldDifference;
  if (Math.abs(diff) < EVEN_WITHIN) return `${progress} Library and built-in blocks yield about the same evidence.`;
  return diff > 0
    ? `${progress} Library blocks yield more evidence than built-in blocks in the same interviews.`
    : `${progress} Built-in blocks yield more evidence than library blocks in the same interviews.`;
}

export interface ComparisonRow {
  readonly label: string;
  readonly library: string;
  readonly builtin: string;
}

export function comparisonRows(report: TrialReport): ComparisonRow[] {
  const { library: l, builtin: b } = report;
  return [
    { label: 'Blocks', library: String(l.blocks), builtin: String(b.blocks) },
    { label: 'Evidence yield (mean)', library: decimal(l.meanYield), builtin: decimal(b.meanYield) },
    { label: 'No answer', library: share(l.nonAnswerRate), builtin: share(b.nonAnswerRate) },
    { label: 'Candidate asked what was meant', library: share(l.confusionRate), builtin: share(b.confusionRate) },
    { label: 'Follow-ups per block', library: decimal(l.meanProbes), builtin: decimal(b.meanProbes) },
    {
      label: 'Reviewer kept the AI level',
      library: l.reviewedBlocks ? `${share(l.reviewerAgreement)} of ${l.reviewedBlocks}` : '—',
      builtin: b.reviewedBlocks ? `${share(b.reviewerAgreement)} of ${b.reviewedBlocks}` : '—',
    },
  ];
}
