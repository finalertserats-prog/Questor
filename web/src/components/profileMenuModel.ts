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
  // Only for the platform owner (the server's PLATFORM_OPERATOR_EMAILS), whose
  // standing has nothing to do with their role in their own organisation.
  readonly platformOperatorOnly?: true;
};

// admin:manage
const ADMIN_ROLES = ['admin'] as const;
// role:approve_scorecard
const APPROVER_ROLES = ['admin', 'manager'] as const;
// audit:read
const AUDIT_ROLES = ['admin', 'auditor'] as const;

const MENU_ENTRIES: readonly MenuEntry[] = [
  { key: 'settings', label: 'Settings', kind: 'link', to: '/settings' },
  { key: 'admin', label: 'Admin console', kind: 'link', to: '/admin', roles: ADMIN_ROLES },
  { key: 'people', label: 'People', kind: 'link', to: '/admin/users', roles: ADMIN_ROLES },
  { key: 'signups', label: 'Account requests', kind: 'link', to: '/admin/signups', roles: ADMIN_ROLES },
  { key: 'audit', label: 'Audit log', kind: 'link', to: '/audit', roles: AUDIT_ROLES },
  { key: 'catalog-review', label: 'Catalog review', kind: 'link', to: '/catalog-review', platformOperatorOnly: true },
  { key: 'library-admin', label: 'Question library', kind: 'link', to: '/library-admin', platformOperatorOnly: true },
  { key: 'about', label: 'About', kind: 'link', to: '/about' },
  { key: 'contact', label: 'Contact', kind: 'link', to: '/contact' },
  // Last among the entries, beside the other help: the tour is for everyone,
  // and this is the place the tour's own final step points back to.
  { key: 'tour', label: 'Take the tour', kind: 'action', action: 'start-tour' },
];

/** The menu entries this user may see, in display order. */
export function profileMenuItems(role: string, opts: { readonly platformOperator?: boolean } = {}): ProfileMenuItem[] {
  return MENU_ENTRIES
    .filter((entry) => (entry.platformOperatorOnly ? opts.platformOperator === true : !entry.roles || entry.roles.includes(role)))
    .map(({ roles: _roles, platformOperatorOnly: _operatorOnly, ...item }) => item);
}

/** Whether this role may open the Admin console (and so sees it in the sidebar). */
export function canManageAdmin(role: string): boolean {
  return (ADMIN_ROLES as readonly string[]).includes(role);
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

/** Whether this role may approve scorecards and archive roles (role:approve_scorecard). */
export function canApproveRoles(role: string): boolean {
  return (APPROVER_ROLES as readonly string[]).includes(role);
}
