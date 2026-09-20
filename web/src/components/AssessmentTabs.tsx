import type { KeyboardEvent } from 'react';
import { Badge, Banner, recBadge } from './ui';
import { Icon } from './Icon';
import { formatDateTime } from './dateFormat';
import {
  ASSESSMENT_TABS, assessmentPanelId, assessmentTabId, differenceRows, humanTabState, levelText,
  type AssessmentTabKey, type DifferenceInput, type ReviewSummary,
} from './assessmentTabsModel';

/**
 * The assessment page's three readings: the reviewer's, the AI's, and what
 * they disagreed about. The wording and the ordering live in
 * assessmentTabsModel.ts so they can be tested without a browser.
 */

export function AssessmentTabList({ active, onSelect, onKeyDown }: {
  readonly active: AssessmentTabKey;
  readonly onSelect: (key: AssessmentTabKey) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, key: AssessmentTabKey) => void;
}) {
  return (
    <div className="admin-tabs" role="tablist" aria-label="Assessment readings">
      {ASSESSMENT_TABS.map((tab) => {
        const selected = tab.key === active;
        return (
          <button
            key={tab.key}
            id={assessmentTabId(tab.key)}
            type="button"
            role="tab"
            className="admin-tab"
            aria-selected={selected}
            aria-controls={selected ? assessmentPanelId(tab.key) : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.key)}
            onKeyDown={(event) => onKeyDown(event, tab.key)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export interface ReviewedCompetency {
  readonly id: string;
  readonly name: string;
  readonly level: number | null;
  readonly requiredLevel: number;
  readonly notEnoughEvidence: boolean;
}

/**
 * What the reviewer left: their verdict, their levels, their words. Before
 * anyone has reviewed, it says so plainly rather than showing an empty table —
 * and the form below it is how that changes.
 */
export function HumanReviewPanel({ review, competencies, changedIds, children }: {
  readonly review: ReviewSummary | null;
  readonly competencies: readonly ReviewedCompetency[];
  readonly changedIds: ReadonlySet<string>;
  readonly children?: React.ReactNode;
}) {
  const state = humanTabState(review);

  return (
    <div className="stack">
      {state.kind === 'none' ? (
        <Banner kind="info">{state.message}</Banner>
      ) : (
        <div className="card">
          <h2 className="card-title"><Icon name="human-review" />The reviewer's verdict</h2>
          <p>
            {recBadge(state.review.disposition)}{' '}
            <span className="muted small">
              recorded {state.review.completedAt ? formatDateTime(state.review.completedAt) : 'recently'}
            </span>
          </p>
          <p><strong>Reason.</strong> {state.review.reason}</p>
          {state.review.comments && <p><strong>Comments.</strong> {state.review.comments}</p>}
          <p className="muted small" style={{ marginBottom: 0 }}>
            This is the version the team works from. The AI's own assessment is on the next tab, unchanged.
          </p>
        </div>
      )}

      {state.kind === 'reviewed' && (
        <div className="card">
          <h2 className="card-title"><Icon name="scorecard" />Levels after review</h2>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Levels after review">
            <table>
              <thead><tr><th>Competency</th><th>Level</th><th>Required</th><th /></tr></thead>
              <tbody>
                {competencies.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td><b>{c.notEnoughEvidence && c.level === null ? 'Not graded' : levelText(c.level)}</b></td>
                    <td className="muted">{levelText(c.requiredLevel)}</td>
                    <td>{changedIds.has(c.id) && <Badge kind="blue">Changed by the reviewer</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {children}
    </div>
  );
}

export interface DifferencesView {
  readonly competencies: readonly DifferenceInput[];
  readonly disposition: { readonly ai: string; readonly human: string; readonly agreed: boolean };
  readonly reason: string;
  readonly comments: string;
  readonly summary: string;
  readonly reviewedAt: string | null;
}

const DIRECTION: Readonly<Record<'up' | 'down' | 'same', { label: string; kind: 'green' | 'amber' | 'gray' }>> = {
  up: { label: 'Reviewer graded higher', kind: 'green' },
  down: { label: 'Reviewer graded lower', kind: 'amber' },
  same: { label: 'Agreed', kind: 'gray' },
};

/**
 * Where the human and the machine parted company, kept so the difference can
 * be learned from rather than lost. Nothing here is computed in the browser:
 * the server derives it from the review that was stored.
 */
export function DifferencesPanel({ differences }: { readonly differences: DifferencesView | null }) {
  if (!differences) {
    return (
      <Banner kind="info">
        Nothing to compare yet. Once a reviewer records their verdict, this tab shows every competency they
        graded differently, their reasons, and how often they agreed with the AI.
      </Banner>
    );
  }
  const rows = differenceRows(differences.competencies);

  return (
    <div className="stack">
      <div className="card">
        <h2 className="card-title"><Icon name="about" />How the two readings compare</h2>
        <p style={{ marginBottom: 6 }}>{differences.summary}</p>
        <p style={{ marginBottom: 0 }}>
          <span className="muted small">AI recommendation</span> {recBadge(differences.disposition.ai)}{' '}
          <span className="muted small">reviewer</span> {recBadge(differences.disposition.human)}{' '}
          <Badge kind={differences.disposition.agreed ? 'green' : 'amber'}>
            {differences.disposition.agreed ? 'Same verdict' : 'Different verdict'}
          </Badge>
        </p>
      </div>

      <div className="card">
        <h2 className="card-title"><Icon name="scorecard" />Competency by competency</h2>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Differences by competency">
          <table>
            <thead><tr><th>Competency</th><th>AI</th><th>Reviewer</th><th>Change</th><th>Reviewer's reason</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.competencyId}>
                  <td>{row.competencyName}</td>
                  <td>{row.aiText}</td>
                  <td><b>{row.humanText}</b></td>
                  <td><Badge kind={DIRECTION[row.direction].kind}>{DIRECTION[row.direction].label}</Badge></td>
                  <td className="muted small">{row.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {(differences.reason || differences.comments) && (
        <div className="card">
          <h2 className="card-title"><Icon name="human-review" />What the reviewer said</h2>
          {differences.reason && <p><strong>Reason.</strong> {differences.reason}</p>}
          {differences.comments && <p style={{ marginBottom: 0 }}><strong>Comments.</strong> {differences.comments}</p>}
        </div>
      )}
    </div>
  );
}
