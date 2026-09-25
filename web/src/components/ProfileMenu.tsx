import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Icon, type IconName } from './Icon';
import { ThemeToggle } from './theme';
import { useTour } from './tourContext';
import { initialsFor, profileMenuItems } from './profileMenuModel';
import { demoHidesNavItem } from './demoModel';
import { roleLabel } from './inviteModel';

// The theme switch sits inside the menu, so arrow keys reach it as well as the items.
const MENU_STOPS = '[role="menuitem"], .profile-menu-theme button';

const MENU_ICONS: Record<string, IconName> = {
  settings: 'settings',
  admin: 'admin',
  people: 'team',
  signups: 'inbox',
  audit: 'audit',
  'catalog-review': 'list',
  'library-admin': 'list',
  about: 'about',
  contact: 'contact',
  tour: 'tour',
};

/**
 * The signed-in user's avatar, pinned to the bottom of the sidebar, opening an
 * upward menu. Authored by agy; which entries appear (and in what order) comes
 * from profileMenuModel so that rule is unit tested rather than trusted.
 */
export function ProfileMenu() {
  const { user, tenant, logout } = useAuth();
  const { startTour } = useTour();
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!isOpen) return undefined;

    // Move keyboard focus into the menu, so it is reachable without reaching
    // backwards past the trigger.
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        // Capture phase plus preventDefault: this runs before the sidebar's
        // Escape handler, which skips handled events, so the drawer stays open.
        event.preventDefault();
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    }

    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Arrow keys move between menu items, as expected of role="menu".
  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(MENU_STOPS) ?? []);
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => items[(i + items.length) % items.length].focus();
    if (event.key === 'ArrowDown') { event.preventDefault(); focusAt(index + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusAt(index < 0 ? items.length - 1 : index - 1); }
    else if (event.key === 'Home') { event.preventDefault(); focusAt(0); }
    else if (event.key === 'End') { event.preventDefault(); focusAt(items.length - 1); }
  };

  if (!user) return null;

  return (
    <div
      className="profile-container"
      ref={containerRef}
      // Tabbing out of the menu closes it, rather than leaving it open behind the focus.
      onBlur={(event) => {
        if (isOpen && !event.currentTarget.contains(event.relatedTarget as Node | null)) setIsOpen(false);
      }}
    >
      {isOpen && (
        <div ref={menuRef} className="profile-menu-popover" role="menu" aria-label="Profile menu" onKeyDown={handleMenuKeyDown}>
          {profileMenuItems(user.role, { platformOperator: user.platformOperator === true }).filter((item) => !(tenant?.isDemo && 'to' in item && demoHidesNavItem(item.to))).map((item) => (
            item.kind === 'link' ? (
              <Link key={item.key} to={item.to} role="menuitem" className="profile-menu-item" onClick={() => setIsOpen(false)}>
                <Icon name={MENU_ICONS[item.key] ?? 'about'} size={16} />
                <span>{item.label}</span>
              </Link>
            ) : (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className="profile-menu-item"
                onClick={() => { setIsOpen(false); startTour(); }}
              >
                <Icon name={MENU_ICONS[item.key] ?? 'about'} size={16} />
                <span>{item.label}</span>
              </button>
            )
          ))}
          <div className="profile-menu-divider" role="separator" />
          <div className="profile-menu-theme">
            <ThemeToggle />
          </div>
          <button
            type="button"
            role="menuitem"
            className="profile-menu-item profile-menu-signout"
            onClick={() => {
              setIsOpen(false);
              logout();
              navigate('/login');
            }}
          >
            <Icon name="sign-out" size={16} />
            <span>Sign out</span>
          </button>
        </div>
      )}
      <button
        ref={triggerRef}
        type="button"
        className="profile-trigger"
        data-tour="profile-menu"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span className="profile-avatar" aria-hidden="true">{initialsFor(user.name)}</span>
        <span className="profile-details">
          <span className="profile-name">{user.name}</span>
          <span className="profile-role">{roleLabel(user.role)}</span>
        </span>
      </button>
    </div>
  );
}
