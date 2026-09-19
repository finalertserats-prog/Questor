import { useId, useState } from 'react';
import { StatusBadge } from './StatusBadge';
import {
  confidenceLabel, confidencePercent, draftFrom, editPatch, familiesFor, kindLabel, placementLabel, sourceLinks, SUMMARY_MAX, validateEdit,
  type CatalogProposalView, type EditDraft, type EditOptions,
} from './catalogReviewModel';

interface RowProps {
  readonly proposal: CatalogProposalView;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly editing: boolean;
  readonly options: EditOptions;
  readonly onToggle: () => void;
  readonly onApprove: () => void;
  readonly onReject: () => void;
  readonly onEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onSave: (patch: Record<string, string | null>) => Promise<boolean>;
}

const COLUMN_COUNT = 7;

function Sources({ proposal }: { readonly proposal: CatalogProposalView }) {
  const links = sourceLinks(proposal.sources);
  if (links.length === 0) return <span className="muted small">None recorded</span>;
  return (
    <span className="catalog-review-sources small">
      {links.map((link) => (link.href
        ? <a key={link.key} href={link.href} target="_blank" rel="noopener noreferrer">{link.text}<span className="visually-hidden"> (opens in a new tab)</span></a>
        : <span key={link.key}>{link.text}</span>))}
    </span>
  );
}

/** One proposal: what it is, where it came from, and the owner's three actions. */
export function CatalogProposalRow(props: RowProps) {
  const { proposal, selected, busy, editing } = props;
  const pending = proposal.status === 'pending';
  return (
    <>
      <tr className={selected ? 'is-selected' : undefined} data-testid="catalog-proposal-row" aria-busy={busy || undefined}>
        <td className="col-select">
          {pending && <input type="checkbox" checked={selected} onChange={props.onToggle} aria-label={`Select ${proposal.title}`} />}
        </td>
        <td>
          <div className="catalog-review-title">{proposal.title}</div>
          {proposal.summary && <div className="muted small catalog-review-summary">{proposal.summary}</div>}
          {!pending && <div style={{ marginTop: 4 }}><StatusBadge kind="proposal" value={proposal.status} /></div>}
          {proposal.reviewerNote && <div className="muted small">Note: {proposal.reviewerNote}</div>}
        </td>
        <td><span className={proposal.kind === 'new_role' ? 'badge blue' : 'badge gray'}>{kindLabel(proposal.kind)}</span></td>
        <td className="small">{placementLabel(proposal)}</td>
        <td className="small">{confidenceLabel(proposal.confidence)} <span className="muted">({confidencePercent(proposal.confidence)})</span></td>
        <td><Sources proposal={proposal} /></td>
        <td>
          {pending && !editing && (
            <span className="catalog-review-actions">
              <button type="button" className="btn sm" disabled={busy} onClick={props.onApprove} aria-label={`Approve ${proposal.title}`}>Approve</button>
              <button type="button" className="btn sm secondary" disabled={busy} onClick={props.onReject} aria-label={`Reject ${proposal.title}`}>Reject</button>
              <button type="button" className="btn sm ghost" disabled={busy} onClick={props.onEdit} aria-label={`Edit ${proposal.title}`}>Edit</button>
            </span>
          )}
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={COLUMN_COUNT}>
            <ProposalEditor proposal={proposal} options={props.options} busy={busy} onCancel={props.onCancelEdit} onSave={props.onSave} />
          </td>
        </tr>
      )}
    </>
  );
}

interface EditorProps {
  readonly proposal: CatalogProposalView;
  readonly options: EditOptions;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSave: (patch: Record<string, string | null>) => Promise<boolean>;
}

function FieldProblem({ id, text }: { readonly id: string; readonly text?: string }) {
  return text ? <p id={id} className="field-hint field-problem">{text}</p> : null;
}

/** Inline edit, checked with the server's own rules before anything is sent. */
function ProposalEditor({ proposal, options, busy, onCancel, onSave }: EditorProps) {
  const id = useId();
  const [draft, setDraft] = useState<EditDraft>(() => draftFrom(proposal));
  const [showProblems, setShowProblems] = useState(false);
  const problems = validateEdit(draft, proposal.kind, options);
  const shown = showProblems ? problems : {};
  const isRole = proposal.kind === 'new_role';
  const families = familiesFor(options, draft.domainId);
  const change = (next: Partial<EditDraft>) => setDraft((current) => ({ ...current, ...next }));

  const save = async () => {
    setShowProblems(true);
    if (Object.keys(problems).length > 0) return;
    const patch = editPatch(proposal, draft);
    if (Object.keys(patch).length === 0) { onCancel(); return; }
    await onSave(patch);
  };

  const describedBy = (field: keyof EditDraft) => (shown[field] ? `${id}-${field}-problem` : undefined);

  return (
    <form className="catalog-review-editor" aria-label={`Edit ${proposal.title}`} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="field-grid">
        <div>
          <label htmlFor={`${id}-title`}>Title</label>
          <input id={`${id}-title`} value={draft.title} maxLength={120} autoFocus aria-invalid={shown.title ? true : undefined} aria-describedby={describedBy('title')} onChange={(e) => change({ title: e.target.value })} />
          <FieldProblem id={`${id}-title-problem`} text={shown.title} />
        </div>
        {isRole && (
          <div>
            <label htmlFor={`${id}-domain`}>Domain</label>
            <select id={`${id}-domain`} value={draft.domainId} aria-invalid={shown.domainId ? true : undefined} aria-describedby={describedBy('domainId')}
              onChange={(e) => change({ domainId: e.target.value, familyId: familiesFor(options, e.target.value).some((f) => f.id === draft.familyId) ? draft.familyId : '' })}>
              <option value="">Choose a domain…</option>
              {options.domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <FieldProblem id={`${id}-domainId-problem`} text={shown.domainId} />
          </div>
        )}
        {isRole && (
          <div>
            <label htmlFor={`${id}-family`}>Job family</label>
            <select id={`${id}-family`} value={draft.familyId} disabled={!draft.domainId} aria-invalid={shown.familyId ? true : undefined} aria-describedby={describedBy('familyId')} onChange={(e) => change({ familyId: e.target.value })}>
              <option value="">No family</option>
              {families.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <FieldProblem id={`${id}-familyId-problem`} text={shown.familyId} />
          </div>
        )}
      </div>
      {isRole && (
        <div>
          <label htmlFor={`${id}-summary`}>Summary shown to candidates</label>
          <textarea id={`${id}-summary`} value={draft.summary} maxLength={SUMMARY_MAX + 50} aria-invalid={shown.summary ? true : undefined} aria-describedby={describedBy('summary')} onChange={(e) => change({ summary: e.target.value })} />
          <FieldProblem id={`${id}-summary-problem`} text={shown.summary} />
        </div>
      )}
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button type="submit" className="btn sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn sm ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
