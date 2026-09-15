import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Icon, type IconName } from './Icon';
import { ThemeToggle } from './theme';
import { initialsFor, profileMenuItems } from './profileMenuModel';

const MENU_ICONS: Record<string, IconName> = {
  settings: 'settings',
  admin: 'admin',
  about: 'about',
  contact: 'contact',
};

/**
 * The signed-in user's avatar, pinned to the bottom of the sidebar, opening an
 * upward menu. Authored by agy; which entries appear (and in what order) comes
 * from profileMenuModel so that rule is unit tested rather than trusted.
 */
export function ProfileMenu() {
  const { user, logout } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!isOpen) return undefined;

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

  if (!user) return null;

  return (
    <div className="profile-container" ref={containerRef}>
      {isOpen && (
        <div className="profile-menu-popover" role="menu" aria-label="Profile menu">
          {profileMenuItems(user.role).map((item) => (
            <Link key={item.key} to={item.to} role="menuitem" className="profile-menu-item" onClick={() => setIsOpen(false)}>
              <Icon name={MENU_ICONS[item.key] ?? 'about'} size={16} />
              <span>{item.label}</span>
            </Link>
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
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span className="profile-avatar" aria-hidden="true">{initialsFor(user.name)}</span>
        <span className="profile-details">
          <span className="profile-name">{user.name}</span>
          <span className="profile-role">{user.role}</span>
        </span>
      </button>
    </div>
  );
}
