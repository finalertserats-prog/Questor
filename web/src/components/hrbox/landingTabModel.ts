/**
 * The landing page's two sub-tabs: Home (HR-Box, what needs you) and
 * Dashboard (the metrics page as it was). Home is the default. The address
 * decides when it names a tab (?tab=dashboard), so a link or a reload lands on
 * the same tab; otherwise the tab this user last chose, remembered in this
 * browser. Storage that refuses is not an error: the default is used.
 */

export type LandingTab = 'home' | 'dashboard';

/** `tour` is the data-tour anchor the guided demo points at (components/demo/demoScript.ts). */
export const LANDING_TABS: ReadonlyArray<{ readonly key: LandingTab; readonly label: string; readonly icon: 'inbox' | 'dashboard'; readonly tour: string }> = [
  { key: 'home', label: 'Home', icon: 'inbox', tour: 'landing-tab-home' },
  { key: 'dashboard', label: 'Dashboard', icon: 'dashboard', tour: 'landing-tab-dashboard' },
];

export const DEFAULT_LANDING_TAB: LandingTab = 'home';

export function isLandingTab(value: unknown): value is LandingTab {
  return value === 'home' || value === 'dashboard';
}

/** The tab the address names, or null. */
export function tabFromSearch(search: string): LandingTab | null {
  const value = new URLSearchParams(search).get('tab');
  return isLandingTab(value) ? value : null;
}

/** Per user, so two people sharing a browser each keep their own. */
export function landingTabKey(userId: string): string {
  return `questor.landingTab.${userId}`;
}

export interface TabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readRememberedTab(storage: TabStorage | null, userId: string | null): LandingTab | null {
  if (!storage || !userId) return null;
  try {
    const value = storage.getItem(landingTabKey(userId));
    return isLandingTab(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberTab(storage: TabStorage | null, userId: string | null, tab: LandingTab): void {
  if (!storage || !userId) return;
  try {
    storage.setItem(landingTabKey(userId), tab);
  } catch {
    // Private windows and blocked site data refuse; the tab still switches.
  }
}

export function resolveLandingTab(fromAddress: LandingTab | null, remembered: LandingTab | null): LandingTab {
  return fromAddress ?? remembered ?? DEFAULT_LANDING_TAB;
}

/** Arrow keys, Home and End move between tabs, as a tablist is expected to. */
export function tabAfterKey(current: LandingTab, key: string): LandingTab | null {
  const index = LANDING_TABS.findIndex((t) => t.key === current);
  const last = LANDING_TABS.length - 1;
  if (key === 'ArrowRight') return LANDING_TABS[index === last ? 0 : index + 1].key;
  if (key === 'ArrowLeft') return LANDING_TABS[index === 0 ? last : index - 1].key;
  if (key === 'Home') return LANDING_TABS[0].key;
  if (key === 'End') return LANDING_TABS[last].key;
  return null;
}

export const landingTabId = (tab: LandingTab) => `landing-tab-${tab}`;
export const landingPanelId = (tab: LandingTab) => `landing-panel-${tab}`;

/** The browser's localStorage, or null where reaching it throws. */
export function browserStorage(): TabStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Where the guided tour runs: its steps point into the Dashboard tab. */
export const DASHBOARD_TAB = '/?tab=dashboard';

export function onDashboardTab(search: string): boolean {
  return tabFromSearch(search) === 'dashboard';
}
