import { useState } from 'react';
import { api } from '../../api/client';
import { Banner } from '../ui';
import { Icon } from '../Icon';
import { weightsProblem, weightsTotal } from '../scorecardModel';
import { AddCompetencyPanel } from './AddCompetencyPanel';
import { CompetencyRow } from './CompetencyRow';
import { applyCompetencyPatch, mustPassAfterPatch, removalLabel, toggleMustPass, type EditableCompetency } from './competencyEditModel';

interface Props {
  readonly roleId: string;
  readonly competencies: readonly EditableCompetency[];
  readonly mustPassIds: readonly string[];
  /** Ids an interview has already used; these retire rather than delete. */
  readonly historyIds: readonly string[];
  /** What the planner and the feedback letter will leave out, from the last save. */
  readonly warnings: readonly string[];
  /** Edits on screen not yet saved: add and remove wait for them, so nothing is lost. */
  readonly dirty: boolean;
  readonly locked: boolean;
  readonly onChange: (next: { competencies: EditableCompetency[]; mustPassIds: string[] }) => void;
  /** An add or remove was stored server-side; the page reloads the scorecard. */
  readonly onStored: (notice: string) => void;
}

/**
 * The competencies card. Row edits (name, category, definition, indicators,
 * classification, weight, must-pass) stay on the page until "Save changes",
 * like the threshold and red flags beside them. Adding and removing go to the
 * server at once: they need the AI draft, the library and the history check,
 * and each is its own audited step.
 */
export function CompetencyEditor({ roleId, competencies, mustPassIds, historyIds, warnings, dirty, locked, onChange, onStored }: Props) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const total = weightsTotal(competencies);
  const weightsError = weightsProblem(competencies);
  const history = new Set(historyIds);
  const structural = locked || dirty;
  const structuralHint = locked ? undefined : dirty ? 'Save your changes first — adding or removing reloads the scorecard.' : undefined;

  const patch = (id: string, change: Partial<EditableCompetency>) => {
    onChange({ competencies: applyCompetencyPatch(competencies, id, change), mustPassIds: mustPassAfterPatch(mustPassIds, id, change) });
  };
  const mustPass = (id: string, on: boolean) => {
    onChange({ competencies: [...competencies], mustPassIds: toggleMustPass(mustPassIds, id, on) });
  };

  const remove = async (id: string) => {
    if (removing) return;
    setRemoving(id);
    setError('');
    try {
      const res = await api.del<{ retired: boolean }>(`/roles/${roleId}/scorecard/competencies/${id}`);
      const name = competencies.find((c) => c.id === id)?.name ?? 'The competency';
      onStored(res.retired
        ? `${name} retired: interviews have used it, so it stays on record but is no longer asked or scored.`
        : `${name} removed from the scorecard.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not remove the competency.');
    } finally {
      setRemoving(null);
      setConfirmId(null);
    }
  };

  const confirming = confirmId ? competencies.find((c) => c.id === confirmId) : undefined;

  return (
    <div className="card" data-tour="role-competencies">
      <div className="row spread">
        <h2 className="card-title"><Icon name="skills-assessment" size={16} />Competencies</h2>
        {!adding && (
          <button type="button" className="btn secondary sm" onClick={() => setAdding(true)} disabled={structural} title={structuralHint} data-testid="add-competency">
            <Icon name="plus" size={14} />Add competency
          </button>
        )}
      </div>
      <p className="muted small">
        Anyone on the role can add, edit or retire competencies. Approval of the scorecard is a separate step.
      </p>
      {adding && (
        <AddCompetencyPanel
          roleId={roleId}
          competencies={competencies}
          onAdded={(name) => { setAdding(false); onStored(`${name} added to the scorecard.`); }}
          onCancel={() => setAdding(false)}
        />
      )}
      {error && <Banner kind="error">{error}</Banner>}
      {confirming && (
        <div className="comp-confirm" role="alertdialog" aria-label={`${removalLabel(history.has(confirming.id)).label} ${confirming.name}`} data-testid="competency-confirm">
          <p>
            <strong>{removalLabel(history.has(confirming.id)).label} {confirming.name}?</strong>{' '}
            {removalLabel(history.has(confirming.id)).explanation} Its weight goes to the other competencies in proportion.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn danger sm" onClick={() => void remove(confirming.id)} disabled={removing !== null} data-testid="competency-confirm-yes">
              {removing ? 'Working…' : `Yes, ${removalLabel(history.has(confirming.id)).label.toLowerCase()}`}
            </button>
            <button type="button" className="btn ghost sm" onClick={() => setConfirmId(null)}>Keep it</button>
          </div>
        </div>
      )}
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Competencies">
        <table className="comp-table">
          <thead>
            <tr>
              <th>Name</th><th>Category</th><th>Classification</th><th>Weight</th><th>Must pass</th><th>Req/Target</th><th><span className="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {competencies.map((c) => (
              <CompetencyRow
                key={c.id}
                competency={c}
                mustPass={mustPassIds.includes(c.id)}
                hasHistory={history.has(c.id)}
                locked={locked}
                onPatch={(change) => patch(c.id, change)}
                onMustPass={(on) => mustPass(c.id, on)}
                onRemove={() => { if (!structural) setConfirmId(c.id); else setError(structuralHint ?? ''); }}
              />
            ))}
          </tbody>
        </table>
      </div>
      {/* The total the server checks, shown where the weights are edited —
          otherwise the first anyone hears of it is a refused save. */}
      <div className="row spread" style={{ marginTop: 8 }}>
        <span className="small" data-testid="weights-total">Scored weights total {total}%</span>
        {weightsError && <span className="small">[ must total 100% ]</span>}
      </div>
      {weightsError && <Banner kind="error">{weightsError}</Banner>}
      {warnings.length > 0 && (
        <ul className="comp-warnings" aria-label="Scorecard warnings" data-testid="scorecard-warnings">
          {warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
    </div>
  );
}
