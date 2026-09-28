import type { ReactNode } from 'react';
import { Icon } from '../Icon';

/**
 * What folds underneath the decision.
 *
 * Everything here is reference: true, worth having, and not what a reviewer
 * came to the page to do. Folded rather than removed — a caveat nobody can
 * find is the same as a caveat nobody wrote — and each fold says how much is
 * inside, so opening one is a decision rather than a gamble.
 */

export function Fold({ title, count, children, onOpen, testId }: {
  readonly title: string;
  readonly count?: string;
  readonly children: ReactNode;
  /** Called the first time the fold is opened, for content worth fetching lazily. */
  readonly onOpen?: () => void;
  readonly testId?: string;
}) {
  return (
    <details
      className="fold"
      data-testid={testId}
      onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) onOpen?.(); }}
    >
      <summary>
        <span><b>{title}</b>{count ? <span className="fold-count"> · {count}</span> : null}</span>
        <Icon name="arrow-right" size={16} />
      </summary>
      <div className="fold-in">{children}</div>
    </details>
  );
}

export interface SwotResult {
  readonly strengths?: readonly string[] | null;
  readonly concerns?: readonly string[] | null;
  readonly contradictions?: readonly string[] | null;
  readonly openQuestions?: readonly string[] | null;
  readonly limitations?: readonly string[] | null;
}

interface Part {
  readonly key: keyof SwotResult;
  readonly title: string;
  readonly tone: string;
}

// Ordered as a reviewer reads them: what the candidate did well, what they did
// not, and then the things that are about the assessment rather than about the
// person — which is why the limitations sit last and in their own colour.
const PARTS: readonly Part[] = [
  { key: 'strengths', title: 'Strengths', tone: 'is-pass' },
  { key: 'concerns', title: 'Worth working on', tone: 'is-hold' },
  { key: 'contradictions', title: 'Contradictions', tone: 'is-stop' },
  { key: 'openQuestions', title: 'Open questions', tone: 'is-info' },
  { key: 'limitations', title: 'What this assessment could not see', tone: 'is-note' },
];

export function swotParts(result: SwotResult | null | undefined) {
  return PARTS
    .map((part) => ({ ...part, items: (result?.[part.key] ?? []).filter((s) => typeof s === 'string' && s.trim() !== '') }))
    .filter((part) => part.items.length > 0);
}

export function SwotFold({ result }: { readonly result: SwotResult | null | undefined }) {
  const parts = swotParts(result);
  if (parts.length === 0) return null;
  const total = parts.reduce((n, part) => n + part.items.length, 0);
  return (
    <Fold title="Strengths, and what is worth a look" count={`${total} point${total === 1 ? '' : 's'}`} testId="swot-fold">
      <div className="swot">
        {parts.map((part) => (
          <div key={part.key} className={`swot-part ${part.tone}`}>
            <h3>{part.title}</h3>
            <ul>{part.items.map((item, i) => <li key={i}>{item}</li>)}</ul>
          </div>
        ))}
      </div>
    </Fold>
  );
}
