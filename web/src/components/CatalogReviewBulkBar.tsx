type BulkAction = 'approve' | 'reject';

interface Props {
  readonly count: number;
  readonly confirming: BulkAction | null;
  readonly busy: boolean;
  readonly onAsk: (action: BulkAction | null) => void;
  readonly onConfirm: (action: BulkAction) => void;
  readonly onClear: () => void;
}

/**
 * Shown while proposals are selected. Every bulk action asks once more before
 * it runs: an approval adds titles to the catalog every organisation shares.
 */
export function BulkBar({ count, confirming, busy, onAsk, onConfirm, onClear }: Props) {
  return (
    <div className="catalog-bulk-bar" role="group" aria-label="Bulk actions">
      <strong>{count} selected</strong>
      {confirming ? (
        <>
          <span>{confirming === 'approve' ? `Approve ${count} and add them to the shared catalog for every organisation?` : `Reject ${count}?`}</span>
          <button type="button" className="btn sm" disabled={busy} onClick={() => onConfirm(confirming)}>
            {busy ? 'Working…' : confirming === 'approve' ? 'Confirm approve' : 'Confirm reject'}
          </button>
          <button type="button" className="btn sm ghost" disabled={busy} onClick={() => onAsk(null)}>Cancel</button>
        </>
      ) : (
        <>
          <button type="button" className="btn sm" onClick={() => onAsk('approve')}>Approve selected</button>
          <button type="button" className="btn sm secondary" onClick={() => onAsk('reject')}>Reject selected</button>
          <button type="button" className="btn sm ghost" onClick={onClear}>Clear selection</button>
        </>
      )}
    </div>
  );
}
