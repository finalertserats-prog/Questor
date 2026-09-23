import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Banner } from './ui';
import { useToast } from './Toast';
import {
  bandLabel, competencyLabel, deltaLabel, durationLabel, groupAdjustments, headline, intervalLabel,
  proportionLabel, statusLabel, thresholdSentence, tooFewSentence,
  type Adjustment, type AdjustmentGroups, type AnchorProposal, type CalibrationResponse,
  type PatternReportResponse, type ReviewerPattern,
} from './calibrationModel';

/**
 * The Calibration tab.
 *
 * It exists to answer one question without anybody leaving the page: why did a
 * score move? So every applied adjustment carries its evidence beside it —
 * how many reviews, how many reviewers, since when, and the interval — and one
 * button switches it off.
 *
 * The second half is about the people, and is deliberately written to be read
 * with care: these are patterns for a person to look at, never findings, and
 * the page says so where it cannot be missed.
 */

function AdjustmentCard({ adjustment, onRevert, onRestore, busy }: {
  adjustment: Adjustment;
  onRevert: (a: Adjustment) => void;
  onRestore: (a: Adjustment) => void;
  busy: boolean;
}) {
  const applied = adjustment.status === 'active' && adjustment.delta !== 0;
  return (
    <li className="calib-row">
      <div className="calib-row-head">
        <span className="calib-competency">{competencyLabel(adjustment.competencyKey)}</span>
        <span className="small muted">{bandLabel(adjustment.band)}</span>
        <span className={`calib-state calib-state-${applied ? 'applied' : adjustment.status}`}>
          {statusLabel(adjustment)}
        </span>
      </div>

      <p className="calib-numbers">
        <span className="calib-delta" data-testid={`calib-delta-${adjustment.competencyId}`}>
          {deltaLabel(adjustment.delta)}
        </span>
        <span className="small muted">
          measured {deltaLabel(adjustment.measuredMedian)}, interval {intervalLabel(adjustment)}
        </span>
      </p>

      {/* The provenance. Never shown without the number it explains. */}
      <p className="small">{adjustment.statement}</p>

      {adjustment.themes.length > 0 && (
        <div className="small">
          <span className="muted">What reviewers wrote about, grouped: </span>
          {adjustment.themes.map((theme) => theme.label).join('; ')}.
        </div>
      )}

      {adjustment.revertedAt && (
        <p className="small muted">Switched off by a person: {adjustment.revertReason}</p>
      )}

      <div className="calib-actions">
        {applied && (
          <button
            className="btn sm"
            disabled={busy}
            onClick={() => onRevert(adjustment)}
            data-testid={`calib-revert-${adjustment.competencyId}`}
          >
            Switch this off
          </button>
        )}
        {adjustment.status === 'reverted' && (
          <button className="btn sm ghost" disabled={busy} onClick={() => onRestore(adjustment)}>
            Let it be reconsidered
          </button>
        )}
      </div>
    </li>
  );
}

function ProposalCard({ proposal, onDecide, busy }: {
  proposal: AnchorProposal;
  onDecide: (p: AnchorProposal, decision: 'applied' | 'declined') => void;
  busy: boolean;
}) {
  return (
    <li className="calib-row">
      <div className="calib-row-head">
        <span className="calib-competency">{competencyLabel(proposal.competencyKey)}</span>
        <span className="small muted">{bandLabel(proposal.band)}</span>
      </div>
      <p className="small">
        {proposal.reviewers} reviewers, over {proposal.observations} reviews, kept coming back to what a
        strong answer contains. Suggested additions to this competency&rsquo;s anchors:
      </p>
      <ul className="calib-anchors">
        {proposal.anchors.map((anchor) => <li key={anchor}>{anchor}</li>)}
      </ul>
      <p className="small muted">
        Nothing here changes the rubric. To use it, edit the role&rsquo;s scorecard — which creates a draft
        version for your approver, the same as any other rubric change.
      </p>
      {proposal.status === 'proposed' && (
        <div className="calib-actions">
          <button className="btn sm" disabled={busy} onClick={() => onDecide(proposal, 'applied')}>
            I have put this in the scorecard
          </button>
          <button className="btn sm ghost" disabled={busy} onClick={() => onDecide(proposal, 'declined')}>
            Not this one
          </button>
        </div>
      )}
      {proposal.status !== 'proposed' && <p className="small muted">Decided: {proposal.status}.</p>}
    </li>
  );
}

function ReviewerCard({ reviewer, baselineDivergence }: {
  reviewer: ReviewerPattern;
  baselineDivergence: number | null;
}) {
  const s = reviewer.statistics;
  return (
    <li className="calib-row">
      <div className="calib-row-head">
        <span className="calib-competency">{reviewer.name}</span>
        <span className="small muted">{s.reviews} reviews</span>
        {reviewer.heldOutOfCalibration && (
          <span className="calib-state calib-state-held">Not feeding calibration while this is open</span>
        )}
      </div>

      {s.tooFewToSay ? (
        <p className="small muted" data-testid={`pattern-tooFew-${reviewer.reviewerId}`}>{tooFewSentence(s)}</p>
      ) : (
        <>
          <dl className="calib-stats">
            <div>
              <dt className="small muted">Different verdict from the model</dt>
              <dd>{proportionLabel(s.divergenceFromAi)}</dd>
            </div>
            <div>
              <dt className="small muted">Across the organisation</dt>
              <dd>{baselineDivergence === null ? 'Not known' : `${Math.round(baselineDivergence * 100)}%`}</dd>
            </div>
            <div>
              <dt className="small muted">Level changes that move down</dt>
              <dd>{proportionLabel(s.downwardShare)}</dd>
            </div>
            <div>
              <dt className="small muted">Level changes that record why</dt>
              <dd>{proportionLabel(s.reasonGiven)}</dd>
            </div>
            <div>
              <dt className="small muted">Typical time before recording</dt>
              <dd>{durationLabel(s.medianSecondsToRecord)}</dd>
            </div>
            <div>
              <dt className="small muted">Distance from colleagues</dt>
              <dd>{s.peerGap ? `${s.peerGap.meanAbsGap.toFixed(2)} of a level` : 'Not known'}</dd>
            </div>
          </dl>

          {reviewer.alerts.map((alert) => (
            <p key={alert.kind} className="calib-alert" data-testid={`pattern-alert-${alert.kind}`}>
              {alert.statement}
            </p>
          ))}
        </>
      )}
    </li>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="calib-section">
      <h4>{title} <span className="small muted">({count})</span></h4>
      {children}
    </section>
  );
}

