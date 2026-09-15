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
  // Roles that may see the entry; absent means everyone. These mirror the
  // server capability each page's API requires (server domain/capabilities.ts),
  // so nobody is offered a link that only leads to an access-denied page.
  readonly roles?: readonly string[];
}

// admin:manage
const ADMIN_ROLES = ['admin'] as const;
// audit:read
const AUDIT_ROLES = ['admin', 'auditor'] as const;

const MENU_ENTRIES: readonly MenuEntry[] = [
  { key: 'settings', label: 'Settings', to: '/settings' },
  { key: 'admin', label: 'Admin console', to: '/admin', roles: ADMIN_ROLES },
  { key: 'audit', label: 'Audit log', to: '/audit', roles: AUDIT_ROLES },
  { key: 'about', label: 'About', to: '/about' },
  { key: 'contact', label: 'Contact', to: '/contact' },
];

/** The menu entries this user may see, in display order. */
export function profileMenuItems(role: string): ProfileMenuItem[] {
  return MENU_ENTRIES
    .filter((entry) => !entry.roles || entry.roles.includes(role))
    .map(({ key, label, to }) => ({ key, label, to }));
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
