import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import { useIsPhone } from './ResponsiveList';
import { isEditable, statusView, type ImportRow, type ImportRowStatus } from './bulkImportModel';

/**
 * The bulk import preview: one row per person, before anything is saved. A
 * table on a desktop, cards on a phone. State is shown as a bracketed word
 * with an icon and, for a row that needs a fix, a rule down its edge — never
 * a tinted fill.
 */

export interface RowEdit {
  readonly fullName?: string;
  readonly email?: string;
  readonly included?: boolean;
}

interface Props {
  readonly rows: readonly ImportRow[];
  readonly busy: boolean;
  readonly onEdit: (rowKey: string, edit: RowEdit) => void;
}

export function StatusMark({ status }: { readonly status: ImportRowStatus }) {
  const view = statusView(status);
  return (
    <span className={`import-mark is-${view.tone}`} data-status={status}>
      <Icon name={view.icon} size={14} />[ {view.label} ]
    </span>
  );
}

/** A name or email field that sends its value when the person leaves it, not on every key. */
function DraftField({ id, label, value, type, disabled, onCommit }: {
  readonly id: string; readonly label: string; readonly value: string; readonly type: 'text' | 'email';
  readonly disabled: boolean; readonly onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft.trim() !== value.trim()) onCommit(draft); };
  return (
    <>
      <label htmlFor={id} className="visually-hidden">{label}</label>
      <input
        id={id}
        type={type}
        className="import-field"
        value={draft}
        disabled={disabled}
        placeholder={type === 'email' ? 'name@example.com' : 'Full name'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
      />
    </>
  );
}

function Include({ row, busy, onEdit }: { readonly row: ImportRow; readonly busy: boolean; readonly onEdit: Props['onEdit'] }) {
  const id = `import-include-${row.rowKey}`;
  return (
    <>
      <input
        id={id}
        type="checkbox"
        checked={row.included && row.status !== 'unreadable'}
        disabled={busy || !isEditable(row)}
        onChange={(e) => onEdit(row.rowKey, { included: e.target.checked })}
      />
      <label htmlFor={id} className="visually-hidden">Include {row.fullName || row.filename || `row ${row.position}`}</label>
    </>
  );
}

/** Where the row came from; a card leaves the line out when there is nothing to say. */
function Source({ row, card = false }: { readonly row: ImportRow; readonly card?: boolean }) {
  const bits = [row.filename, row.phone].filter(Boolean);
  if (card && bits.length === 0) return null;
  return <span className="muted small">{bits.join(' · ') || '—'}</span>;
}

function Note({ row }: { readonly row: ImportRow }) {
  return (
    <div className="import-note small">
      {row.message}
      {row.status === 'existing' && row.existingCandidateId && (
        <> <Link className="link-action" to={`/candidates/${row.existingCandidateId}`}>Open</Link></>
      )}
    </div>
  );
}

const rowClass = (row: ImportRow): string => [
  'import-row',
  statusView(row.status).tone === 'fix' && row.included ? 'needs-fix' : '',
  row.included ? '' : 'left-out',
].filter(Boolean).join(' ');

function PreviewTable({ rows, busy, onEdit }: Props) {
  return (
    <table className="import-table">
      <thead>
        <tr>
          <th scope="col"><span className="visually-hidden">Include</span></th>
          <th scope="col">Name</th>
          <th scope="col">Email</th>
          <th scope="col">From</th>
          <th scope="col">Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const locked = busy || !isEditable(row);
          return (
            <tr key={row.rowKey} className={rowClass(row)} data-testid="import-row">
              <td><Include row={row} busy={busy} onEdit={onEdit} /></td>
              <td><DraftField id={`import-name-${row.rowKey}`} label={`Name, row ${row.position}`} type="text" value={row.fullName} disabled={locked} onCommit={(fullName) => onEdit(row.rowKey, { fullName })} /></td>
              <td><DraftField id={`import-email-${row.rowKey}`} label={`Email, row ${row.position}`} type="email" value={row.email} disabled={locked} onCommit={(email) => onEdit(row.rowKey, { email })} /></td>
              <td><Source row={row} /></td>
              <td><StatusMark status={row.status} /><Note row={row} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function PreviewCards({ rows, busy, onEdit }: Props) {
  return (
    <ul className="import-cards">
      {rows.map((row) => {
        const locked = busy || !isEditable(row);
        return (
          <li key={row.rowKey} className={rowClass(row)} data-testid="import-row">
            <div className="import-card-top">
              <Include row={row} busy={busy} onEdit={onEdit} />
              <StatusMark status={row.status} />
            </div>
            <DraftField id={`import-name-${row.rowKey}`} label={`Name, row ${row.position}`} type="text" value={row.fullName} disabled={locked} onCommit={(fullName) => onEdit(row.rowKey, { fullName })} />
            <DraftField id={`import-email-${row.rowKey}`} label={`Email, row ${row.position}`} type="email" value={row.email} disabled={locked} onCommit={(email) => onEdit(row.rowKey, { email })} />
            <Source row={row} card />
            <Note row={row} />
          </li>
        );
      })}
    </ul>
  );
}

export function ImportPreviewList(props: Props) {
  const isPhone = useIsPhone();
  return isPhone ? <PreviewCards {...props} /> : <PreviewTable {...props} />;
}
