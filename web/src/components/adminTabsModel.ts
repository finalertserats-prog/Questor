/**
 * The Admin console's sub-tabs, kept free of React so their order, addresses
 * and keyboard movement are tested on their own (web/tests/adminTabsModel.test.ts).
 *
 * System health comes first and is where /admin lands: "is anything wrong?"
 * is the question the console is opened for. One section per tab, so no
 * section is found by scrolling past the others. Each tab has its own address,
 * so a link to "the webhooks" or "system health" is a link that stays true.
 */

export type AdminTabKey = 'health' | 'organisation' | 'connectors' | 'meetings' | 'analytics' | 'executions' | 'webhooks';

export interface AdminTab {
  readonly key: AdminTabKey;
  readonly label: string;
}

export const ADMIN_TABS: readonly AdminTab[] = [
  { key: 'health', label: 'System health' },
  { key: 'organisation', label: 'Organisation' },
  { key: 'connectors', label: 'Connectors' },
  { key: 'meetings', label: 'Meetings' },
  { key: 'analytics', label: 'Analytics' },
  { key: 'executions', label: 'Model executions' },
  { key: 'webhooks', label: 'Webhooks' },
];

export const DEFAULT_ADMIN_TAB: AdminTabKey = 'health';

/** The tab an address names; undefined means /admin itself. Null for an unknown tab. */
export function adminTabFromParam(param: string | undefined): AdminTabKey | null {
  if (param === undefined) return DEFAULT_ADMIN_TAB;
  return ADMIN_TABS.find((tab) => tab.key === param)?.key ?? null;
}

/** The first tab lives at /admin, so the console's plain address stays canonical. */
export function adminTabPath(key: AdminTabKey): string {
  return key === DEFAULT_ADMIN_TAB ? '/admin' : `/admin/${key}`;
}

export function adminTabId(key: AdminTabKey): string { return `admin-${key}-tab`; }
export function adminPanelId(key: AdminTabKey): string { return `admin-${key}-panel`; }

/** Arrow keys move along the tabs and wrap; Home and End jump to either end. */
export function nextAdminTab(current: AdminTabKey, key: string): AdminTabKey {
  const index = ADMIN_TABS.findIndex((tab) => tab.key === current);
  if (key === 'Home') return ADMIN_TABS[0].key;
  if (key === 'End') return ADMIN_TABS[ADMIN_TABS.length - 1].key;
  if (key !== 'ArrowRight' && key !== 'ArrowLeft') return current;
  const delta = key === 'ArrowRight' ? 1 : -1;
  return ADMIN_TABS[(index + delta + ADMIN_TABS.length) % ADMIN_TABS.length].key;
}
