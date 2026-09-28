import { useSyncExternalStore, type KeyboardEvent } from 'react';
import { ADMIN_TABS, adminPanelId, adminTabId, type AdminTabKey } from './adminTabsModel';
import { useAuth } from '../auth';
import { navHealthWord, readHealth, showsNavHealthWord, subscribeHealth, verdictFor } from './healthStatusStore';

interface AdminTabListProps {
  readonly active: AdminTabKey;
  readonly onSelect: (key: AdminTabKey) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, key: AdminTabKey) => void;
}

/**
 * The Admin console's sub-tabs. The System health tab carries the verdict, so
 * a problem is seen from whichever tab is open.
 */
export function AdminTabList({ active, onSelect, onKeyDown }: AdminTabListProps) {
  const { user } = useAuth();
  const health = verdictFor(useSyncExternalStore(subscribeHealth, readHealth, readHealth), user?.id ?? null);
  return (
    <div className="admin-tabs" role="tablist" aria-label="Admin console sections">
      {ADMIN_TABS.map((tab) => {
        const selected = tab.key === active;
        const flagged = tab.key === 'health' && showsNavHealthWord(health.status);
        return (
          <button
            key={tab.key}
            id={adminTabId(tab.key)}
            type="button"
            role="tab"
            className="admin-tab"
            aria-selected={selected}
            // Only the open tab's panel is rendered, so only it is pointed at.
            aria-controls={selected ? adminPanelId(tab.key) : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.key)}
            onKeyDown={(event) => onKeyDown(event, tab.key)}
          >
            {tab.label}
            {flagged && <span className="admin-tab-flag" data-status={health.status}>{navHealthWord(health.status)}</span>}
          </button>
        );
      })}
    </div>
  );
}
