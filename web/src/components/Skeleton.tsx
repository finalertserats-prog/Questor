/**
 * Placeholder shapes shown while a page loads, so the layout does not jump
 * when the data arrives. Announced once as a status; the shapes are hidden.
 */
export function Skeleton({ lines = 3, label = 'Loading…' }: { lines?: number; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton-line" aria-hidden="true" />
      ))}
    </div>
  );
}

/** A page-shaped skeleton: a header bar, then cards of lines. */
export function PageSkeleton({ label = 'Loading…', cards = 2 }: { label?: string; cards?: number }) {
  return (
    <div className="page-skeleton" role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      <div className="skeleton-header" aria-hidden="true">
        <span className="skeleton-block skeleton-avatar" />
        <span className="skeleton-block skeleton-heading" />
      </div>
      {Array.from({ length: cards }, (_, c) => (
        <div key={c} className="card" aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => <span key={i} className="skeleton-line" />)}
        </div>
      ))}
    </div>
  );
}

/**
 * A page waiting on the one call that decides what it says.
 *
 * The token pages a candidate or an operator reaches from an email — the
 * consent answers, the decision links, "talk to a person" — showed eleven
 * characters while they fetched: a kind sentence and nothing else. No busy
 * state, so a screen reader was told nothing; no shapes, so on a slow
 * connection the card was indistinguishable from one that had failed. The
 * sentence stays, because it is kinder than a grey bar, and now carries the
 * status and the shapes with it.
 */
export function LoadingNote({ label = 'One moment…' }: { label?: string }) {
  return (
    <div className="skeleton" role="status" aria-busy="true" aria-live="polite">
      <p className="muted" style={{ margin: 0 }}>{label}</p>
      <span className="skeleton-line" aria-hidden="true" />
      <span className="skeleton-line" aria-hidden="true" />
    </div>
  );
}
