import { useState } from 'react';
import { Badge } from '../ui';
import { humanise } from '../statusModel';
import {
  CATEGORIES,
  CLASSIFICATIONS,
  COMPETENCY_DEFINITION_MAX_LENGTH,
  COMPETENCY_NAME_MAX_LENGTH,
  indicatorsFromText,
  indicatorsToText,
  removalLabel,
  type Category,
  type Classification,
  type EditableCompetency,
} from './competencyEditModel';
import { provenanceOf, type ProvenanceRead } from './competencySourceModel';
import { SuggestedDraft } from '../drafts/SuggestedDraft';
import { useFieldDraft } from '../drafts/useFieldDraft';

function catKind(c: Category): 'blue' | 'gray' {
  return c === 'technical' || c === 'domain' ? 'blue' : 'gray';
}

interface Props {
  readonly competency: EditableCompetency;
  readonly mustPass: boolean;
  readonly hasHistory: boolean;
  readonly locked: boolean;
  readonly onPatch: (patch: Partial<EditableCompetency>) => void;
  readonly onMustPass: (on: boolean) => void;
  readonly onRemove: () => void;
}

/**
 * One competency: the row HR scans, beneath it the line of the advert it was
 * read from, and beneath that (on request) the words the interviewer and the
 * grader will read. A retired competency keeps its row, greyed and unweighted,
 * so the record of what was once assessed stays visible.
 *
 * The source line is not behind the disclosure. A reviewer approving a
 * scorecard is deciding whether each competency belongs on it, and they cannot
 * decide that from a name alone — so the evidence for the claim sits with the
 * claim, the way interview evidence and CV facts do everywhere else.
 */
