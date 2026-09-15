/**
 * The docked sidebar's decisions, kept free of React so they can be unit tested
 * in the node test environment (see web/tests/sidebarModel.test.ts).
 *
 * The sidebar being collapsible does not mean it starts collapsed: on a desktop
 * viewport it is docked beside the page and EXPANDED unless the reader has said
 * otherwise. Collapsing narrows it to an icon rail — it never removes the
 * product name, which is why brandDisplay reports `hidden: false` by type.
 *
 * Storage is passed in rather than reached for globally, so a blocked or
 * partitioned localStorage is an ordinary case here rather than a crash in a
 * render.
 */

export type SidebarMode = 'expanded' | 'collapsed';

export const SIDEBAR_STORAGE_KEY = 'questor-sidebar';

/** Expanded is the product default, exactly as light is the theme default. */
export const DEFAULT_SIDEBAR_MODE: SidebarMode = 'expanded';

/** The slice of the Storage API this module uses. */
export interface SidebarStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser's localStorage, or null where merely touching it throws. */
export function browserSidebarStorage(): SidebarStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The remembered choice, or expanded. Anything unreadable — no storage, no
 * stored value, a corrupt value, a storage that throws — means the default.
 */
export function readSidebarMode(storage: SidebarStorage | null = browserSidebarStorage()): SidebarMode {
  try {
    const stored = storage?.getItem(SIDEBAR_STORAGE_KEY);
    if (stored === 'collapsed' || stored === 'expanded') return stored;
  } catch {
    // Private mode / blocked storage: fall through to the default.
  }
  return DEFAULT_SIDEBAR_MODE;
}

/** Remember the choice. Reports whether it stuck; a failure is not an error. */
export function writeSidebarMode(mode: SidebarMode, storage: SidebarStorage | null = browserSidebarStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SIDEBAR_STORAGE_KEY, mode);
    return true;
  } catch {
    // A preference we cannot persist is still a preference we can apply.
    return false;
  }
}

export function toggleSidebarMode(mode: SidebarMode): SidebarMode {
  return mode === 'expanded' ? 'collapsed' : 'expanded';
}

/**
 * How the wordmark is drawn. `hidden` is typed as the literal `false`: there is
 * no state of this component in which the product name leaves the screen. The
 * rail variant sets it smaller, it does not set it away.
 */
export interface BrandDisplay {
  readonly hidden: false;
  readonly lead: string;
  readonly tail: string;
  readonly label: string;
  readonly className: string;
}

export function brandDisplay(mode: SidebarMode): BrandDisplay {
  return {
    hidden: false,
    lead: 'QUES',
    tail: 'TOR',
    label: 'Questor',
    className: mode === 'collapsed' ? 'logo logo-rail' : 'logo',
  };
}

/** Classes for the app shell, which is what the CSS keys the rail layout off. */
export function shellClassName(mode: SidebarMode): string {
  return mode === 'collapsed' ? 'app is-rail' : 'app';
}

/** What the collapse control offers to do next, for its label and tooltip. */
export function sidebarToggleLabel(mode: SidebarMode): string {
  return mode === 'collapsed' ? 'Expand sidebar' : 'Collapse sidebar';
}

/**
 * The hover/focus tooltip for a nav item. Only the rail needs one — when the
 * label is already beside the icon, a tooltip would just repeat it.
 */
export function navItemTooltip(mode: SidebarMode, label: string): string | undefined {
  return mode === 'collapsed' ? label : undefined;
}
