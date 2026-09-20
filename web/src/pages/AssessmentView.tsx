import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Badge, recBadge, Banner, Stat, Markdown } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { CandidateFeedbackPanel } from '../components/CandidateFeedbackPanel';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';
import {
  DISPOSITIONS, canSubmitVerdict, exportStatusSentence, isBlindReviewGate, isDisposition, isScored, reviewRefusal,
  type Disposition,
} from '../components/assessmentModel';
import { FeedbackEmailPanel } from '../components/FeedbackEmailPanel';
import { AssessmentTabList, DifferencesPanel, HumanReviewPanel, type DifferencesView } from '../components/AssessmentTabs';
import {
  assessmentPanelId, assessmentTabFromParam, assessmentTabId, assessmentTabPath, landingTab, levelText,
  nextAssessmentTab, type AssessmentTabKey,
} from '../components/assessmentTabsModel';
import { humanise, recommendationStatus } from '../components/statusModel';
import { atsErrorMessage } from '../components/atsModel';
import { useAuth } from '../auth';
import { formatPercent, formatScoreOutOf100 } from '../components/scoreFormat';

interface Evidence { turnId: string; startMs: number; endMs: number; quote: string; }
interface Competency {
  id: string; name: string; level: number | null; requiredLevel: number; confidence: number;
  notEnoughEvidence: boolean; evidence: Evidence[]; rationale: string;
}
interface AssessmentResult {
  // Null when the grading provider was unreachable: the interview happened and
  // the evidence is here, but nothing was scored.
  recommendation: string; confidence: number; evidenceCoverage: number; overallScore: number | null;
  summary: string; competencies: Competency[];
  strengths: string[]; concerns: string[]; contradictions: string[];
  openQuestions: string[]; limitations: string[];
}
interface Review { id: string; status: string; disposition: string; reason: string; overrides: unknown[]; completedAt: string | null; }
interface ReviewedView {
  result: AssessmentResult;
  review: { id: string; reviewerId: string; disposition: string; reason: string; comments: string; completedAt: string | null };
}
interface AssessmentResp {
  id: string; sessionId: string;
  candidate: { id: string; name: string }; role: { id: string; title: string };
  result: AssessmentResult; reviews: Review[];
  /** The reviewed reading, the comparison and the outcome. Absent on an older server. */
  reviewed?: ReviewedView | null;
  differences?: DifferencesView | null;
  outcome?: { source: 'human' | 'ai'; recommendation: string; reviewedAt: string | null };
}

// ---------------------------------------------------------------------------
// Scoring-validity status
// ---------------------------------------------------------------------------

/** The fields of GET /api/assessments/shadow-metrics this UI reads. */
interface ShadowMetrics {
  sampleSize: { blindVerdicts: number; assessmentsTotal: number; coverage: number };
  sufficiency: { sufficient: boolean; minimumN: number; statement: string };
  gate: { source: string; threshold: number; statistic: string; met: boolean | null; statement: string };
}

/**
 * States, wherever an AI recommendation or score is on screen, that the scoring
 * has never been checked against human judgement.
 *
 * WHY: "advisory" on its own does not carry this. A reviewer reads it as a
 * liability disclaimer on a number that was nonetheless measured — and then
 * weighs the number accordingly. The thing they actually need to know is that
 * no agreement study has ever been run, which is a fact about the data, not a
 * caveat about liability.
 *
 * Every sentence of substance below is the SERVER'S wording, from
 * services/shadowMode.ts. That is deliberate: this component must not be able
 * to describe a state the harness would describe differently, and it must not
 * do its own arithmetic on the sample — a number computed here could flatter
 * the system without anyone noticing the divergence.
 *
 * It is not collapsible and has no dismiss control. The failure being designed
 * against is a caveat the reviewer learns to close.
 */
