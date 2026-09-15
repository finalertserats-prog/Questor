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
