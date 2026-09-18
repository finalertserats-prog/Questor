/**
 * The words and the order of the System health panel, kept free of React so
 * they can be tested on their own (web/tests/systemHealthModel.test.ts).
 *
 * Two rules live here. A healthy system must read calm — healthy checks are
 * counted, not listed — and a sick one must read loud: problems come first,
 * worst first, and the header says how many there are in plain words.
 */

export type HealthStatus = 'ok' | 'warn' | 'fail' | 'info';
export type OverallStatus = 'ok' | 'warn' | 'fail';

export interface HealthCheckView {
  readonly id: string;
  readonly label: string;
  readonly status: HealthStatus;
  readonly summary: string;
  readonly detail?: string;
  readonly action?: string;
  readonly value?: string | number;
}

export interface HealthSectionView {
  readonly id: string;
  readonly title: string;
  readonly checks: readonly HealthCheckView[];
}

export interface HealthReportView {
  readonly status: OverallStatus;
  readonly checkedAt: string;
  readonly commit: string;
  readonly scope: 'operator' | 'tenant';
  readonly sections: readonly HealthSectionView[];
}

/** Every status is named in words, so none of them depends on its colour. */
export const STATUS_WORD: Readonly<Record<HealthStatus, string>> = {
  fail: 'Problem',
  warn: 'Watch',
  ok: 'Healthy',
  info: 'Note',
};

/** Badge kinds from app.css, which pair each colour with its own shape. */
export const STATUS_BADGE: Readonly<Record<HealthStatus, 'red' | 'amber' | 'green' | 'gray'>> = {
  fail: 'red',
  warn: 'amber',
  ok: 'green',
  info: 'gray',
};

const ORDER: Readonly<Record<HealthStatus, number>> = { fail: 0, warn: 1, info: 2, ok: 3 };

export interface HealthCounts {
  readonly fail: number;
  readonly warn: number;
  readonly ok: number;
  readonly info: number;
}

export function countByStatus(report: HealthReportView | null): HealthCounts {
  const counts = { fail: 0, warn: 0, ok: 0, info: 0 };
  for (const section of report?.sections ?? []) {
    for (const check of section.checks) counts[check.status] += 1;
  }
  return counts;
}

/** The overall state in words. Problems outrank warnings; silence means healthy. */
export function overallHeadline(report: HealthReportView | null): string {
  if (!report) return 'Checking…';
  const { fail, warn } = countByStatus(report);
  if (fail > 0) return fail === 1 ? '1 problem needs attention' : `${fail} problems need attention`;
  if (warn > 0) return warn === 1 ? '1 warning' : `${warn} warnings`;
  return 'All systems healthy';
}

/**
 * Problems and facts stay on screen; healthy checks are collapsed. Notes are
 * not hidden behind "healthy" — a legal hold or a build number is something
 * the reader asked for, and calling it healthy would be a small lie.
 */
export function splitChecks(checks: readonly HealthCheckView[]): {
  shown: HealthCheckView[];
  healthy: HealthCheckView[];
} {
  const sorted = [...checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  return {
    shown: sorted.filter((c) => c.status !== 'ok'),
    healthy: sorted.filter((c) => c.status === 'ok'),
  };
}

export function healthyToggleLabel(count: number): string {
  return count === 1 ? 'Show 1 healthy check' : `Show ${count} healthy checks`;
}

/** What the panel says instead of a list when a section has nothing to report. */
export function emptySectionText(): string {
  return 'Nothing to report.';
}
