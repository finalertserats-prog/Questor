import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Banner, Markdown, recBadge } from '../components/ui';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { CandidateFeedbackPanel } from '../components/CandidateFeedbackPanel';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';
import { isBlindReviewGate, isScored, reviewRefusal } from '../components/assessmentModel';
import { FeedbackEmailPanel } from '../components/FeedbackEmailPanel';
import { DifferencesPanel, type DifferencesView } from '../components/AssessmentTabs';
import { TechStackCoverage, type TechStackCoverageItem } from '../components/TechStackCoverage';
import { humanise } from '../components/statusModel';
import { atsErrorMessage } from '../components/atsModel';
import { useAuth } from '../auth';
import { can, onlyWhoCan } from '../components/capabilityModel';
import { formatPercent, formatScoreOutOf100 } from '../components/scoreFormat';
import { REVIEW_SECTION_ID } from '../components/review/transcriptReaderModel';
import { useReviewTranscript, type TranscriptSource } from '../components/review/useTranscriptReader';
import { formatDateTime } from '../components/dateFormat';
import { servingModeSentence, type ServingModeView } from '../components/servingModeModel';
import { QuestionsAskedCard } from '../components/QuestionsAskedCard';
import type { AskedQuestion } from '../components/questionsAskedModel';
import { useToast } from '../components/Toast';
import { VerdictPanel } from '../components/assessment/VerdictPanel';
import { SkillsGrid, type SkillView } from '../components/assessment/SkillsGrid';
import { AssessmentTranscript } from '../components/assessment/AssessmentTranscript';
import { outcomeLabel, type Verdict } from '../components/assessment/verdictVocabulary';
import {
  caveatSentence, consequenceCopy, consequenceFor, exportRefusalSentence, levelText, outcomeSentence,
  type ExportOffer, type JourneyMove, type JourneyView,
} from '../components/assessment/verdictFlowModel';
import { ValidationStatus } from '../components/assessment/ValidationStatus';
import { Fold, SwotFold } from '../components/assessment/AssessmentFolds';

/**
 * The assessment, in the order a reviewer actually works.
 *
 * The decision is at the top — the AI's reading beside the reviewer's own, and
 * each choice saying what it will do before it does it. The skills are below
 * with their evidence, and pressing a quote marks that turn in the transcript
 * alongside. Everything else — the strengths and concerns, the identity
 * checks, the questions asked, the candidate's letter — folds underneath,
 * because it is reference, not the work.
 *
 * Two rules the layout must not break. Where the organisation requires blind
 * review, the AI's recommendation stays withheld until the reviewer has
 * recorded their own; and the transcript is never withheld, because the
 * reviewer judges from it.
 */

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
  /** Which required technologies the interview evidenced. Absent before the tech-stack release. */
  techStackCoverage?: TechStackCoverageItem[];
}
interface Review { id: string; status: string; disposition: string; reason: string; overrides: unknown[]; completedAt: string | null; }
interface AssessmentResp {
  id: string; sessionId: string;
  candidate: { id: string; name: string }; role: { id: string; title: string };
  result: AssessmentResult; reviews: Review[];
  reviewed?: { review: { id: string; reviewerId: string; disposition: string; reason: string; comments: string; completedAt: string | null } } | null;
  differences?: DifferencesView | null;
  outcome?: { source: 'human' | 'ai'; recommendation: string; reviewedAt: string | null };
  /** Turns written by a fallback during an AI provider outage. Absent on an older server. */
  servingMode?: ServingModeView;
  /** What the interviewer asked, for interviews the question library planned; absent otherwise. */
  questionsAsked?: AskedQuestion[];
  /** Where the candidate stands and what each verdict would do. Absent on an older server. */
  journey?: JourneyView | null;
  export?: ExportOffer;
}

interface SubmitResult {
  review: { id: string; verdict: string; selfReview: boolean };
  replayed: boolean;
  feedbackReleased: boolean;
  journey: JourneyMove | null;
  export: ExportOffer;
}

