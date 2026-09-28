import { csvDocument } from './csv.js';
import { CUT_DIMENSION_LABELS, CUT_DIMENSIONS, type CutGroup, type Rate } from '../domain/outcomeStats.js';
import { VERDICTS, VERDICT_LABELS } from '../domain/verdict.js';
import type { OutcomeReport } from './outcomeStats.js';

/**
 * The outcome report as one long CSV.
 *
 * Every row that carries a rate also carries its numerator, its denominator and
 * whether the sample is large enough to read — the same rule the page follows.
 * A spreadsheet is exactly where a percentage gets separated from the count it
 * was computed on and pasted into a slide, so the count travels with it.
 *
 * One flat table rather than several: a section column tells the rows apart,
 * which survives being sorted, filtered and pivoted. Several tables stacked in
 * one file do not.
 */

const HEADER = [
  'section', 'dimension', 'group', 'measure',
  'numerator', 'denominator', 'rate', 'readable', 'note',
] as const;

type Row = ReadonlyArray<string | number | null>;

function rateRow(section: string, dimension: string, group: string, measure: string, rate: Rate, note = ''): Row {
  return [section, dimension, group, measure, rate.numerator, rate.denominator, rate.value, rate.readable ? 'yes' : 'no', note];
}

function valueRow(section: string, dimension: string, group: string, measure: string, n: number, value: number | null, readable: boolean): Row {
  return [section, dimension, group, measure, null, n, value, readable ? 'yes' : 'no', ''];
}

const TOO_SMALL = 'Sample below the minimum; this rate must not be read.';

function noteFor(rate: Rate): string {
  return rate.readable ? '' : TOO_SMALL;
}

function cutRows(dimension: string, groups: readonly CutGroup[]): Row[] {
  return groups.flatMap((group): Row[] => [
    rateRow('cut', dimension, group.label, 'Completed', group.completed, noteFor(group.completed)),
    rateRow('cut', dimension, group.label, 'Assessed', group.assessed, noteFor(group.assessed)),
    rateRow('cut', dimension, group.label, 'Reviewed by a person', group.humanReviewed, noteFor(group.humanReviewed)),
    ...VERDICTS.map((verdict) =>
      rateRow('cut', dimension, group.label, `AI: ${VERDICT_LABELS[verdict]}`, group.aiVerdicts[verdict], noteFor(group.aiVerdicts[verdict]))),
    ...VERDICTS.map((verdict) =>
      rateRow('cut', dimension, group.label, `Reviewer: ${VERDICT_LABELS[verdict]}`, group.humanVerdicts[verdict], noteFor(group.humanVerdicts[verdict]))),
    rateRow('cut', dimension, group.label, 'Hired', group.hired, noteFor(group.hired)),
    valueRow('cut', dimension, group.label, 'Median score', group.score.n, group.score.median, group.score.readable),
  ]);
}

export function outcomeReportToCsv(report: OutcomeReport): string {
  const rows: Row[] = [
    [...HEADER],
    ['about', '', '', 'Period', null, null, null, '', `${report.period.from} to ${report.period.to}`],
    ['about', '', '', 'Generated at', null, null, null, '', report.generatedAt],
    ['about', '', '', 'Interviews in period', null, report.interviews, null, '', report.truncated ? 'Truncated: the newest interviews only.' : ''],
    ['about', '', '', 'Minimum sample', null, report.minSample, null, '',
      'A rate computed on fewer observations than this is marked readable=no and must not be read as a rate.'],
    ['about', '', '', 'Scope', null, null, null, '',
      'Outcome rates only. Questor holds no group attributes, so nothing here is an adverse-impact analysis.'],

    ...report.funnel.map((step): Row => (step.ofBasis
      ? rateRow('funnel', '', step.label, `of ${step.basis}`, step.ofBasis, noteFor(step.ofBasis))
      : ['funnel', '', step.label, 'count', null, step.count, null, '', ''])),

    valueRow('scores', '', 'Overall score', 'Median', report.scores.n, report.scores.median, report.scores.readable),
    valueRow('scores', '', 'Overall score', 'Lower quartile', report.scores.n, report.scores.q1, report.scores.readable),
    valueRow('scores', '', 'Overall score', 'Upper quartile', report.scores.n, report.scores.q3, report.scores.readable),
    ...report.scores.buckets.map((bucket): Row =>
      ['scores', 'bucket', `${bucket.from}-${bucket.to}`, 'count', null, bucket.count, null, '', '']),

    ...report.competencies.flatMap((competency): Row[] => [
      valueRow('competencies', competency.competencyName, 'All levels', 'Median level', competency.n, competency.median, competency.readable),
      ...competency.counts.map((count): Row =>
        ['competencies', competency.competencyName, `Level ${count.level}`, 'count', null, count.count, null, '', '']),
    ]),

    ...CUT_DIMENSIONS.flatMap((dimension) => cutRows(CUT_DIMENSION_LABELS[dimension], report.cuts[dimension])),

    valueRow('health', '', 'Duration (minutes)', 'Median', report.health.duration.n, report.health.duration.median, report.health.duration.readable),
    rateRow('health', '', 'Candidate turns', 'Non-answer rate', report.health.nonAnswer, noteFor(report.health.nonAnswer)),
    valueRow('health', '', 'Assessments', 'Mean evidence coverage', report.health.evidenceCoverage.n, report.health.evidenceCoverage.mean, report.health.evidenceCoverage.readable),
    rateRow('health', '', 'Interviews', 'Rejoined', report.health.rejoined, noteFor(report.health.rejoined)),
    rateRow('health', '', 'Interviews', 'Feedback email held', report.health.heldFeedback, noteFor(report.health.heldFeedback)),
    rateRow('health', '', 'Agent turns', 'Served below the primary model', report.health.degradedTurns, noteFor(report.health.degradedTurns)),

    rateRow('reviewer-changes', '', 'All reviews', 'Reviewer kept the AI verdict', report.reviewerChanges.agreed,
      'Reviews made with the AI answer already on screen. This measures anchoring, not scoring validity.'),
    ...report.reviewerChanges.byAiRecommendation.map((entry): Row =>
      rateRow('reviewer-changes', 'AI said', VERDICT_LABELS[entry.recommendation], 'Reviewer kept it', entry.agreed, noteFor(entry.agreed))),
    rateRow('reviewer-changes', '', 'Competencies', 'Level changed by a reviewer', report.reviewerChanges.competencyChanges.changed,
      noteFor(report.reviewerChanges.competencyChanges.changed)),
    ['reviewer-changes', '', 'Competencies', 'AI graded higher', null, report.reviewerChanges.competencyChanges.aiHigher, null, '', ''],
    ['reviewer-changes', '', 'Competencies', 'Reviewer graded higher', null, report.reviewerChanges.competencyChanges.humanHigher, null, '', ''],

    ['agreement', '', 'Blind verdicts', 'count', null, report.agreement.sampleSize.blindVerdicts, null, '', report.agreement.sufficiency.statement],
    ['agreement', '', 'Disposition kappa', 'value', null, report.agreement.disposition.n, report.agreement.disposition.kappa, '', report.agreement.gate.statement],
  ];

  return csvDocument(rows);
}
