import { describe, it, expect } from 'vitest';
import {
  landingTabKey, onDashboardTab, readRememberedTab, rememberTab, resolveLandingTab, tabAfterKey, tabFromSearch,
  type TabStorage,
} from '../src/components/hrbox/landingTabModel';

function memoryStorage(): TabStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

const refusing: TabStorage = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
};

describe('landing tabs', () => {
  it('opens on Home when nothing says otherwise', () => {
    expect(resolveLandingTab(null, null)).toBe('home');
  });

  it('follows the address over what was remembered', () => {
    expect(resolveLandingTab(tabFromSearch('?tab=dashboard'), 'home')).toBe('dashboard');
  });

  it('ignores a tab the page does not have', () => {
    expect(tabFromSearch('?tab=reports')).toBeNull();
  });

  it('remembers the last tab for each user separately', () => {
    const storage = memoryStorage();
    rememberTab(storage, 'u1', 'dashboard');
    expect([readRememberedTab(storage, 'u1'), readRememberedTab(storage, 'u2')]).toEqual(['dashboard', null]);
  });

  it('keys the memory by user', () => {
    expect(landingTabKey('u1')).toBe('questor.landingTab.u1');
  });

  it('survives storage that refuses', () => {
    rememberTab(refusing, 'u1', 'dashboard');
    expect(readRememberedTab(refusing, 'u1')).toBeNull();
  });

  it('wraps round with the arrow keys', () => {
    expect([tabAfterKey('home', 'ArrowLeft'), tabAfterKey('dashboard', 'ArrowRight'), tabAfterKey('home', 'End')]).toEqual(['dashboard', 'home', 'dashboard']);
  });

  it('leaves other keys alone', () => {
    expect(tabAfterKey('home', 'Enter')).toBeNull();
  });

  it('knows when the tour is already on the Dashboard tab', () => {
    expect([onDashboardTab('?tab=dashboard'), onDashboardTab('')]).toEqual([true, false]);
  });
});