/** A submit id per attempt, so a retry of the same press records one review. */
function newSubmissionId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function AssessmentView() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { user } = useAuth();

  const [data, setData] = useState<AssessmentResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [skipReason, setSkipReason] = useState('');

  // Empty until the reviewer chooses. Pre-filling it — from the AI's own
  // recommendation, of all things — meant a verdict could be recorded that
  // nobody had made, including against an assessment that failed to load.
  const [verdict, setVerdict] = useState<Verdict | ''>('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // The candidate's letter is being sent and the review has to wait a minute:
  // shown as information with a retry, not as a red error.
  const [reviewWait, setReviewWait] = useState('');
  /**
   * The id of the judgement being submitted, not of the press.
   *
   * It is kept across failures on purpose: the case idempotency exists for is
   * a response lost AFTER the server committed, and a retry that invented a
   * fresh id would come back as "already reviewed" for the reviewer's own
   * review. It is cleared when the judgement itself changes — a different
   * verdict or a different reason is a different submission, and must not
   * replay the previous one — and when a submit succeeds.
   */
  const submissionRef = useRef('');
  const startNewSubmission = () => { submissionRef.current = ''; };

  // Per-competency levels the reviewer disagrees with. Empty means "the AI's
  // level stands", which is a verdict in itself and is recorded as agreement.
  // Folded rather than dropped: it is what the "where the reviewer and the AI
  // differ" record is made of, so a page without it would quietly retire that.
  const [levels, setLevels] = useState<Record<string, string>>({});
  const [levelReasons, setLevelReasons] = useState<Record<string, string>>({});

  const [activeChip, setActiveChip] = useState('');
  const [quotedTurnId, setQuotedTurnId] = useState('');
  const [quotedAt, setQuotedAt] = useState(0);
  const [transcriptRead, setTranscriptRead] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [report, setReport] = useState('');
  const [reportLoading, setReportLoading] = useState(false);

  // `cancelled` so a response for an assessment the reviewer has already left
  // cannot overwrite the one in front of them.
  const cancelledRef = useRef(false);

  const load = useCallback(() =>
    api.get<AssessmentResp>(`/assessments/${id}`)
      .then((d) => { if (cancelledRef.current) return; setData(d); setBlocked(false); })
      .catch((err: unknown) => {
        if (cancelledRef.current) return;
        // Where the organisation requires it, the server withholds this page
        // from a reviewer who has not yet recorded their own verdict. That is a
        // workflow state, not a failure, so it gets a route forward rather than
        // a red error box. Read from the status and code, not from the prose.
        if (err instanceof ApiError && isBlindReviewGate(err)) setBlocked(true);
        else setError(err instanceof Error ? err.message : 'Could not load this assessment.');
      })
      .finally(() => { if (!cancelledRef.current) setLoading(false); }), [id]);

  useEffect(() => {
    cancelledRef.current = false;
    setLoading(true);
    void load();
    return () => { cancelledRef.current = true; };
  }, [id, load]);

  // The transcript. Once the assessment is open it comes from the interview's
  // own endpoint; while the blind-review policy is still withholding the
  // assessment it comes from the blind view — the reviewer judges from the
  // transcript, so the gate must never hide it.
  const transcriptSource: TranscriptSource | null = blocked && id
    ? { kind: 'blind', assessmentId: id }
    : data
      ? {
        kind: 'interview', sessionId: data.sessionId, candidate: data.candidate.name, role: data.role.title,
        competencyNames: Object.fromEntries((data.result.competencies ?? []).map((c) => [c.id, c.name])),
      }
      : null;
  const transcript = useReviewTranscript(transcriptSource);

  const onChip = useCallback((chip: { key: string; turnId: string }) => {
    setActiveChip(chip.key);
    setQuotedTurnId(chip.turnId);
    setQuotedAt((n) => n + 1);
  }, []);

  const transcriptBlock = (
    <AssessmentTranscript
      status={transcript.status}
      rows={transcript.view?.rows ?? []}
      error={transcript.error}
      onRetry={transcript.retry}
      quotedTurnId={quotedTurnId}
      quotedAt={quotedAt}
      transcriptKey={transcript.key}
      onRead={setTranscriptRead}
    />
  );

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

  // The blind-review gate. Unchanged in substance: the transcript is shown,
  // the AI's reading is not, and the way forward is an independent review.
  if (blocked) {
    return (
      <div className="stack">
        <h2 id={REVIEW_SECTION_ID} className="card-title review-section" tabIndex={-1}>
          <Icon name="lock" />Independent review required
        </h2>
        <Banner kind="info">
          The AI's recommendation and scores are hidden until you record your own judgement.
          This keeps your read independent — which is both the point of a second opinion and
          what keeps the AI advisory rather than the decision-maker.
        </Banner>
        <div className="card">
          <Link className="btn" to={`/assessments/${id}/review`}><Icon name="eye-off" size={16} />Review the evidence blind</Link>
        </div>
        {transcriptBlock}
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
  const mayReview = can(user, 'assessment:review');
  const journey = data.journey ?? null;
  const reviewed = data.reviewed ?? null;
  const offer = data.export ?? { available: can(user, 'assessment:export'), because: null };

  const consequence = verdict === '' ? null : consequenceFor(journey, verdict);
  const copy = verdict === ''
    ? null
    : consequenceCopy({ verdict, consequence, candidate: candidate.name, letterWaiting: journey?.letterWaiting ?? false });

  const canSubmit = verdict !== '' && reason.trim().length >= 3 && scored && !submitting;

  const refusal = !mayReview
    ? onlyWhoCan('assessment:review', 'record a review')
    : !scored
      ? 'Grading did not complete, so there is nothing to record a verdict against. Decide from the candidate\'s page instead.'
      : reviewed
        ? `Reviewed already: ${outcomeLabel(reviewed.review.disposition)}, ${formatDateTime(reviewed.review.completedAt)}. Replacing a completed review is done from the candidate's page, with a reason.`
        : '';

  const submit = async (applyToJourney: boolean) => {
    // canSubmit already carries "a verdict was chosen", which is what narrows
    // `verdict` from the empty string below.
    if (!canSubmit) return;
    setError('');
    setReviewWait('');
    setSubmitting(true);
    // One id per attempt: a retry of this press carries the same one, so the
    // server records a single review however many copies arrive.
    if (!submissionRef.current) submissionRef.current = newSubmissionId();
    try {
      // Only the levels the reviewer actually changed travel: an untouched
      // competency is agreement, and sending it as an "override" to the same
      // value would make the comparison meaningless.
      const overrides = (result.competencies ?? [])
        .filter((c) => levels[c.id] && Number(levels[c.id]) !== c.level)
        .map((c) => ({ competencyId: c.id, from: c.level, to: Number(levels[c.id]), reason: levelReasons[c.id] ?? '' }));
      const res = await api.post<SubmitResult>(`/assessments/${id}/review`, {
        verdict, reason: reason.trim(), overrides, applyToJourney, submissionId: submissionRef.current,
      });
      toast.show(outcomeSentence({ verdict, move: res.journey, candidate: candidate.name }), { testId: 'verdict-recorded' });
      submissionRef.current = '';
      setVerdict('');
      setReason('');
      setLevels({});
      setLevelReasons({});
      // Awaited: the panel used to re-enable over a page still showing the
      // state from before the review landed.
      await load();
    } catch (err: unknown) {
      // The id is deliberately NOT cleared here. A failure this side of the
      // wire says nothing about whether the server committed, and pressing
      // again with the same id is what turns a lost answer back into the
      // reviewer's own review rather than a refusal.
      const refused = reviewRefusal(err instanceof ApiError ? err : { message: err instanceof Error ? err.message : '' });
      if (refused.kind === 'wait') setReviewWait(refused.message);
      else setError(refused.message);
    } finally {
      setSubmitting(false);
    }
  };

  const doExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const r = await api.post<{ status: string }>(`/assessments/${id}/export`, {});
      toast.show(`Sent to your ATS (${humanise(r.status)}).`, { testId: 'export-done' });
    } catch (err: unknown) {
      if (err instanceof ApiError) setError(atsErrorMessage(err, user?.role === 'admin'));
      else setError(err instanceof Error ? err.message : 'Could not export this assessment.');
    } finally {
      setExporting(false);
    }
  };

  const loadReport = async () => {
    if (report || reportLoading) return;
    setReportLoading(true);
    try {
      const r = await api.get<{ report: string }>(`/assessments/${id}/report?format=json`);
      setReport(r.report);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not load the full report.');
    } finally {
      setReportLoading(false);
    }
  };

  const skills: SkillView[] = (result.competencies ?? []).map((c) => ({
    id: c.id, name: c.name, level: c.level, requiredLevel: c.requiredLevel,
    notEnoughEvidence: c.notEnoughEvidence, rationale: c.rationale, evidence: c.evidence ?? [],
  }));

  const exportRefusal = exportRefusalSentence(offer);

  return (
    <div>
      <PageHeader
        icon="evidence"
        title="Assessment"
        badge={reviewed ? recBadge(reviewed.review.disposition) : undefined}
        subtitle={(
          <>
            <Link to={`/candidates/${candidate.id}`}>{candidate.name}</Link> · {role.title}
            {journey && <> · <span className="muted">{journey.currentStageLabel}</span></>}
            {' · '}
            <span className="muted">{reviewed ? "reviewer's verdict" : 'not yet reviewed'}</span>
          </>
        )}
        actions={
          <>
            {mayReview && !reviewed && (
              <Link className="btn secondary" to={`/assessments/${id}/review`}><Icon name="eye-off" size={16} />Review this blind</Link>
            )}
          </>
        }
      />

      {error && <Banner kind="error">{error}</Banner>}
      {reviewWait && (
        <Banner kind="info">
          {reviewWait}{' '}
          <button type="button" className="btn secondary sm" onClick={() => void submit(true)} disabled={submitting}>
            Try again
          </button>
        </Banner>
      )}

      {/* Above the score, not below it: a reviewer who has already read
          "76/100" has formed the impression the notice is meant to qualify. */}
      <ValidationStatus />

      {servingModeSentence(data.servingMode) && (
        <p className="muted small" role="note" data-testid="serving-mode-note">{servingModeSentence(data.servingMode)}</p>
      )}

      <div className="as">
        <div className="as-main">
          {/* Not a gate, and never was: a note about what the page would
              rather the reviewer did, beside the decision it is about. It
              turns once the column alongside has been read to the end. */}
          <p className={transcriptRead ? 'reader-note is-read' : 'reader-note'} data-testid="transcript-read-note" role="status">
            <Icon name={transcriptRead ? 'check-circle' : 'evidence'} size={16} />
            {transcriptRead ? 'Transcript read.' : 'Read the transcript before recording your review.'}
          </p>

          <section id={REVIEW_SECTION_ID} className="review-section" tabIndex={-1} aria-label="The verdict">
            <VerdictPanel
              ai={scored ? {
                recommendation: result.recommendation,
                confidence: result.confidence,
                caveat: caveatSentence(result),
              } : null}
              candidate={candidate.name}
              verdict={verdict}
              onVerdict={(v) => { startNewSubmission(); setVerdict(v); }}
              reason={reason}
              onReason={(r) => { startNewSubmission(); setReason(r); }}
              copy={copy}
              canSubmit={canSubmit}
              submitting={submitting}
              onSubmit={(apply) => void submit(apply)}
              refusal={refusal}
            />
          </section>

          {!scored && (
            <Banner kind="error">
              <strong>This assessment has no score.</strong>
              <div style={{ marginTop: 6 }}>
                Grading did not complete, so there is no overall score, no confidence and no usable
                recommendation. The transcript and whatever evidence was captured are still here —
                read those, and re-run the assessment from the interview if you need a score.
              </div>
            </Banner>
          )}

          {/* Offered where the verdict is recorded, not behind another screen.
              When it is not on offer, the page says who can rather than
              showing nothing at all. */}
          <p className="row" data-testid="export-offer">
            {offer.available
              ? (
                <button type="button" className="btn secondary" onClick={doExport} disabled={exporting}>
                  <Icon name={exporting ? 'hourglass' : 'export'} size={16} />
                  {exporting ? 'Exporting…' : 'Export to ATS'}
                </button>
              )
              : <span className="muted small">{exportRefusal}</span>}
          </p>

          <SkillsGrid skills={skills} activeChip={activeChip} onChip={onChip} />

          {mayReview && scored && !reviewed && skills.length > 0 && (
            <Fold
              title="Change a level where you read it differently"
              count="optional"
              testId="levels-fold"
            >
              <p className="muted small">
                What you leave alone counts as agreeing with the AI. Both are kept, and the
                comparison is what "where the reviewer and the AI differ" is made of.
              </p>
              <div className="table-scroll" tabIndex={0} role="region" aria-label="Competency levels">
                <table>
                  <thead><tr><th>Competency</th><th>AI</th><th>Your level</th><th>Why</th></tr></thead>
                  <tbody>
                    {skills.map((c) => (
                      <tr key={c.id}>
                        <td>{c.name}</td>
                        <td className="muted">{levelText(c.level, c.notEnoughEvidence)}</td>
                        <td>
                          <label className="sr-only" htmlFor={`level-${c.id}`}>Your level for {c.name}</label>
                          <select
                            id={`level-${c.id}`}
                            value={levels[c.id] ?? ''}
                            onChange={(e) => setLevels((prev) => ({ ...prev, [c.id]: e.target.value }))}
                          >
                            <option value="">Agree with the AI</option>
                            {[1, 2, 3, 4, 5].map((level) => <option key={level} value={level}>{level}/5</option>)}
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
            </Fold>
          )}

          {result.summary && (
            <section aria-labelledby="summary-heading">
              <div className="block-h"><h2 id="summary-heading">Summary</h2></div>
              <p>{result.summary}</p>
            </section>
          )}

          <div className="as-folds">
            <SwotFold result={result} />

            {/* Identity & integrity belongs here, with the other reference
                readings. The panel that fills it ships with identity 5b.1 and
                slots in as another <Fold>. */}

            {data.questionsAsked && (
              <Fold title="Questions asked" count={`${data.questionsAsked.length}, in order`}>
                <QuestionsAskedCard questions={data.questionsAsked} />
              </Fold>
            )}

            {scored && (
              <Fold title="Scores and coverage" count={`${formatScoreOutOf100(result.overallScore)} overall`}>
                <dl className="review-facts">
                  <div className="review-fact"><dt>Overall</dt><dd>{formatScoreOutOf100(result.overallScore)}</dd></div>
                  <div className="review-fact"><dt>Confidence</dt><dd>{formatPercent(result.confidence)}</dd></div>
                  <div className="review-fact"><dt>Evidence coverage</dt><dd>{formatPercent(result.evidenceCoverage)}</dd></div>
                </dl>
                <TechStackCoverage coverage={result.techStackCoverage} />
              </Fold>
            )}

            {data.differences && (
              <Fold title="Where the reviewer and the AI differ">
                <DifferencesPanel differences={data.differences} />
              </Fold>
            )}

            {(reviews ?? []).length > 0 && (
              <Fold title="Reviews recorded" count={`${reviews.length}`}>
                <div className="table-scroll" tabIndex={0} role="region" aria-label="Reviews recorded">
                  <table>
                    <thead><tr><th>Verdict</th><th>Why</th><th>Status</th><th>Completed</th></tr></thead>
                    <tbody>
                      {reviews.map((r) => (
                        <tr key={r.id}>
                          <td>{recBadge(r.disposition)}</td>
                          <td className="muted small">{r.reason}</td>
                          <td>{humanise(r.status)}</td>
                          <td className="muted small">{formatDateTime(r.completedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Fold>
            )}

            {id && (
              <Fold title="The candidate's feedback letter">
                <FeedbackEmailPanel key={`email-${id}`} assessmentId={id} />
                {mayReview && <CandidateFeedbackPanel key={id} assessmentId={id} />}
              </Fold>
            )}

            <Fold title="The full report" onOpen={loadReport}>
              {reportLoading && <p className="muted">Loading the full report…</p>}
              {report && <Markdown text={report} />}
            </Fold>
          </div>
        </div>

        {transcriptBlock}
      </div>

    </div>
  );
}
