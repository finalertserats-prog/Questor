import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../Icon';
import { kindCopy, kindLine, lookedLine, waitCaption, waitLabel, whoOf, whyLine, type NeedsYouRow } from './needsYouModel';

/**
 * The "Needs you" rows. Each is marked by a rule down its left edge in the
 * colour of its kind, never a tinted fill; the urgent rule breathes slowly.
 * The stagger index is a CSS variable so rows settle in one after another, and
 * styles/hrbox.css turns all of it off under reduced motion.
 */
export function NeedsYouQueue({ rows, now }: { rows: readonly NeedsYouRow[]; now: number }) {
  return (
    <ul className="hb-queue" data-testid="needs-you-queue">
      {rows.map((row, index) => {
        const copy = kindCopy(row.kind);
        const who = whoOf(row);
        return (
          <li
            key={row.id}
            className={`hb-row hb-row--${copy.tone}`}
            style={{ '--hb-i': Math.min(index, 8) } as CSSProperties}
            data-kind={row.kind}
          >
            <div className="hb-row-main">
              <div className="hb-row-kind"><Icon name={copy.icon} size={14} />{kindLine(row, now)}</div>
              <div className="hb-row-who">
                {row.candidate ? <Link to={`/candidates/${row.candidate.id}`}>{who}</Link> : who}
                {row.role && <span className="hb-row-role"> · {row.role.title}</span>}
              </div>
              <div className="hb-row-why">{whyLine(row)}</div>
            </div>
            <div className="hb-row-wait">
              <small>{waitCaption(row.kind)}</small>
              <span>{waitLabel(row.since, now)}</span>
            </div>
            <div className="hb-row-look">
              {row.openedBy.length > 0 && (
                <span className="hb-peek" aria-hidden="true">
                  {row.openedBy.slice(0, 3).map((l) => <i key={l.userId}>{l.initials}</i>)}
                </span>
              )}
              <span>{lookedLine(row.openedBy)}</span>
            </div>
            <div className="hb-row-act">
              {row.action.to ? (
                <Link className={row.urgent ? 'btn sm' : 'btn sm secondary'} to={row.action.to} aria-label={`${row.action.label}: ${who}`}>
                  {row.action.label}
                </Link>
              ) : (
                <span className="small muted">{row.action.label}</span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Loading keeps the real headings and row heights, so nothing jumps when the queue lands. */
export function NeedsYouSkeleton() {
  const widths = [[38, 62, 80], [30, 55, 72], [42, 50, 66]];
  return (
    <div role="status" aria-live="polite" data-testid="needs-you-loading">
      <span className="visually-hidden">Checking what needs you…</span>
      <ul className="hb-queue" aria-hidden="true">
        {widths.map(([a, b, c], i) => (
          <li key={i} className="hb-row hb-row--pending">
            <div className="hb-sk-lines">
              <span className="hb-sk" style={{ width: `${a}%`, height: 8 }} />
              <span className="hb-sk" style={{ width: `${b}%` }} />
              <span className="hb-sk" style={{ width: `${c}%` }} />
            </div>
            <div className="hb-row-wait"><span className="hb-sk" style={{ width: 48 }} /></div>
            <div className="hb-row-look"><span className="hb-sk" style={{ width: 90 }} /></div>
            <div className="hb-row-act"><span className="hb-sk" style={{ width: 96, height: 28 }} /></div>
          </li>
        ))}
      </ul>
    </div>
  );
}
