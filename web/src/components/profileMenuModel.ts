/**
 * The sidebar profile menu's decisions, kept free of React so they can be unit
 * tested in the node test environment (see web/tests/profileMenu.test.ts).
 */

interface MenuItemBase {
  readonly key: string;
  readonly label: string;
}

/** An entry that opens a page. */
export interface ProfileMenuLink extends MenuItemBase {
  readonly kind: 'link';
  readonly to: string;
}

/** An entry that does something in place, such as starting the guided tour. */
export interface ProfileMenuAction extends MenuItemBase {
  readonly kind: 'action';
  readonly action: 'start-tour';
}

export type ProfileMenuItem = ProfileMenuLink | ProfileMenuAction;

type MenuEntry = ProfileMenuItem & {
  // Roles that may see the entry; absent means everyone. These mirror the
  // server capability each page's API requires (server domain/capabilities.ts),
  // so nobody is offered a link that only leads to an access-denied page.
  readonly roles?: readonly string[];
};

// admin:manage
const ADMIN_ROLES = ['admin'] as const;
// audit:read
const AUDIT_ROLES = ['admin', 'auditor'] as const;

const MENU_ENTRIES: readonly MenuEntry[] = [
  { key: 'settings', label: 'Settings', kind: 'link', to: '/settings' },
  { key: 'admin', label: 'Admin console', kind: 'link', to: '/admin', roles: ADMIN_ROLES },
  { key: 'signups', label: 'Account requests', kind: 'link', to: '/admin/signups', roles: ADMIN_ROLES },
  { key: 'audit', label: 'Audit log', kind: 'link', to: '/audit', roles: AUDIT_ROLES },
  { key: 'about', label: 'About', kind: 'link', to: '/about' },
  { key: 'contact', label: 'Contact', kind: 'link', to: '/contact' },
  // Last among the entries, beside the other help: the tour is for everyone,
  // and this is the place the tour's own final step points back to.
  { key: 'tour', label: 'Take the tour', kind: 'action', action: 'start-tour' },
];

/** The menu entries this user may see, in display order. */
export function profileMenuItems(role: string): ProfileMenuItem[] {
  return MENU_ENTRIES
    .filter((entry) => !entry.roles || entry.roles.includes(role))
    .map(({ roles: _roles, ...item }) => item);
}

/** Whether this role may open the audit log page. */
export function canReadAudit(role: string): boolean {
  return (AUDIT_ROLES as readonly string[]).includes(role);
}

/** Avatar initials: first and last word of the name, or '?' when there is no name. */
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : '';
  return `${first}${last}`.toUpperCase();
}
