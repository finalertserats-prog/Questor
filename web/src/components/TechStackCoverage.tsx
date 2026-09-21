export interface TechStackCoverageItem {
  readonly name: string;
  readonly level: string;
  readonly evidenced: boolean;
  readonly competencies: readonly string[];
}

interface Props {
  readonly coverage: readonly TechStackCoverageItem[] | undefined;
}

/**
 * Which of the role's required technologies the interview produced evidence
 * for. Read-only: a technology nobody mentioned is a gap for the next round,
 * shown as such, never as a mark against the candidate. Renders nothing for
 * a role without a stack, or an assessment written before roles had one.
 */
export function TechStackCoverage({ coverage }: Props) {
  if (!coverage?.length) return null;
  const evidenced = coverage.filter((c) => c.evidenced).length;
  return (
    <section className="card" aria-labelledby="stack-coverage-title" data-testid="tech-stack-coverage">
      <h3 id="stack-coverage-title" className="card-title">Tech stack coverage</h3>
      <p className="muted small">
        {evidenced} of {coverage.length} required {coverage.length === 1 ? 'technology' : 'technologies'} came up with evidence in this interview.
        A gap here is something to cover in the next round, not a finding about the candidate.
      </p>
      <ul className="stack-coverage-list">
        {coverage.map((c) => (
          <li key={c.name} className={c.evidenced ? 'stack-coverage-item' : 'stack-coverage-item stack-coverage-gap'}>
            <span aria-hidden="true">{c.evidenced ? '[ ✓ ]' : '[ – ]'}</span>
            <span>
              <strong>{c.name}</strong> <span className="muted small">· {c.level} level</span>
              {c.evidenced && c.competencies.length > 0 && <span className="muted small"> · evidenced under {c.competencies.join(', ')}</span>}
              {!c.evidenced && <span className="muted small"> · no evidence came up</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
