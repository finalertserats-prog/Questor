import { useState } from 'react';
import {
  CATEGORY_LABEL, LEVEL_LABEL, TECH_CATEGORIES, TECH_LEVELS, TECH_NAME_MAX_LENGTH,
  addTechnology, removeTechnology, suggestionsFor, techNameProblem, updateTechnology,
  type KnownTechnology, type TechCategory, type TechLevel, type TechStackItem,
} from './techStackModel';

interface Props {
  readonly idPrefix: string;
  readonly value: readonly TechStackItem[];
  readonly onChange: (next: TechStackItem[]) => void;
  /** Known technologies for spelling and category suggestions; optional. */
  readonly catalog?: readonly KnownTechnology[];
  readonly disabled?: boolean;
}

/**
 * The technologies a role is hired around, one row each: name, category, how
 * deep the hire needs to be, and whether the role can be done without it.
 * Type a name and press Enter; a known name takes the catalog's spelling.
 */
export function TechStackEditor({ idPrefix, value, onChange, catalog = [], disabled = false }: Props) {
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState('');
  const listId = `${idPrefix}-tech-options`;

  const add = () => {
    const why = techNameProblem(value, draft);
    if (why) { setProblem(why); return; }
    onChange(addTechnology(value, draft, catalog));
    setDraft('');
    setProblem('');
  };

  return (
    <div className="stack-editor" data-testid="tech-stack-editor">
      <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <input
            id={`${idPrefix}-tech`}
            value={draft}
            maxLength={TECH_NAME_MAX_LENGTH}
            list={listId}
            disabled={disabled}
            placeholder="e.g. PostgreSQL — type and press Enter"
            aria-describedby={problem ? `${idPrefix}-tech-problem` : undefined}
            aria-invalid={problem ? true : undefined}
            onChange={(e) => { setDraft(e.target.value); if (problem) setProblem(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
            data-testid="tech-stack-input"
          />
          <datalist id={listId}>
            {suggestionsFor(value, draft, catalog).map((name) => <option key={name} value={name} />)}
          </datalist>
          {problem && <p id={`${idPrefix}-tech-problem`} className="field-hint field-problem">{problem}</p>}
        </div>
        <button type="button" className="btn secondary" onClick={add} disabled={disabled} data-testid="tech-stack-add">Add technology</button>
      </div>
      {value.length > 0 && (
        <ul className="stack-list" aria-label="Tech stack">
          {value.map((t) => (
            <li key={t.name} className="stack-item" data-testid="tech-stack-item">
              <span className="stack-name">{t.name}</span>
              <select
                aria-label={`Category of ${t.name}`}
                value={t.category}
                disabled={disabled}
                onChange={(e) => onChange(updateTechnology(value, t.name, { category: e.target.value as TechCategory }))}
              >
                {TECH_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
              </select>
              <select
                aria-label={`Level of ${t.name}`}
                value={t.level}
                disabled={disabled}
                onChange={(e) => onChange(updateTechnology(value, t.name, { level: e.target.value as TechLevel }))}
              >
                {TECH_LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}
              </select>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={t.required}
                  disabled={disabled}
                  onChange={(e) => onChange(updateTechnology(value, t.name, { required: e.target.checked }))}
                /> Required
              </label>
              <button type="button" className="link-button" disabled={disabled} aria-label={`Remove ${t.name}`} onClick={() => onChange(removeTechnology(value, t.name))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
