import type { ReactNode } from 'react';
import { Icon } from '../Icon';

/**
 * The three parts of the assessment page, and their headers.
 *
 * The page used to carry the AI's reading, the reviewer's and the comparison
 * as three tabs; then it carried them as one verdict panel with the
 * comparison folded away underneath. Both hid the thing the product is for —
 * a machine assesses, a person judges, and the difference is kept. So the page
 * says it down its own spine: Part 1 what the AI found, Part 2 what the
 * reviewer decided, Part 3 where they differ.
 *
 * Each part states WHEN it was recorded. Two readings of the same interview
 * only mean something next to each other if the reader knows which came first.
 */

export interface AssessmentPartProps {
  readonly number: 1 | 2 | 3;
  readonly title: string;
  /** The id the heading carries, so the part can be linked to and labelled. */
  readonly id: string;
  /** When this part was recorded, in the mono voice the product uses for measurements. */
  readonly when: string;
  readonly children: ReactNode;
  readonly testId?: string;
}

export function AssessmentPart({ number, title, id, when, children, testId }: AssessmentPartProps) {
  return (
    <section className="as-part" aria-labelledby={id} data-testid={testId ?? `assessment-part-${number}`}>
      <div className="as-part-h">
        <span className="as-part-tag">Part {number}</span>
        <h2 id={id}>{title}</h2>
        <span className="as-part-when" data-testid={`part-${number}-when`}>{when}</span>
      </div>
      {children}
    </section>
  );
}

export interface OrderingView {
  readonly kind: 'blind_first' | 'ai_first' | 'unknown';
  readonly label: string;
  readonly detail: string;
}

/**
 * Whether this verdict was recorded before or after the AI's reading was
 * visible to the reviewer.
 *
 * The words come from the server (domain/reviewOrdering.ts) rather than from a
 * copy here: it is the same sentence in the compliance record and on the page,
 * and a second copy is how two vocabularies grow. An older server sends
 * nothing, and then the page says nothing rather than guessing an ordering.
 */
export function ReviewOrderingLine({ ordering }: { readonly ordering: OrderingView | null | undefined }) {
  if (!ordering) return null;
  return (
    <p className={`as-order is-${ordering.kind}`} data-testid="review-ordering">
      <Icon name={ordering.kind === 'blind_first' ? 'eye-off' : 'eye'} size={15} />
      <span><b>{ordering.label}.</b> {ordering.detail}</span>
    </p>
  );
}
