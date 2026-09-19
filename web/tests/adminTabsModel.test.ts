import { describe, it, expect } from 'vitest';
import { ADMIN_TABS, adminTabFromParam, adminTabPath, nextAdminTab } from '../src/components/adminTabsModel';

/**
 * The Admin console's sub-tabs: System health first, one address per tab,
 * and the keyboard moving along them the way a tab list should.
 */

describe('the tabs', () => {
  it('puts System health first', () => {
    expect(ADMIN_TABS[0].label).toBe('System health');
  });

  it('lists every section of the console in order', () => {
    expect(ADMIN_TABS.map((tab) => tab.label)).toEqual(['System health', 'Organisation', 'Connectors', 'Meetings', 'Analytics', 'Model executions', 'Webhooks']);
  });
});

describe('adminTabFromParam', () => {
  it('opens System health at /admin', () => {
    expect(adminTabFromParam(undefined)).toBe('health');
  });

  it('opens the tab its address names', () => {
    expect(adminTabFromParam('webhooks')).toBe('webhooks');
  });

  it('refuses a tab that does not exist', () => {
    expect(adminTabFromParam('billing')).toBeNull();
  });
});

describe('adminTabPath', () => {
  it('keeps System health at the plain /admin address', () => {
    expect(adminTabPath('health')).toBe('/admin');
  });

  it('gives every other tab its own address', () => {
    expect(adminTabPath('connectors')).toBe('/admin/connectors');
  });
});

describe('nextAdminTab', () => {
  it('moves right to the next tab', () => {
    expect(nextAdminTab('health', 'ArrowRight')).toBe('organisation');
  });

  it('wraps from the first tab to the last going left', () => {
    expect(nextAdminTab('health', 'ArrowLeft')).toBe('webhooks');
  });

  it('jumps to the last tab on End', () => {
    expect(nextAdminTab('organisation', 'End')).toBe('webhooks');
  });

  it('stays put on any other key', () => {
    expect(nextAdminTab('analytics', 'Enter')).toBe('analytics');
  });
});
