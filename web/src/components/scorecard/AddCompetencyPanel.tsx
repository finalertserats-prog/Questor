import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Banner } from '../ui';
import { Icon } from '../Icon';
import { humanise } from '../statusModel';
import {
  CATEGORIES,
  CLASSIFICATIONS,
  COMPETENCY_DEFINITION_MAX_LENGTH,
  COMPETENCY_NAME_MAX_LENGTH,
  EMPTY_ADD_FORM,
  addPayload,
  applyDraft,
  competencyNameProblem,
  type AddForm,
  type Category,
  type Classification,
  type CompetencyDraft,
} from './competencyEditModel';

interface LibraryEntry { id: string; name: string; category: string; definition: string; indicators: string[] }

export interface AddedScorecard { scorecard: { profile: unknown }; warnings: string[] }

interface Props {
  readonly roleId: string;
  readonly competencies: readonly { readonly id: string; readonly name: string; readonly retired?: boolean }[];
  readonly onAdded: (name: string) => void;
  readonly onCancel: () => void;
}

/**
 * Type a name, let the AI draft what it means for this role from the JD,
 * correct it, save. Or pick something the organisation has defined before.
 * Nothing is stored until Save: the draft is a suggestion on screen only.
 */
export function AddCompetencyPanel({ roleId, competencies, onAdded, onCancel }: Props) {
  const [form, setForm] = useState<AddForm>(EMPTY_ADD_FORM);
  const [drafting, setDrafting] = useState(false);
  const [draftSource, setDraftSource] = useState<'model' | 'heuristic' | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [libraryId, setLibraryId] = useState('');

  useEffect(() => {
    let live = true;
    api.get<{ competencies: LibraryEntry[] }>(`/roles/${roleId}/scorecard/competencies/library`)
      .then((d) => { if (live) setLibrary(d.competencies); })
      // The library is a convenience; without it the form still works.
      .catch(() => undefined);
    return () => { live = false; };
  }, [roleId]);

  const nameProblem = competencyNameProblem(competencies, form.name);
  const set = (patch: Partial<AddForm>) => { setForm((f) => ({ ...f, ...patch })); if (problem) setProblem(''); };

  const draft = async () => {
    if (nameProblem) { setProblem(nameProblem); return; }
    setDrafting(true);
    setProblem('');
    try {
      const res = await api.post<{ draft: CompetencyDraft; source: 'model' | 'heuristic' }>(`/roles/${roleId}/scorecard/competencies/draft`, { name: form.name.trim() });
      setForm((f) => applyDraft(f, res.draft));
      setDraftSource(res.source);
    } catch (err: unknown) {
      setProblem(err instanceof Error ? err.message : 'Could not draft the competency.');
    } finally {
      setDrafting(false);
    }
  };

  const save = async () => {
    if (saving) return;
    const fromLibrary = libraryId ? library.find((e) => e.id === libraryId) : undefined;
    if (!fromLibrary && nameProblem) { setProblem(nameProblem); return; }
    setSaving(true);
    setProblem('');
    try {
      const body = fromLibrary
        ? { libraryId: fromLibrary.id, classification: form.classification, mustPass: form.mustPass }
        : addPayload(form);
      await api.post<AddedScorecard>(`/roles/${roleId}/scorecard/competencies`, body);
      onAdded(fromLibrary ? fromLibrary.name : addPayload(form).name);
    } catch (err: unknown) {
      setProblem(err instanceof Error ? err.message : 'Could not add the competency.');
    } finally {
      setSaving(false);
    }
  };

  const pickLibrary = (id: string) => {
    setLibraryId(id);
    const entry = library.find((e) => e.id === id);
    if (!entry) return;
    const category = (CATEGORIES as readonly string[]).includes(entry.category) ? (entry.category as Category) : 'domain';
    setForm((f) => ({ ...f, name: entry.name, definition: entry.definition, category, indicatorsText: entry.indicators.join('\n') }));
    setDraftSource(null);
  };

  return (
    <form className="comp-add" data-testid="add-competency-panel" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="comp-add-head">
        <strong>Add a competency</strong>
        <button type="button" className="link-button" onClick={onCancel}>Cancel</button>
      </div>
      {library.length > 0 && (
        <div className="comp-add-field">
          <label htmlFor="comp-library" className="muted small">From your organisation's library</label>
          <select id="comp-library" value={libraryId} onChange={(e) => pickLibrary(e.target.value)} data-testid="add-competency-library">
            <option value="">— define a new one —</option>
            {library.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
      )}
      <div className="comp-add-field">
        <label htmlFor="comp-add-name" className="muted small">Name</label>
        <div className="row" style={{ gap: 8, alignItems: 'stretch' }}>
          <input
            id="comp-add-name"
            value={form.name}
            maxLength={COMPETENCY_NAME_MAX_LENGTH}
            disabled={Boolean(libraryId)}
            placeholder="e.g. Vendor management"
            onChange={(e) => set({ name: e.target.value })}
            data-testid="add-competency-name"
          />
          <button type="button" className="btn secondary" onClick={() => void draft()} disabled={drafting || Boolean(libraryId)} data-testid="add-competency-draft">
            <Icon name={drafting ? 'hourglass' : 'sparkle'} size={16} />
            {drafting ? 'Drafting…' : 'Draft with AI'}
          </button>
        </div>
        <p className="field-hint">The AI reads the job description and drafts the definition and indicators below. You confirm or edit before saving.</p>
      </div>
      <div className="comp-add-field">
        <label htmlFor="comp-add-def" className="muted small">Definition — what it means in this role</label>
        <textarea id="comp-add-def" rows={3} value={form.definition} maxLength={COMPETENCY_DEFINITION_MAX_LENGTH} onChange={(e) => set({ definition: e.target.value })} data-testid="add-competency-definition" />
      </div>
      <div className="comp-add-field">
        <label htmlFor="comp-add-ind" className="muted small">Indicators — one per line</label>
        <textarea id="comp-add-ind" rows={4} value={form.indicatorsText} onChange={(e) => set({ indicatorsText: e.target.value })} data-testid="add-competency-indicators" />
      </div>
      <div className="row" style={{ gap: 14 }}>
        <div>
          <label htmlFor="comp-add-cat" className="muted small">Category</label>
          <select id="comp-add-cat" value={form.category} onChange={(e) => set({ category: e.target.value as Category })}>
            {CATEGORIES.map((k) => <option key={k} value={k}>{humanise(k)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="comp-add-class" className="muted small">Classification</label>
          <select id="comp-add-class" value={form.classification} onChange={(e) => set({ classification: e.target.value as Classification })}>
            {CLASSIFICATIONS.map((k) => <option key={k} value={k}>{humanise(k)}</option>)}
          </select>
        </div>
        <label className="check-label" style={{ marginTop: 18 }} title={form.classification === 'non_scoring' ? 'A non-scoring competency is not assessed, so it cannot be must-pass.' : undefined}>
          <input
            type="checkbox"
            checked={form.classification !== 'non_scoring' && form.mustPass}
            disabled={form.classification === 'non_scoring'}
            onChange={(e) => set({ mustPass: e.target.checked })}
          /> Must pass
        </label>
      </div>
      {draftSource && (
        <p className="muted small">
          {draftSource === 'model' ? 'Drafted by the AI from the job description.' : 'Drafted from the job description without a model; edit as needed.'}
        </p>
      )}
      {problem && <Banner kind="error">{problem}</Banner>}
      <div className="row" style={{ gap: 8 }}>
        <button type="submit" className="btn" disabled={saving} data-testid="add-competency-save">
          <Icon name={saving ? 'hourglass' : 'plus'} size={16} />
          {saving ? 'Adding…' : 'Add to scorecard'}
        </button>
        <span className="muted small">A new scored competency takes an equal share; the other weights scale to fit.</span>
      </div>
    </form>
  );
}
