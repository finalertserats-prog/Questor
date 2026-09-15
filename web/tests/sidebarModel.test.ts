import { describe, it, expect } from 'vitest';
import {
  SIDEBAR_STORAGE_KEY,
  brandDisplay,
  navItemTooltip,
  readSidebarMode,
  shellClassName,
  sidebarToggleLabel,
  toggleSidebarMode,
  writeSidebarMode,
  type SidebarMode,
} from '../src/components/sidebarModel';

/**
 * The docked sidebar's decisions, kept free of React so they can be unit tested
 * in the node test environment (no DOM, no jsdom). Storage is passed in rather
 * than reached for globally, so "blocked storage" is an ordinary test case.
 */

/** A localStorage stand-in backed by a plain object. */
function fakeStorage(seed: Record<string, string> = {}) {
  const data = { ...seed };
  return {
    getItem: (key: string) => (key in data ? data[key] : null),
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
    read: () => ({ ...data }),
  };
}

/** Storage that throws on every access, as a privacy mode or blocked API does. */
const blockedStorage = {
  getItem() {
    throw new DOMException('The operation is insecure.');
  },
  setItem() {
    throw new DOMException('The operation is insecure.');
  },
};

describe('readSidebarMode', () => {
  it('defaults to expanded when nothing is stored', () => {
    expect(readSidebarMode(fakeStorage())).toBe('expanded');
  });

  it('defaults to expanded when there is no storage at all', () => {
    expect(readSidebarMode(null)).toBe('expanded');
  });

  it('returns the stored collapsed choice', () => {
    expect(readSidebarMode(fakeStorage({ [SIDEBAR_STORAGE_KEY]: 'collapsed' }))).toBe('collapsed');
  });

  it('returns the stored expanded choice', () => {
    expect(readSidebarMode(fakeStorage({ [SIDEBAR_STORAGE_KEY]: 'expanded' }))).toBe('expanded');
  });

  it('falls back to expanded for a corrupt stored value', () => {
    expect(readSidebarMode(fakeStorage({ [SIDEBAR_STORAGE_KEY]: 'banana' }))).toBe('expanded');
  });

  it('falls back to expanded for an empty stored value', () => {
    expect(readSidebarMode(fakeStorage({ [SIDEBAR_STORAGE_KEY]: '' }))).toBe('expanded');
  });

  it('falls back to expanded when the storage read throws', () => {
    expect(readSidebarMode(blockedStorage)).toBe('expanded');
  });

  it('does not throw when the storage read throws', () => {
    expect(() => readSidebarMode(blockedStorage)).not.toThrow();
  });
});

describe('writeSidebarMode', () => {
  it('persists the chosen mode under the sidebar key', () => {
    const storage = fakeStorage();
    writeSidebarMode('collapsed', storage);
    expect(storage.read()[SIDEBAR_STORAGE_KEY]).toBe('collapsed');
  });

  it('round-trips through a read', () => {
    const storage = fakeStorage();
    writeSidebarMode('collapsed', storage);
    expect(readSidebarMode(storage)).toBe('collapsed');
  });

  it('reports failure instead of throwing when storage is blocked', () => {
    expect(writeSidebarMode('collapsed', blockedStorage)).toBe(false);
  });

  it('reports success when the write lands', () => {
    expect(writeSidebarMode('collapsed', fakeStorage())).toBe(true);
  });

  it('does nothing and reports failure when there is no storage', () => {
    expect(writeSidebarMode('collapsed', null)).toBe(false);
  });
});

describe('toggleSidebarMode', () => {
  it('collapses an expanded sidebar', () => {
    expect(toggleSidebarMode('expanded')).toBe('collapsed');
  });

  it('expands a collapsed sidebar', () => {
    expect(toggleSidebarMode('collapsed')).toBe('expanded');
  });
});

describe('brandDisplay', () => {
  const modes: SidebarMode[] = ['expanded', 'collapsed'];

  it.each(modes)('keeps the Questor wordmark visible when %s', (mode) => {
    expect(brandDisplay(mode).hidden).toBe(false);
  });

  it.each(modes)('still spells out the product name when %s', (mode) => {
    const { lead, tail } = brandDisplay(mode);
    expect(`${lead}${tail}`.toUpperCase()).toBe('QUESTOR');
  });

  it.each(modes)('always names the product for assistive technology when %s', (mode) => {
    expect(brandDisplay(mode).label).toBe('Questor');
  });

  it('marks the wordmark as the rail variant only when collapsed', () => {
    expect(brandDisplay('collapsed').className).toContain('logo-rail');
  });

  it('uses the plain wordmark class when expanded', () => {
    expect(brandDisplay('expanded').className).not.toContain('logo-rail');
  });
});

describe('shellClassName', () => {
  it('marks the shell as railed when collapsed', () => {
    expect(shellClassName('collapsed').split(' ')).toContain('is-rail');
  });

  it('does not mark the shell as railed when expanded', () => {
    expect(shellClassName('expanded').split(' ')).not.toContain('is-rail');
  });

  it('always carries the app class', () => {
    expect(shellClassName('expanded').split(' ')).toContain('app');
  });
});

describe('sidebarToggleLabel', () => {
  it('offers to collapse an expanded sidebar', () => {
    expect(sidebarToggleLabel('expanded')).toBe('Collapse sidebar');
  });

  it('offers to expand a collapsed sidebar', () => {
    expect(sidebarToggleLabel('collapsed')).toBe('Expand sidebar');
  });
});

describe('navItemTooltip', () => {
  it('names the item in the collapsed rail, where the label is not on screen', () => {
    expect(navItemTooltip('collapsed', 'Dashboard')).toBe('Dashboard');
  });

  it('adds no tooltip when the label is already readable', () => {
    expect(navItemTooltip('expanded', 'Dashboard')).toBeUndefined();
  });
});
