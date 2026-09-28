import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../../api/client';
import { Icon } from '../Icon';
import { bellBadge, bellLabel } from './needsYouModel';

/** How often the count is asked for while the tab is visible. */
const POLL_MS = 120_000;

/**
 * The number of things waiting on the signed-in user, for the bell. Asked for
 * on each page change and every two minutes while the tab is in view; a failed
 * ask leaves the last number (or none) rather than inventing a zero.
 */
export function useNeedsYouCount(enabled: boolean): number | null {
  const [total, setTotal] = useState<number | null>(null);
  const { pathname } = useLocation();

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const ask = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      api.get<{ total: number }>('/dashboard/needs-you/count')
        .then((res) => { if (!cancelled) setTotal(res.total); })
        .catch(() => { /* the bell simply keeps its last number */ });
    };
    ask();
    const timer = window.setInterval(ask, POLL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [enabled, pathname]);

  return enabled ? total : null;
}

/** The header bell: how many things need you, and the way to them (Home). */
export function NeedsYouBell({ total, className }: { total: number | null; className?: string }) {
  const badge = bellBadge(total);
  const label = bellLabel(total);
  return (
    <Link to="/?tab=home" className={className ? `hb-bell ${className}` : 'hb-bell'} aria-label={label} title={label} data-testid="needs-you-bell">
      {/* The red dot is part of the bell drawing; the number is set beside it in
          weight, not in a filled pill. */}
      <Icon name={badge ? 'notifications' : 'notifications-none'} size={19} />
      {badge && <span className="hb-bell-count" aria-hidden="true">{badge}</span>}
    </Link>
  );
}
