import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../api/client';
import { useAuth } from '../../auth';
import { can } from '../capabilityModel';
import { Banner } from '../ui';
import { EmptyState } from '../EmptyState';
import { formatDateTime } from '../dateFormat';
import { CountColumnChart, RateBarChart } from './OutcomeCharts';
import {
  CUT_MEASURES, PERIOD_PRESETS, cutBars, funnelBars, levelColumns, monthLabel, percent,
  periodRange, readRate, scoreColumns, spreadSentence, tooSmallNote,
  type CutGroup, type CutMeasureKey, type FunnelStep, type LevelCount, type PeriodKey,
  type Quantiles, type Rate, type ScoreBucket,
} from './outcomeModel';
import type { RoleFunnel, RoleMetricsPayload } from '../rolesListModel';
import { roleDisplayLabels } from '../roleLabelModel';

/**
 * Outcome statistics: how candidates actually fare at each step, and whether
 * outcomes differ by interviewer, question set, band or month.
 *
 * WHERE IT LIVES. The Admin console's Analytics tab, not a sidebar entry of its
 * own. Signing in should still show the four things a working day is made of —
 * Home, Candidates, Roles, Interviews — and a monitoring surface read monthly
 * does not belong beside them.
 *
 * WHAT THIS PAGE IS CAREFUL ABOUT. Every rate on it arrives with the count it
 * was computed from, and a rate on too small a sample says so in words rather
 * than being quietly rounded into a headline. And it states, in the place a
 * reader will look for it, that this is NOT an adverse-impact analysis: that
 * needs group attributes Questor does not collect, and a page of selection
 * rates is exactly the thing that gets mistaken for one.
 */

type CutDimension = 'interviewer' | 'experienceBand' | 'region' | 'scorecard' | 'month';

const CUT_TABS: ReadonlyArray<{ key: CutDimension; label: string; note: string }> = [
  { key: 'interviewer', label: 'AI interviewer', note: 'The five interviewers differ only in name and voice. A real difference between them would be a finding about this page, not about the candidates.' },
  { key: 'experienceBand', label: 'Experience band', note: 'Bands are pitched differently on purpose, so different rates here are expected. What is worth reading is a band whose rate moved.' },
  { key: 'region', label: 'Region', note: 'Region is the requisition’s, not the candidate’s. It is a property of the job, not of the person.' },
  { key: 'scorecard', label: 'Scorecard version', note: 'A change in outcomes after a scorecard was edited is the clearest signal on this page, because the change has a date and an author.' },
  { key: 'month', label: 'Month', note: 'Each month follows one cohort of interviews forward, so its rates are rates of the same people.' },
];

interface CompetencyDistribution extends Quantiles {
  readonly competencyId: string;
  readonly competencyName: string;
  readonly counts: readonly LevelCount[];
}

interface HealthStats {
  readonly n: number;
  readonly duration: Quantiles;
  readonly nonAnswer: Rate;
  readonly evidenceCoverage: { readonly n: number; readonly mean: number | null; readonly readable: boolean };
  readonly rejoined: Rate;
  readonly heldFeedback: Rate;
  readonly degradedTurns: Rate;
}

interface OutcomeReport {
  readonly generatedAt: string;
  readonly period: { readonly from: string; readonly to: string };
  readonly truncated: boolean;
  readonly minSample: number;
  readonly interviews: number;
  readonly funnel: readonly FunnelStep[];
  readonly scores: Quantiles & { readonly buckets: readonly ScoreBucket[] };
  readonly competencies: readonly CompetencyDistribution[];
  readonly cuts: Readonly<Record<CutDimension, readonly CutGroup[]>>;
  readonly health: HealthStats;
  readonly reviewerChanges: {
    readonly n: number;
    readonly agreed: Rate;
    readonly byAiRecommendation: ReadonlyArray<{
      readonly recommendation: 'PROCEED' | 'CONSIDER' | 'DO_NOT_PROGRESS';
      readonly n: number;
      readonly agreed: Rate;
      readonly humanCounts: Readonly<Record<'PROCEED' | 'CONSIDER' | 'DO_NOT_PROGRESS', number>>;
    }>;
    readonly competencyChanges: { readonly changed: Rate; readonly aiHigher: number; readonly humanHigher: number };
  };
  readonly agreementScopeNote?: string;
  readonly agreement: {
    readonly sampleSize: { readonly blindVerdicts: number; readonly assessmentsTotal: number };
    readonly sufficiency: { readonly statement: string };
    readonly gate: { readonly met: boolean | null; readonly statement: string; readonly statistic: string };
    readonly caveats: readonly string[];
  };
}

