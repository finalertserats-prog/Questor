import { useRef, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Icon } from '../components/Icon';
import {
  browserStorage, landingPanelId, landingTabId, LANDING_TABS, readRememberedTab, rememberTab,
  resolveLandingTab, tabAfterKey, tabFromSearch, type LandingTab,
} from '../components/hrbox/landingTabModel';
import { Dashboard } from './Dashboard';
import { Home } from './Home';

/**
 * The landing page: two sub-tabs, Home (HR-Box) and Dashboard (the metrics
 * page, unchanged). The address names the tab (?tab=dashboard) so it can be
 * linked and reloaded; without one, the tab this user last chose here.
 */
export function Landing() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const storage = browserStorage();
  const active = resolveLandingTab(tabFromSearch(location.search), readRememberedTab(storage, user?.id ?? null));
  const tabRefs = useRef<Partial<Record<LandingTab, HTMLButtonElement | null>>>({});

  const select = (tab: LandingTab, focus = false) => {
    rememberTab(storage, user?.id ?? null, tab);
    const params = new URLSearchParams(location.search);
    params.set('tab', tab);
    navigate({ pathname: location.pathname, search: `?${params.toString()}` }, { replace: true });
    if (focus) tabRefs.current[tab]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = tabAfterKey(active, event.key);
    if (!next) return;
    event.preventDefault();
    select(next, true);
  };

  return (
    <div className="hb-landing">
      <div className="hb-tabs" role="tablist" aria-label="Home and dashboard">
        {LANDING_TABS.map((tab) => {
          const selected = tab.key === active;
          return (
            <button
              key={tab.key}
              ref={(el) => { tabRefs.current[tab.key] = el; }}
              id={landingTabId(tab.key)}
              type="button"
              role="tab"
              className="hb-tab"
              aria-selected={selected}
              aria-controls={selected ? landingPanelId(tab.key) : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(tab.key)}
              onKeyDown={onKeyDown}
              data-testid={`landing-tab-${tab.key}`}
            >
              <Icon name={tab.icon} size={16} />
              {tab.label}
            </button>
          );
        })}
      </div>
      <div id={landingPanelId(active)} role="tabpanel" aria-labelledby={landingTabId(active)}>
        {active === 'home' ? <Home /> : <Dashboard />}
      </div>
    </div>
  );
}
