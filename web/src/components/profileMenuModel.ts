/**
 * The sidebar profile menu's decisions, kept free of React so they can be unit
 * tested in the node test environment (see web/tests/profileMenu.test.ts).
 */

export interface ProfileMenuItem {
  readonly key: string;
  readonly label: string;
  readonly to: string;
}

interface MenuEntry extends ProfileMenuItem {
  // The admin console's API requires admin:manage, so offering it to anyone
  // else would only lead them to an access-denied page.
  readonly adminOnly?: boolean;
}

const MENU_ENTRIES: readonly MenuEntry[] = [
  { key: 'settings', label: 'Settings', to: '/settings' },
  { key: 'admin', label: 'Admin console', to: '/admin', adminOnly: true },
  { key: 'about', label: 'About', to: '/about' },
  { key: 'contact', label: 'Contact', to: '/contact' },
];

/** The menu entries this user may see, in display order. */
export function profileMenuItems(role: string): ProfileMenuItem[] {
  return MENU_ENTRIES
    .filter((entry) => !entry.adminOnly || role === 'admin')
    .map(({ key, label, to }) => ({ key, label, to }));
}

/** Avatar initials: first and last word of the name, or '?' when there is no name. */
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : '';
  return `${first}${last}`.toUpperCase();
}