export function ValidationStatus() {
  const [metrics, setMetrics] = useState<ShadowMetrics | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api.get<ShadowMetrics>('/assessments/shadow-metrics')
      .then(setMetrics)
      .catch(() => setFailed(true));
  }, []);

  // Never render nothing. An absent notice reads as "no caveat applies", which
  // is the single message this component exists to prevent — so the unvalidated
  // headline is shown while loading and stays shown if the fetch fails.
  if (!metrics) {
    return (
      <Banner kind="error">
        <strong>This score has not been validated against human judgement.</strong>{' '}
        {failed
          ? 'The live agreement statistics could not be loaded, so nothing here has been confirmed either way.'
          : 'Loading the current agreement statistics…'}
      </Banner>
    );
  }

  const { sufficiency, gate } = metrics;
  // A met gate is still not validation: it is one measurement, against one
  // conservative reading of a launch gate, on a sample that may not be
  // representative. Only the headline softens — nothing else changes.
  const validated = gate.met === true;

  return (
    <Banner kind={validated ? 'info' : 'error'}>
      <strong>
        {validated
          ? 'The agreement gate condition is currently met — but this score is still not a validated measure.'
          : 'This score has not been validated against human judgement.'}
      </strong>
      <div style={{ marginTop: 6 }}>{sufficiency.statement}</div>
      <div style={{ marginTop: 6 }}>{gate.statement}</div>
      <div className="small" style={{ marginTop: 8, opacity: 0.9 }}>
        Nothing here becomes validated by accumulating verdicts. {sufficiency.minimumN} paired blind
        verdicts is only the point at which the confidence interval starts to mean anything — a floor for
        reading the statistic, not a pass mark. Clearing the gate additionally requires the LOWER bound of
        {/* Named, because every other number on this page is out of 100 or a
            percentage, and a bare "0.75" beside them reads as one of those. */}
        that interval to reach a kappa of {gate.threshold}, which a larger sample does not bring about on its own.
        Treat the recommendation and score as one opinion to argue with, not as a measurement.
      </div>
      <details style={{ marginTop: 8 }}>
        <summary className="small">How this is measured</summary>
        <p className="small" style={{ marginBottom: 4 }}>{gate.statistic}</p>
        <p className="small muted" style={{ margin: 0 }}>{gate.source}</p>
      </details>
    </Banner>
  );
}

const STRING_CARD_ICONS: Readonly<Record<string, IconName>> = {
  Strengths: 'check-circle',
  Concerns: 'alert',
  Contradictions: 'x-circle',
  'Open questions': 'question',
  Limitations: 'about',
};

function StringCard({ title, items }: { title: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="card">
      <h3 className="card-title"><Icon name={STRING_CARD_ICONS[title] ?? 'list'} size={16} />{title}</h3>
      <ul style={{ margin: 0 }}>{items.map((s, i) => <li key={i}>{s}</li>)}</ul>
    </div>
  );
}

