import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import type { CardMark, NextAction } from './listCardModel';

/**
 * A list that is a table on a desktop and a stack of cards on a phone.
 *
 * Under 640px a table either scrolls sideways — pushing the one column that
 * says what to do next off screen — or crushes every column. Each row becomes
 * a card instead: who, what role, where they stand, and the next step as a
 * full-width line to tap. Only one of the two is rendered, so there is never a
 * hidden duplicate of every link on the page.
 */

export const PHONE_QUERY = '(max-width: 640px)';

function phoneQuery(): MediaQueryList | null {
  try {
    return window.matchMedia(PHONE_QUERY);
  } catch {
    // No matchMedia: assume the desktop table.
    return null;
  }
}

export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(() => phoneQuery()?.matches ?? false);
  useEffect(() => {
    const query = phoneQuery();
    if (!query) return undefined;
    setIsPhone(query.matches);
    const onChange = (event: MediaQueryListEvent) => setIsPhone(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return isPhone;
}

export interface ListCard {
  readonly key: string;
  /** The person or role; usually a link to it. */
  readonly title: ReactNode;
  /** Beside the title: a stage, tier or status. */
  readonly badge?: ReactNode;
  /** One short line each: the role, where they stand. */
  readonly lines: readonly ReactNode[];
  readonly next: NextAction;
  /** A secondary control that is not the next step (e.g. "Another role"). */
  readonly extra?: ReactNode;
  readonly testId?: string;
}

const MARK_CLASS: Readonly<Record<CardMark, string>> = {
  urgent: 'is-urgent',
  review: 'is-review',
  waiting: 'is-waiting',
  live: 'is-live',
};

/** Said to a screen reader, since the mark itself is only a coloured rule. */
const MARK_TEXT: Readonly<Record<CardMark, string>> = {
  urgent: 'Needs a look',
  review: 'Ready for review',
  waiting: 'Waiting on the candidate',
  live: 'Happening now',
};

function Card({ card }: { card: ListCard }) {
  const mark = card.next.mark;
  return (
    <li className={mark ? `list-card ${MARK_CLASS[mark]}` : 'list-card'} data-testid={card.testId}>
      <div className="list-card-top">
        <span className="list-card-title">{card.title}</span>
        {card.badge}
      </div>
      {card.lines.map((line, index) => <div key={index} className="list-card-line">{line}</div>)}
      {mark && <span className="visually-hidden">{MARK_TEXT[mark]}.</span>}
      {card.extra && <div className="list-card-extra">{card.extra}</div>}
      <Link className="list-card-next" to={card.next.to}>
        {card.next.label}<Icon name="arrow-right" size={18} />
      </Link>
    </li>
  );
}

export function ResponsiveList(props: {
  /** Names the table region and the card list for a screen reader. */
  readonly label: string;
  /** The desktop table, as the page already draws it. */
  readonly table: ReactNode;
  readonly cards: readonly ListCard[];
}) {
  const isPhone = useIsPhone();
  if (!isPhone) {
    return <div className="table-scroll" tabIndex={0} role="region" aria-label={props.label}>{props.table}</div>;
  }
  return (
    <ul className="list-cards" aria-label={props.label}>
      {props.cards.map((card) => <Card key={card.key} card={card} />)}
    </ul>
  );
}