export function CalibrationPanel() {
  const [data, setData] = useState<CalibrationResponse | null>(null);
  const [patterns, setPatterns] = useState<PatternReportResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    const [calibration, report] = await Promise.all([
      api.get<CalibrationResponse>('/admin/calibration'),
      api.get<PatternReportResponse>('/admin/calibration/reviewers'),
    ]);
    setData(calibration);
    setPatterns(report);
  }, []);

  useEffect(() => {
    let cancelled = false;
    load().catch((err: unknown) => {
      if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Calibration could not be loaded.');
    });
    return () => { cancelled = true; };
  }, [load]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError('');
    try {
      await fn();
      await load();
      toast.show(label);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  const revert = (adjustment: Adjustment) => {
    // A reason is required by the server, and it is the thing an auditor reads
    // later, so it is asked for rather than invented.
    const reason = window.prompt('Why are you switching this off? This goes on the audit trail.');
    if (!reason || reason.trim().length < 10) {
      setActionError('Give a reason of at least ten characters, so the record says why.');
      return;
    }
    void run('Switched off. It applies to nothing from now on.', () =>
      api.post(`/admin/calibration/${adjustment.id}/revert`, { reason: reason.trim() }));
  };

  const restore = (adjustment: Adjustment) =>
    void run('It will be reconsidered against every threshold before it applies again.', () =>
      api.post(`/admin/calibration/${adjustment.id}/restore`, {}));

  const decide = (proposal: AnchorProposal, decision: 'applied' | 'declined') =>
    void run(decision === 'applied' ? 'Recorded.' : 'Set aside.', () =>
      api.post(`/admin/calibration/anchors/${proposal.id}`, { decision, reason: '' }));

  if (loadError) return <Banner kind="error">{loadError}</Banner>;
  if (!data) return <div className="card muted">Loading…</div>;

  const groups: AdjustmentGroups = groupAdjustments(data.adjustments);

  return (
    <div className="calib">
      <div className="card">
        <h3>What your reviewers have taught the model</h3>
        <p>{headline(data.settings, groups)}</p>
        <p className="small muted">{thresholdSentence(data.settings)}</p>
        <p className="small muted">
          Every adjustment applies only to interviews assessed after it started. Nothing already assessed is
          ever changed, and the model&rsquo;s own level is kept on every assessment beside the adjusted one.
        </p>
        {actionError && <Banner kind="error">{actionError}</Banner>}
      </div>

      <Section title="Being applied" count={groups.applied.length}>
        {groups.applied.length === 0
          ? <p className="small muted">Nothing is being adjusted. That is the normal state until a role has enough reviews behind it.</p>
          : <ul className="calib-list">{groups.applied.map((a) => (
              <AdjustmentCard key={a.id} adjustment={a} onRevert={revert} onRestore={restore} busy={busy} />
            ))}</ul>}
      </Section>

      {groups.reverted.length > 0 && (
        <Section title="Switched off by a person" count={groups.reverted.length}>
          <ul className="calib-list">{groups.reverted.map((a) => (
            <AdjustmentCard key={a.id} adjustment={a} onRevert={revert} onRestore={restore} busy={busy} />
          ))}</ul>
        </Section>
      )}

      <Section title="Being watched, not applied" count={groups.watching.length}>
        {groups.watching.length === 0
          ? <p className="small muted">Nothing is being watched yet. Competencies appear here once reviewers start disagreeing with the model about them.</p>
          : <ul className="calib-list">{groups.watching.map((a) => (
              <AdjustmentCard key={a.id} adjustment={a} onRevert={revert} onRestore={restore} busy={busy} />
            ))}</ul>}
      </Section>

      {data.proposals.length > 0 && (
        <Section title="Suggested rubric changes" count={data.proposals.length}>
          <ul className="calib-list">{data.proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} onDecide={decide} busy={busy} />
          ))}</ul>
        </Section>
      )}

      <section className="calib-section">
        <h4>How your reviewers review</h4>
        {/* Said before any number is shown, because it governs how they should be read. */}
        <Banner kind="info">{patterns?.notice ?? ''}</Banner>
        {!patterns || patterns.reviewers.length === 0
          ? <p className="small muted">No completed reviews in this period.</p>
          : (
            <ul className="calib-list">
              {patterns.reviewers.map((reviewer) => (
                <ReviewerCard
                  key={reviewer.reviewerId}
                  reviewer={reviewer}
                  baselineDivergence={patterns.baseline.divergenceFromAi}
                />
              ))}
            </ul>
          )}
      </section>
    </div>
  );
}