const VERDICT_LABELS = { PROCEED: 'Proceed', CONSIDER: 'Consider', DO_NOT_PROGRESS: 'Do not progress' } as const;

/** The health measures that are rates, and what each one divides by. */
const HEALTH_RATES: ReadonlyArray<{ key: 'nonAnswer' | 'rejoined' | 'heldFeedback' | 'degradedTurns'; label: string; of: string }> = [
  { key: 'nonAnswer', label: 'Non-answer turns', of: 'of every turn the candidate took' },
  { key: 'rejoined', label: 'Interviews rejoined', of: 'of the interviews in this period' },
  { key: 'heldFeedback', label: 'Feedback emails held', of: 'of the interviews in this period' },
  { key: 'degradedTurns', label: 'Turns below the primary model', of: 'of every turn the interviewer took' },
];

/** The plain-words note under a chart: what it does, and what it does not, tell you. */
function Reading({ children }: { children: React.ReactNode }) {
  return <p className="report-reading small">{children}</p>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card report-section">
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  );
}

/** A rate, always with its counts, and with the warning when it has one. */
function RateValue({ rate, minSample }: { rate: Rate | null | undefined; minSample: number }) {
  const read = readRate(rate, minSample);
  return (
    <span className={read.readable ? 'report-rate' : 'report-rate report-rate--unreadable'}>
      <span className="report-rate-value">{read.percent}</span>
      <span className="report-rate-counts">{read.counts}</span>
      {read.note && <span className="report-rate-note">{read.note}</span>}
    </span>
  );
}

function queryFor(period: PeriodKey, roleId: string, now: Date): string {
  const range = periodRange(period, now);
  const params = new URLSearchParams();
  if (range) {
    params.set('from', range.from.toISOString());
    params.set('to', range.to.toISOString());
  }
  if (roleId) params.set('roleId', roleId);
  return params.toString();
}

