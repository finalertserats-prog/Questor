import type { ReactNode } from 'react';

/**
 * Questor's icon set: simple 24px stroke icons drawn in-house, so there is no
 * icon dependency and every glyph shares one weight and style. Icons inherit
 * the surrounding text colour and are hidden from assistive technology — the
 * text next to them carries the meaning.
 */

export type IconName =
  | 'menu' | 'close' | 'arrow-right'
  | 'dashboard' | 'candidates' | 'interviews' | 'add-candidate' | 'role'
  | 'settings' | 'admin' | 'about' | 'contact' | 'sign-out'
  | 'job' | 'onboard' | 'schedule' | 'evidence'
  | 'audit' | 'funnel' | 'check-circle' | 'eye' | 'clock' | 'scale';

const PATHS: Record<IconName, ReactNode> = {
  menu: <><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></>,
  close: <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>,
  'arrow-right': <><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></>,
  dashboard: <><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="5" rx="1" /><rect x="13" y="11" width="7" height="9" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /></>,
  candidates: <><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17" cy="9" r="2.5" /><path d="M16 14.2c2.9.4 5 2.8 5 5.8" /></>,
  interviews: <><path d="M4 5h16v10H9l-5 4z" /><path d="M8 9h8" /><path d="M8 12h5" /></>,
  'add-candidate': <><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><path d="M19 8v6" /><path d="M16 11h6" /></>,
  role: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M3 12h18" /></>,
  settings: <><path d="M4 6h16" /><circle cx="9" cy="6" r="2" /><path d="M4 12h16" /><circle cx="15" cy="12" r="2" /><path d="M4 18h16" /><circle cx="7" cy="18" r="2" /></>,
  admin: <><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></>,
  about: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>,
  contact: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
  'sign-out': <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></>,
  job: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /><path d="M9 12h6" /><path d="M9 16h6" /></>,
  onboard: <><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><path d="M16 11l2 2 4-4" /></>,
  schedule: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18" /><path d="M8 3v4" /><path d="M16 3v4" /></>,
  evidence: <><rect x="5" y="5" width="14" height="16" rx="2" /><path d="M9 3h6v4H9z" /><path d="M9 14l2 2 4-4" /></>,
  audit: <><path d="M8 4h11v16H5V7z" /><path d="M8 4v3H5" /><path d="M9 11h6" /><path d="M9 15h4" /></>,
  funnel: <><path d="M3 4h18l-7 8v6l-4 2v-8z" /></>,
  'check-circle': <><circle cx="12" cy="12" r="9" /><path d="M8 12l3 3 5-5" /></>,
  eye: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  scale: <><path d="M12 3v18" /><path d="M7 21h10" /><path d="M5 7h14" /><path d="M5 7l-3 6a3 3 0 0 0 6 0z" /><path d="M19 7l-3 6a3 3 0 0 0 6 0z" /></>,
};

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ? `icon ${className}` : 'icon'}
    >
      {PATHS[name]}
    </svg>
  );
}