export function AssessmentView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // The tab is the last segment of the address (/assessments/:id/ai), so a
  // link to one reading stays a link to that reading. Kept as explicit routes
  // rather than a wildcard, which would also swallow /review.
  const lastSegment = useLocation().pathname.split('/').filter(Boolean).pop();
  const tab = lastSegment === 'human' || lastSegment === 'ai' || lastSegment === 'differences' ? lastSegment : undefined;
  const [data, setData] = useState<AssessmentResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Empty until the reviewer chooses. Pre-filling it — from the AI's own
  // recommendation, of all things — meant a verdict could be recorded that
  // nobody had made, including against an assessment that failed to load.
  const [disposition, setDisposition] = useState<Disposition | ''>('');
  const [reason, setReason] = useState('');
  const [comments, setComments] = useState('');
  // Per-competency levels the reviewer disagrees with. Empty means "the AI's
  // level stands", which is a verdict in itself and is recorded as agreement.
  const [levels, setLevels] = useState<Record<string, string>>({});
  const [levelReasons, setLevelReasons] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  // The candidate's letter is being sent and the review has to wait a minute:
  // shown as information with a retry, not as a red error.
  const [reviewWait, setReviewWait] = useState('');

  const { user } = useAuth();
  const [exportStatus, setExportStatus] = useState('');
  const [exporting, setExporting] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [report, setReport] = useState('');
  const [reportLoading, setReportLoading] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [skipReason, setSkipReason] = useState('');

  // `cancelled` so a response for an assessment the reviewer has already left
  // cannot overwrite the one in front of them.
  const cancelledRef = useRef(false);

  // Returns its promise so callers can wait for fresh data before re-enabling
  // the button that asked for it.
  const load = () =>
    api.get<AssessmentResp>(`/assessments/${id}`)
      .then((d) => { if (cancelledRef.current) return; setData(d); setBlocked(false); })
      .catch((err: unknown) => {
        if (cancelledRef.current) return;
        // Where the organisation requires it, the server withholds this page
        // from a reviewer who has not yet recorded their own verdict. That is a
        // workflow state, not a failure, so it gets a route forward rather than
        // a red error box. Read from the status and code, not from the prose:
        // rewording the server's sentence used to turn this gate into a red
        // error nobody could get past. Everywhere else the page opens at once.
        if (err instanceof ApiError && isBlindReviewGate(err)) setBlocked(true);
        else setError(err instanceof Error ? err.message : 'Could not load this assessment.');
      })
      .finally(() => { if (!cancelledRef.current) setLoading(false); });

  useEffect(() => {
    cancelledRef.current = false;
    setLoading(true);
    void load();
    return () => { cancelledRef.current = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const skipBlind = async () => {
    if (skipReason.trim().length < 10) return;
    setError('');
    try {
      await api.post(`/assessments/${id}/skip-blind-review`, { reason: skipReason.trim() });
      setLoading(true);
      await load();
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Could not open this assessment.'); }
  };

  if (loading) return <PageSkeleton label="Loading assessment…" cards={3} />;

  if (blocked) {
    return (
      <div className="stack">
        <h2 className="card-title"><Icon name="lock" />Independent review required</h2>
        <Banner kind="info">
          The AI's recommendation and scores are hidden until you record your own judgement.
          This keeps your read independent — which is both the point of a second opinion and
          what keeps the AI advisory rather than the decision-maker.
        </Banner>
        <div className="card">
          <Link className="btn" to={`/assessments/${id}/review`}><Icon name="eye-off" size={16} />Review the evidence blind</Link>
        </div>
        <details className="card">
          <summary>I need to open it without reviewing</summary>
          <p className="muted">
            Legitimate sometimes — re-reading a candidate you already decided on, a compliance
            check, investigating a bad report. It is recorded against your name and shown in the
            shadow-mode metrics, so skipping habitually is visible rather than assumed fine.
          </p>
          <label htmlFor="skip-reason">Reason</label>
          <textarea id="skip-reason" rows={3} value={skipReason} onChange={(e) => setSkipReason(e.target.value)} />
          <button className="btn secondary" disabled={skipReason.trim().length < 10} onClick={skipBlind}>
            <Icon name="eye" size={16} />Open without blind review
          </button>
        </details>
        {error && <Banner kind="error">{error}</Banner>}
      </div>
    );
  }

  if (error && !data) return <Banner kind="error">{error}</Banner>;
  if (!data) {
    return (
      <EmptyState
        icon="evidence"
        title="Assessment not found"
        message="It may not have been produced yet, or the link is out of date."
        action={<Link className="btn secondary" to="/interviews"><Icon name="arrow-left" size={16} />All interviews</Link>}
      />
    );
  }

  const { candidate, role, result, reviews } = data;
  const scored = isScored(result);

  const submitReview = async (e?: React.FormEvent) => {
    e?.preventDefault();
    // The browser's own disabled button is not the only route here (Enter in a
    // field submits too), so the rule is checked rather than assumed.
    if (!canSubmitVerdict({ disposition, reason, scored, submitting })) return;
    setError('');
    setNotice('');
    setReviewWait('');
    setSubmitting(true);
    try {
      // Only the levels the reviewer actually changed travel: an untouched
      // competency is agreement, and sending it as an "override" to the same
      // value would make the comparison meaningless.
      const overrides = (result.competencies ?? [])
        .filter((c) => levels[c.id] && Number(levels[c.id]) !== c.level)
        .map((c) => ({ competencyId: c.id, from: c.level, to: Number(levels[c.id]), reason: levelReasons[c.id] ?? '' }));
      await api.post(`/assessments/${id}/review`, {
        disposition, reason, comments: comments || undefined, overrides,
      });
      setNotice('Review submitted.');
      setDisposition('');
      setReason('');
      setComments('');
      setLevels({});
      setLevelReasons({});
      // Awaited: the button used to re-enable over a page still showing the
      // state from before the review landed.
      await load();
    } catch (err: unknown) {
      const refusal = reviewRefusal(err instanceof ApiError ? err : { message: err instanceof Error ? err.message : '' });
      if (refusal.kind === 'wait') setReviewWait(refusal.message);
      else setError(refusal.message);
    } finally {
      setSubmitting(false);
    }
  };

  const doExport = async () => {
    if (exporting) return;
    setExportStatus('');
    setExporting(true);
    try {
      const r = await api.post<{ status: string }>(`/assessments/${id}/export`, {});
      setExportStatus(r.status);
    } catch (err: unknown) {
      // A missing ATS or candidate link is fixable, and the message says by whom.
      if (err instanceof ApiError) setError(atsErrorMessage(err, user?.role === 'admin'));
      else setError(err instanceof Error ? err.message : 'Could not export this assessment.');
    } finally {
      setExporting(false);
    }
  };

  const toggleReport = async () => {
    if (showReport) { setShowReport(false); return; }
    if (reportLoading) return;
    if (!report) {
      setReportLoading(true);
      try {
        const r = await api.get<{ report: string; result: AssessmentResult }>(`/assessments/${id}/report?format=json`);
        setReport(r.report);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Could not load the full report.');
        setReportLoading(false);
        return;
      }
      setReportLoading(false);
    }
    setShowReport(true);
  };

  // Recording a verdict belongs with the human reading, so the form lives on
  // that tab — including the levels the reviewer wants to change.
  const reviewForm = (
    <div className="card">
      <h2 className="card-title"><Icon name="human-review" />Record your review</h2>
        <form onSubmit={submitReview}>
          <div className="grid cols-2">
            <div>
              <label htmlFor="disposition">Disposition</label>
              <select
                id="disposition"
                value={disposition}
                disabled={!scored}
                onChange={(e) => setDisposition(isDisposition(e.target.value) ? e.target.value : '')}
              >
                <option value="">Choose a disposition…</option>
                {DISPOSITIONS.map((d) => (
                  <option key={d} value={d}>{recommendationStatus(d).label}</option>
                ))}
              </select>
              {!scored && (
                <p className="muted small" style={{ marginTop: 6 }}>
                  There is no assessment to judge, so no verdict can be recorded here. Record your
                  decision from the candidate's page instead.
                </p>
              )}
            </div>
          </div>
          {/* minWidth: 0 because a fieldset sizes to its content by default,
              so the scrolling table inside it would push the whole page
              sideways on a phone instead of scrolling within its card. */}
          <fieldset
            style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginTop: 12, minWidth: 0 }}
            disabled={!scored}
          >
            <legend className="small muted">Levels (optional)</legend>
            <p className="muted small" style={{ marginTop: 0 }}>
              Change a level only where you read the evidence differently. What you leave alone counts as agreeing
              with the AI, and both are kept on the "Key differences" tab.
            </p>
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Competency levels">
              <table>
                <thead><tr><th>Competency</th><th>AI</th><th>Your level</th><th>Why</th></tr></thead>
                <tbody>
                  {(result.competencies ?? []).map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td className="muted">{c.notEnoughEvidence ? 'Not graded' : levelText(c.level)}</td>
                      <td>
                        <label className="sr-only" htmlFor={`level-${c.id}`}>Your level for {c.name}</label>
                        <select
                          id={`level-${c.id}`}
                          value={levels[c.id] ?? ''}
                          onChange={(e) => setLevels((prev) => ({ ...prev, [c.id]: e.target.value }))}
                        >
                          <option value="">Agree with the AI</option>
                          {[1, 2, 3, 4, 5].map((level) => <option key={level} value={level}>{levelText(level)}</option>)}
                        </select>
                      </td>
                      <td>
                        <label className="sr-only" htmlFor={`level-reason-${c.id}`}>Why you changed {c.name}</label>
                        <input
                          id={`level-reason-${c.id}`}
                          value={levelReasons[c.id] ?? ''}
                          onChange={(e) => setLevelReasons((prev) => ({ ...prev, [c.id]: e.target.value }))}
                          placeholder="Optional"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </fieldset>
          <label htmlFor="review-reason">Reason (required)</label>
          <textarea id="review-reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3}
            disabled={!scored}
            placeholder="Explain your decision…" style={{ minHeight: 90 }} />
          <label htmlFor="review-comments">Comments (optional)</label>
          <textarea id="review-comments" value={comments} onChange={(e) => setComments(e.target.value)} disabled={!scored}
            style={{ minHeight: 60 }} />
          {reviewWait && (
            <Banner kind="info">
              {reviewWait}{' '}
              <button type="button" className="btn secondary sm" onClick={() => void submitReview()} disabled={submitting}>
                Try again
              </button>
            </Banner>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" type="submit" disabled={!canSubmitVerdict({ disposition, reason, scored, submitting })}>
              <Icon name={submitting ? 'hourglass' : 'send'} size={16} />
              {submitting ? 'Submitting…' : 'Submit review'}
            </button>
          </div>
        </form>

        {(reviews ?? []).length > 0 && (
          <div style={{ marginTop: 16 }}>
            <h3>Previous reviews</h3>
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Previous reviews">
            <table>
              <thead><tr><th>Disposition</th><th>Reason</th><th>Status</th><th>Completed</th></tr></thead>
              <tbody>
                {reviews.map((r) => (
                  <tr key={r.id}>
                    <td>{recBadge(r.disposition)}</td>
                    <td className="muted small">{r.reason}</td>
                    <td>{humanise(r.status)}</td>
                    <td className="muted small">{r.completedAt ? new Date(r.completedAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </div>
  );

  // Addressable tabs, like the admin console's: a link to "the differences"
  // stays a link to the differences.
  // Only an address that names a tab counts as a request; the plain address
  // lets landingTab choose, which is how a reviewed assessment opens on the
  // human reading and an unreviewed one on the AI's.
  const requested = tab ? assessmentTabFromParam(tab) ?? undefined : undefined;
  const reviewed = data.reviewed ?? null;
  const differences = data.differences ?? null;
  const outcome = data.outcome ?? { source: 'ai' as const, recommendation: result.recommendation, reviewedAt: null };
  const activeTab = landingTab({ reviewed: Boolean(reviewed), requested });
  const selectTab = (key: AssessmentTabKey) => navigate(assessmentTabPath(id ?? '', key));
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, current: AssessmentTabKey) => {
    const next = nextAssessmentTab(current, event.key);
    if (next === current) return;
    event.preventDefault();
    selectTab(next);
    window.requestAnimationFrame(() => document.getElementById(assessmentTabId(next))?.focus());
  };
  const panel = (key: AssessmentTabKey, content: React.ReactNode) => activeTab === key && (
    <section id={assessmentPanelId(key)} role="tabpanel" aria-labelledby={assessmentTabId(key)} tabIndex={0} className="admin-panel">
      {content}
    </section>
  );
  const changedIds = new Set((differences?.competencies ?? []).filter((c) => c.changed).map((c) => c.competencyId));

  return (
    <div>
      <PageHeader
        icon="evidence"
        title="Assessment"
        badge={recBadge(outcome.recommendation)}
        subtitle={(
          <>
            <Link to={`/candidates/${candidate.id}`}>{candidate.name}</Link> · {role.title}
            {' · '}
            <span className="muted">{outcome.source === 'human' ? "reviewer's verdict" : 'AI assessment, not yet reviewed'}</span>
          </>
        )}
        actions={
          <>
            {/* Offered here because this page shows the recommendation on sight —
                once a reviewer has read it they cannot un-read it, so the blind
                route has to be reachable before they form a view, not after. */}
            <Link className="btn secondary" to={`/assessments/${id}/review`}><Icon name="eye-off" size={16} />Review this blind</Link>
            <button type="button" className="btn secondary" onClick={doExport} disabled={exporting}>
              <Icon name={exporting ? 'hourglass' : 'export'} size={16} />
              {exporting ? 'Exporting…' : 'Export to ATS'}
            </button>
            <button type="button" className="btn ghost" onClick={toggleReport} disabled={reportLoading}>
              <Icon name={showReport ? 'eye-off' : 'eye'} size={16} />
              {reportLoading ? 'Loading…' : showReport ? 'Hide full report' : 'View full report'}
            </button>
          </>
        }
      />

      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="ok">{notice}</Banner>}
      {exportStatus && <Banner kind="info">{exportStatusSentence(exportStatus)}</Banner>}

      {/* Above the score, not below it. A reviewer who has already read
          "76/100" has formed the impression the notice is meant to qualify. */}
      <ValidationStatus />

      <AssessmentTabList active={activeTab} onSelect={selectTab} onKeyDown={handleTabKeyDown} />

      {panel('human', (
        <HumanReviewPanel
          review={reviewed ? { ...reviewed.review, completedAt: reviewed.review.completedAt } : null}
          competencies={(reviewed?.result.competencies ?? []).map((c) => ({
            id: c.id, name: c.name, level: c.level, requiredLevel: c.requiredLevel, notEnoughEvidence: c.notEnoughEvidence,
          }))}
          changedIds={changedIds}
        >
          {reviewForm}
        </HumanReviewPanel>
      ))}

      {panel('differences', <DifferencesPanel differences={differences} />)}

      {panel('ai', (
      <div className="stack">
      {scored ? (
        <div className="grid cols-3" style={{ marginBottom: 16 }}>
          <Stat label="Overall score" value={formatScoreOutOf100(result.overallScore)} />
          <Stat label="Confidence" value={formatPercent(result.confidence)} />
          <Stat label="Evidence coverage" value={formatPercent(result.evidenceCoverage)} />
        </div>
      ) : (
        /* Rounding a score that is not there rendered "NaN/100" and "NaN%",
           which reads as a real, very bad result. Say what actually happened. */
        <Banner kind="error">
          <strong>This assessment has no score.</strong>
          <div style={{ marginTop: 6 }}>
            Grading did not complete, so there is no overall score, no confidence and no usable
            recommendation. The transcript and whatever evidence was captured are still below —
            read those, and re-run the assessment from the interview if you need a score.
          </div>
        </Banner>
      )}

      <div className="card">
        <h2 className="card-title"><Icon name="about" />Summary</h2>
        <p style={{ marginBottom: 0 }}>{result.summary}</p>
      </div>

      {showReport && (
        <div className="card">
          <h2 className="card-title"><Icon name="reports" />Full report</h2>
          <Markdown text={report} />
        </div>
      )}

      <div className="card">
        <h2 className="card-title"><Icon name="scorecard" />Competency scorecard</h2>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Competency scorecard">
        <table>
          <thead>
            <tr><th>Competency</th><th>Level</th><th>Required</th><th>Confidence</th><th>Evidence</th></tr>
          </thead>
          <tbody>
            {(result.competencies ?? []).map((c) => (
              <tr key={c.id}>
                <td>
                  {c.name}
                  {c.rationale && <div className="muted small" style={{ marginTop: 4 }}>{c.rationale}</div>}
                  {(c.evidence ?? []).length > 0 && (
                    <div style={{ marginTop: 6 }}>
                      {c.evidence.map((e, i) => (
                        <div key={i} className="muted small" style={{ borderLeft: '3px solid var(--border)', paddingLeft: 8, margin: '4px 0' }}>
                          “{e.quote}”
                        </div>
                      ))}
                    </div>
                  )}
                </td>
                <td>
                  {c.notEnoughEvidence
                    ? <Badge kind="amber">Not Enough Evidence</Badge>
                    : <b>{c.level ?? '—'}/5</b>}
                </td>
                <td className="muted">{c.requiredLevel}/5</td>
                <td>{formatPercent(c.confidence)}</td>
                <td>{(c.evidence ?? []).length}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      <div className="grid cols-2">
        <StringCard title="Strengths" items={result.strengths} />
        <StringCard title="Concerns" items={result.concerns} />
        <StringCard title="Contradictions" items={result.contradictions} />
        <StringCard title="Open questions" items={result.openQuestions} />
        <StringCard title="Limitations" items={result.limitations} />
      </div>
      </div>
      ))}

      {/* What the candidate was emailed automatically after the interview, and
          "Send feedback now" when nothing went. Keyed so a different
          assessment starts clean. */}
      {id && <FeedbackEmailPanel key={`email-${id}`} assessmentId={id} />}

      {/* After the review on purpose: feedback can only be drafted once a
          person has completed one. Keyed so a different assessment starts clean. */}
      {id && <CandidateFeedbackPanel key={id} assessmentId={id} />}
    </div>
  );
}