export function OutcomePanel() {
  const { user } = useAuth();
  const allowed = can(user, 'assessment:export');

  const [period, setPeriod] = useState<PeriodKey>('365d');
  const [roleId, setRoleId] = useState('');
  const [cut, setCut] = useState<CutDimension>('interviewer');
  const [measure, setMeasure] = useState<CutMeasureKey>('proceed');
  const [report, setReport] = useState<OutcomeReport | null>(null);
  const [roles, setRoles] = useState<readonly RoleFunnel[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  // Frozen per mount: a period that slides while the page is open would make
  // two charts on one screen describe two different windows.
  const now = useMemo(() => new Date(), []);
  const query = queryFor(period, roleId, now);

  useEffect(() => {
    if (!allowed) { setLoading(false); return; }
    let live = true;
    setLoading(true);
    setError('');
    api.get<OutcomeReport>(`/reports/outcomes${query ? `?${query}` : ''}`)
      .then((data) => { if (live) setReport(data); })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof ApiError ? err.message : 'The outcome statistics could not be loaded.');
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [allowed, query]);

  useEffect(() => {
    if (!allowed) return;
    api.get<RoleMetricsPayload>('/roles/metrics')
      .then((data) => setRoles(data.roles))
      .catch(() => setRoles([]));
  }, [allowed]);

  if (!allowed) {
    return <Banner kind="error">Your account does not have permission to read the organisation’s outcome statistics.</Banner>;
  }

  const minSample = report?.minSample ?? 20;
  // Parallel to `roles`: two requisitions with the same title are told apart
  // by level, region and band rather than reading identically in the picker.
  const roleLabels = roleDisplayLabels(roles);
  const csvHref = `/api/reports/outcomes?${query ? `${query}&` : ''}format=csv`;

  return (
    <>
      <div className="report-head">
        <div>
          <h2>Analytics</h2>
          <p className="muted small">What happens to candidates at each step, and where outcomes differ.</p>
        </div>
        <a className="btn secondary" href={csvHref} download>Download CSV</a>
      </div>

      <div className="card report-scope">
        <p className="small" style={{ marginTop: 0 }}>
          <strong>This is not an adverse-impact analysis, and cannot be one.</strong>{' '}
          Adverse impact is measured across protected groups. Questor does not collect a candidate’s race,
          sex, age or disability, so no number on this page is about a group of people — every cut below is
          by something about the <em>job or the system</em>: which AI interviewer ran the interview, which
          scorecard version it was graded against, which experience band and region the requisition was for,
          and which month it happened in. What this page gives you is the measurement layer underneath such
          monitoring, and a product view of how your hiring is actually going.
        </p>
        <p className="small" style={{ marginBottom: 0 }}>
          <strong>No percentage appears here without its denominator.</strong>{' '}
          A rate computed on fewer than {minSample} observations is shown with the counts and marked as
          too few to read — it is not a rate, and two such numbers must not be compared.
        </p>
      </div>

      <div className="row report-filters">
        <label className="field">
          <span className="field-label">Period</span>
          <select value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)} data-testid="report-period">
            {PERIOD_PRESETS.map((preset) => <option key={preset.key} value={preset.key}>{preset.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Role</span>
          <select value={roleId} onChange={(e) => setRoleId(e.target.value)} data-testid="report-role">
            <option value="">Every role</option>
            {roles.map((role, index) => <option key={role.id} value={role.id}>{roleLabels[index] ?? role.title}</option>)}
          </select>
        </label>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {loading && !report && <p className="muted">Loading…</p>}

      {report && report.truncated && (
        <Banner kind="info">
          This period holds more interviews than one report reads. Everything below was computed from the
          most recent ones only.
        </Banner>
      )}

      {report && report.interviews === 0 && !loading && (
        <EmptyState
          icon="reports"
          title="No interviews in this period"
          message="Nothing has been measured for the period and role selected. That is not a rate of zero — there is simply nothing here to read yet."
        />
      )}

      {report && report.interviews > 0 && (
        <>
          <Section title="The funnel">
            <RateBarChart
              bars={funnelBars(report.funnel, minSample)}
              title="Candidates at each step"
              summary="Each bar is that step's share of everyone invited; the percentage beside it is its share of the step before."
              valueHeading="Of the step before"
            />
            <Reading>
              <strong>What this tells you:</strong> where people stop. The bar length is the step’s share of
              everyone invited, so the drops are visible; the percentage is the step’s share of the step it
              came from, which is the question you are usually asking.{' '}
              <strong>What it does not:</strong> why anybody stopped. A low completion rate can be a
              scheduling problem, a technical one, or a role people looked at and thought better of, and
              this page cannot tell those apart. “Hired” means the candidate’s pipeline for the role was
              closed with an approval — Questor is never told about an offer or its acceptance.
            </Reading>
          </Section>

          <Section title="Scores">
            <CountColumnChart
              columns={scoreColumns(report.scores.buckets)}
              title="Overall competency score"
              summary="How many interviews landed in each ten-point band."
            />
            <p className="small">{spreadSentence(report.scores, '')}</p>
            <Reading>
              <strong>What this tells you:</strong> the shape of the scoring, not just its average — two
              cohorts with the same mean and different spreads are not the same cohort.{' '}
              <strong>What it does not:</strong> whether the scores are right. The score has not been
              validated against human judgement (see below), so a distribution that looks healthy is a
              distribution of opinions, not of measurements.
            </Reading>
          </Section>

          {report.competencies.length > 0 && (
            <Section title="Competency levels">
              <div className="report-grid">
                {report.competencies.slice(0, 6).map((competency) => (
                  <div key={competency.competencyId} className="report-panel">
                    <h3 className="report-panel-title">{competency.competencyName}</h3>
                    <CountColumnChart
                      columns={levelColumns(competency.counts)}
                      title={`${competency.competencyName}: levels awarded`}
                      summary="How many interviews were graded at each level."
                      medianKey={competency.median === null ? null : String(Math.round(competency.median))}
                    />
                    <p className="small muted">{spreadSentence(competency, '')}</p>
                  </div>
                ))}
              </div>
              <Reading>
                <strong>What this tells you:</strong> which competencies the interview actually separates
                people on. A competency where everyone lands on one level is not discriminating between
                candidates, whatever weight the scorecard gives it.{' '}
                <strong>What it does not:</strong> whether the level awarded was the right one. Competencies
                with no evidence are left out of the counts rather than graded zero, so a short bar can mean
                “rarely reached” as easily as “rarely awarded”.
              </Reading>
            </Section>
          )}

          <Section title="Where outcomes differ">
            <div className="row report-tabs" role="tablist" aria-label="Cut outcomes by">
              {CUT_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={cut === tab.key}
                  className={cut === tab.key ? 'btn btn-quiet is-current' : 'btn btn-quiet'}
                  onClick={() => setCut(tab.key)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <label className="field">
              <span className="field-label">Measure</span>
              <select value={measure} onChange={(e) => setMeasure(e.target.value as CutMeasureKey)} data-testid="report-measure">
                {CUT_MEASURES.map((m) => <option key={m.key} value={m.key}>{m.label} (of {m.of})</option>)}
              </select>
            </label>

            <RateBarChart
              bars={cutBars(
                cut === 'month'
                  ? report.cuts[cut].map((group) => ({ ...group, label: monthLabel(group.label) }))
                  : report.cuts[cut],
                measure,
                minSample,
              )}
              title={`${CUT_MEASURES.find((m) => m.key === measure)?.label} by ${CUT_TABS.find((t) => t.key === cut)?.label.toLowerCase()}`}
              summary="One bar per group. Every bar carries the sample it was computed from."
              valueHeading="Rate"
              // The full table of this cut sits directly below, with every
              // measure in it; the chart's own table would repeat five numbers
              // immediately above thirty.
              tableless
            />

            <div className="table-wrap">
              <table className="report-table">
                <caption className="sr-only">Every measure, for each group in this cut</caption>
                <thead>
                  <tr>
                    <th scope="col">{CUT_TABS.find((t) => t.key === cut)?.label}</th>
                    <th scope="col">Interviews</th>
                    <th scope="col">Completed</th>
                    <th scope="col">Reviewed</th>
                    <th scope="col">{VERDICT_LABELS.PROCEED}</th>
                    <th scope="col">{VERDICT_LABELS.DO_NOT_PROGRESS}</th>
                    <th scope="col">Median score</th>
                  </tr>
                </thead>
                <tbody>
                  {report.cuts[cut].map((group) => (
                    <tr key={group.key} className={group.readable ? undefined : 'report-row--unreadable'}>
                      <th scope="row">{cut === 'month' ? monthLabel(group.label) : group.label}</th>
                      <td className="num">{group.n}</td>
                      <td><RateValue rate={group.completed} minSample={minSample} /></td>
                      <td><RateValue rate={group.humanReviewed} minSample={minSample} /></td>
                      <td><RateValue rate={group.humanVerdicts.PROCEED} minSample={minSample} /></td>
                      <td><RateValue rate={group.humanVerdicts.DO_NOT_PROGRESS} minSample={minSample} /></td>
                      <td className="num">{group.score.median ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Reading>
              <strong>What this tells you:</strong> whether the groups in this cut had different outcomes.
              {' '}{CUT_TABS.find((t) => t.key === cut)?.note}{' '}
              <strong>What it does not:</strong> whether a difference is real. These are raw rates with no
              significance test and no control for anything — two groups can differ because they were given
              different candidates, different roles or a different month, and nothing here separates those.
              A difference worth acting on is one that survives being looked into, not one that looks large
              on this page.
            </Reading>
          </Section>

          <Section title="Interview health">
            <ul className="kpis report-kpis">
              <li className="kpi"><div className="kpi-link">
                <span className="kpi-value">{report.health.duration.median ?? '—'}</span>
                <span className="kpi-label">Median minutes</span>
                <span className="kpi-hint">{spreadSentence(report.health.duration, ' min')}</span>
              </div></li>
              {HEALTH_RATES.map((tile) => (
                <li className="kpi" key={tile.key}><div className="kpi-link">
                  {/* The figure itself carries the marking. A tile that showed a
                      bold percentage and hid "too few to read" in the hint would
                      be exactly the headline this page exists to prevent. */}
                  <span className="kpi-value"><RateValue rate={report.health[tile.key]} minSample={minSample} /></span>
                  <span className="kpi-label">{tile.label}</span>
                  <span className="kpi-hint">{tile.of}</span>
                </div></li>
              ))}
              <li className="kpi"><div className="kpi-link">
                {/* A mean is not a rate, but it is still a percentage read off
                    a sample, and the page's rule is about percentages. Below
                    the minimum it wears the same brackets as everything else. */}
                <span className="kpi-value">
                  <span className={report.health.evidenceCoverage.readable ? 'report-rate' : 'report-rate report-rate--unreadable'}>
                    <span className="report-rate-value">{percent(report.health.evidenceCoverage.mean)}</span>
                    <span className="report-rate-counts">
                      over {report.health.evidenceCoverage.n} assessment{report.health.evidenceCoverage.n === 1 ? '' : 's'}
                    </span>
                    {!report.health.evidenceCoverage.readable && report.health.evidenceCoverage.n > 0 && (
                      <span className="report-rate-note">{tooSmallNote(minSample)}</span>
                    )}
                  </span>
                </span>
                <span className="kpi-label">Mean evidence coverage</span>
              </div></li>
            </ul>
            <Reading>
              <strong>What this tells you:</strong> whether the interviews themselves ran properly. A rising
              non-answer rate, more rejoins or more turns written by a fallback model are all reasons to
              distrust the scores from that period before reading anything into them.{' '}
              <strong>What it does not:</strong> whose fault any of it was. A non-answer is a turn that said
              nothing — which can be a candidate thinking, a question that landed badly, or a microphone.
            </Reading>
          </Section>

          <Section title="Reviewers and the AI">
            <Banner kind={report.agreement.gate.met === true ? 'info' : 'error'}>
              <strong>
                {report.agreement.gate.met === true
                  ? 'The agreement gate condition is currently met — the score is still not a validated measure.'
                  : 'The score has not been validated against human judgement.'}
              </strong>
              <div style={{ marginTop: 6 }}>{report.agreement.sufficiency.statement}</div>
              <div style={{ marginTop: 6 }}>{report.agreement.gate.statement}</div>
              {report.agreementScopeNote && (
                <div className="small" style={{ marginTop: 8, opacity: 0.9 }}>{report.agreementScopeNote}</div>
              )}
            </Banner>

            <h3 className="report-panel-title">Where reviewers changed the AI’s mind</h3>
            <p className="small">
              Over {report.reviewerChanges.n} completed review{report.reviewerChanges.n === 1 ? '' : 's'}, the
              reviewer kept the AI’s verdict <RateValue rate={report.reviewerChanges.agreed} minSample={minSample} /> of the time.
              Reviewers raised {report.reviewerChanges.competencyChanges.humanHigher} competency level
              {report.reviewerChanges.competencyChanges.humanHigher === 1 ? '' : 's'} and lowered{' '}
              {report.reviewerChanges.competencyChanges.aiHigher}.
            </p>
            <div className="table-wrap">
              <table className="report-table">
                <caption className="sr-only">What reviewers decided, by what the AI had recommended</caption>
                <thead>
                  <tr>
                    <th scope="col">The AI said</th>
                    <th scope="col">Reviews</th>
                    <th scope="col">Reviewer kept it</th>
                    <th scope="col">{VERDICT_LABELS.PROCEED}</th>
                    <th scope="col">{VERDICT_LABELS.CONSIDER}</th>
                    <th scope="col">{VERDICT_LABELS.DO_NOT_PROGRESS}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.reviewerChanges.byAiRecommendation.map((entry) => (
                    <tr key={entry.recommendation}>
                      <th scope="row">{VERDICT_LABELS[entry.recommendation]}</th>
                      <td className="num">{entry.n}</td>
                      <td><RateValue rate={entry.agreed} minSample={minSample} /></td>
                      <td className="num">{entry.humanCounts.PROCEED}</td>
                      <td className="num">{entry.humanCounts.CONSIDER}</td>
                      <td className="num">{entry.humanCounts.DO_NOT_PROGRESS}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Reading>
              <strong>What this tells you:</strong> where reviewers and the model disagree, which is what the
              model is meant to learn from.{' '}
              <strong>What it does not — and this is the important one:</strong> whether the score is any
              good. These reviews were made with the AI’s answer already on screen, so a high figure measures
              anchoring, not accuracy. The only agreement statistic that says anything about validity is the
              one in the banner above, computed over verdicts recorded <em>before</em> the AI’s output was
              revealed ({report.agreement.sampleSize.blindVerdicts} so far).
            </Reading>
          </Section>

          <p className="muted small">
            Computed {formatDateTime(report.generatedAt)} over {report.interviews} interview
            {report.interviews === 1 ? '' : 's'}.
          </p>
        </>
      )}
    </>
  );
}