export function CompetencyRow({ competency: c, mustPass, hasHistory, locked, onPatch, onMustPass, onRemove }: Props) {
  const [open, setOpen] = useState(false);
  // A half-typed weight: "" must never reach the scorecard as 0%.
  const [weightDraft, setWeightDraft] = useState<string | null>(null);
  const [indicatorsDraft, setIndicatorsDraft] = useState<string | null>(null);
  const retired = c.retired === true;
  const removal = removalLabel(hasHistory);
  const disabled = locked || retired;
  const provenance = provenanceOf(c);

  // Competency wording is role content: it describes what the job asks for,
  // not what a candidate did, so a draft here is authoring rather than
  // judgement (components/drafts/fieldDraftVocabulary.ts).
  const definitionDraft = useFieldDraft({
    field: 'competency_definition',
    context: c.name,
    value: c.definition,
    onAccept: (text) => onPatch({ definition: text }),
    entityType: 'Competency',
    entityId: c.id,
  });

  return (
    <>
      <tr className={retired ? 'comp-row comp-row-retired' : 'comp-row'} data-testid={`competency-row-${c.id}`}>
        <td>
          <input
            aria-label={`Name of competency ${c.name}`}
            value={c.name}
            maxLength={COMPETENCY_NAME_MAX_LENGTH}
            disabled={disabled}
            onChange={(e) => onPatch({ name: e.target.value })}
          />
          {retired && <span className="small muted">[ retired ]</span>}
          {provenance.uncertain && (
            <span className="comp-tag" data-testid={`competency-uncertain-${c.id}`}>uncertain</span>
          )}
        </td>
        <td>
          {retired ? <Badge kind={catKind(c.category)}>{humanise(c.category)}</Badge> : (
            <select aria-label={`Category for ${c.name}`} value={c.category} disabled={locked} onChange={(e) => onPatch({ category: e.target.value as Category })}>
              {CATEGORIES.map((k) => <option key={k} value={k}>{humanise(k)}</option>)}
            </select>
          )}
        </td>
        <td>
          <select
            aria-label={`Classification for ${c.name}`}
            value={c.classification}
            disabled={disabled}
            onChange={(e) => { setWeightDraft(null); onPatch({ classification: e.target.value as Classification }); }}
          >
            {CLASSIFICATIONS.map((k) => <option key={k} value={k}>{humanise(k)}</option>)}
          </select>
        </td>
        <td className="comp-weight-cell">
          <div className="row" style={{ gap: 6 }}>
            <input
              type="number" min={0} max={100} step={5}
              aria-label={`Weight for ${c.name}, percent`}
              value={weightDraft ?? String(Math.round(c.weight * 100))}
              disabled={disabled || c.classification === 'non_scoring'}
              onChange={(e) => {
                const raw = e.target.value;
                setWeightDraft(raw);
                if (!raw.trim() || !Number.isFinite(Number(raw))) return;
                onPatch({ weight: Math.max(0, Math.min(100, Number(raw))) / 100 });
              }}
              onBlur={() => setWeightDraft(null)}
              style={{ width: 70 }}
            />
            <span className="muted small">%</span>
          </div>
        </td>
        <td>
          <label className="check-label comp-mustpass">
            <input type="checkbox" aria-label={`Must pass: ${c.name}`} checked={mustPass} disabled={disabled || c.classification === 'non_scoring'} onChange={(e) => onMustPass(e.target.checked)} />
          </label>
        </td>
        <td className="muted">{c.requiredLevel} / {c.targetLevel}</td>
        <td className="comp-actions">
          <button type="button" className="link-button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Details'}
          </button>
          {!retired && (
            <button type="button" className="link-button" disabled={locked} title={removal.explanation} onClick={onRemove} data-testid={`competency-remove-${c.id}`}>
              {removal.label}
            </button>
          )}
        </td>
      </tr>
      <SourceRow competencyId={c.id} name={c.name} provenance={provenance} retired={retired} />
      {open && (
        <tr className="comp-details">
          <td colSpan={7}>
            <div className="comp-details-grid">
              <div>
                <label htmlFor={`comp-def-${c.id}`} className="muted small">Definition — what it means in this role</label>
                <textarea
                  id={`comp-def-${c.id}`}
                  value={c.definition}
                  maxLength={COMPETENCY_DEFINITION_MAX_LENGTH}
                  disabled={disabled}
                  rows={3}
                  aria-describedby={definitionDraft.describedBy}
                  onFocus={definitionDraft.onFocus}
                  onKeyDown={definitionDraft.onKeyDown}
                  onChange={(e) => { definitionDraft.onTyped(); onPatch({ definition: e.target.value }); }}
                />
                {!disabled && <SuggestedDraft draft={definitionDraft} />}
              </div>
              <div>
                <label htmlFor={`comp-ind-${c.id}`} className="muted small">Indicators — one per line, what the interviewer listens for</label>
                <textarea
                  id={`comp-ind-${c.id}`}
                  value={indicatorsDraft ?? indicatorsToText(c.indicators)}
                  disabled={disabled}
                  rows={4}
                  onChange={(e) => { setIndicatorsDraft(e.target.value); onPatch({ indicators: indicatorsFromText(e.target.value) }); }}
                  onBlur={() => setIndicatorsDraft(null)}
                />
              </div>
            </div>
            {retired && <p className="field-hint">{removal.explanation}</p>}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Why this competency is on the scorecard, said in one of three ways and never
 * a fourth: the advert's own words, a stated reason that is not the advert, or
 * the admission that nothing was recorded. A competency with no span is never
 * dressed up as one that has one.
 */
function SourceRow({ competencyId, name, provenance, retired }: {
  readonly competencyId: string;
  readonly name: string;
  readonly provenance: ProvenanceRead;
  readonly retired: boolean;
}) {
  const classes = ['comp-source'];
  if (provenance.uncertain) classes.push('is-uncertain');
  if (retired) classes.push('comp-row-retired');

  return (
    <tr className={classes.join(' ')} data-testid={`competency-source-${competencyId}`}>
      <td colSpan={7}>
        <div className="comp-source-body">
          {provenance.kind === 'span' ? (
            <>
              <q className="comp-quote">{provenance.quote}</q>
              <span className="comp-where">{provenance.citation}</span>
            </>
          ) : (
            <span className="comp-nosource" data-testid={`competency-no-source-${competencyId}`}>{provenance.note}</span>
          )}
          {provenance.uncertain && (
            <span className="comp-where">
              <span className="visually-hidden">{name}: </span>
              Read with low confidence — check it against the advert before approving.
            </span>
          )}
          {provenance.rationale && <p className="comp-why">{provenance.rationale}</p>}
        </div>
      </td>
    </tr>
  );
}
