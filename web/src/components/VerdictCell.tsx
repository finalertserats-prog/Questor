import { recBadge } from './ui';
import { StatusBadge } from './StatusBadge';
import { verdictOf, type VerdictSource } from './verdictModel';

/**
 * An interview's verdict in a table cell, with who gave it in brackets. A
 * person's verdict carries no "unvalidated score" caveat: that note is about
 * the AI instrument, not about a reviewer's decision.
 */
export function VerdictCell({ row }: { row: VerdictSource | null | undefined }) {
  const verdict = verdictOf(row);
  if (verdict.source === 'pending') {
    return <span className="muted small" title="The verdicts show once you record your own.">Your review first</span>;
  }
  if (!verdict.value) return recBadge(null);
  return (
    <span className="row" style={{ gap: 6 }} data-verdict-source={verdict.source ?? undefined}>
      {verdict.source === 'human' ? <StatusBadge kind="recommendation" value={verdict.value} /> : recBadge(verdict.value)}
      <span className="muted small">{verdict.marker}</span>
    </span>
  );
}
