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
  | 'audit' | 'funnel' | 'clock' | 'scale'
  | 'check' | 'check-circle' | 'x-circle' | 'alert' | 'mail' | 'send' | 'play' | 'pause'
  | 'hourglass' | 'refresh' | 'mic' | 'speaker' | 'lock' | 'stop' | 'handoff' | 'user-x'
  | 'question' | 'draft' | 'plus' | 'copy' | 'save' | 'export' | 'eye' | 'eye-off'
  | 'arrow-left' | 'search' | 'inbox' | 'keyboard' | 'captions' | 'list' | 'sparkle' | 'flag'
  | 'link' | 'build' | 'tour'
  | 'sidebar-collapse' | 'sidebar-expand';

const PATHS: Record<IconName, ReactNode> = {
  menu: <><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></>,
  close: <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>,
  // A panel with its rail drawn in, and the direction the rail is about to go.
  'sidebar-collapse': <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M10 4v16" /><path d="M7 9l-2 3 2 3" /></>,
  'sidebar-expand': <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M10 4v16" /><path d="M5 9l2 3-2 3" /></>,
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
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  scale: <><path d="M12 3v18" /><path d="M7 21h10" /><path d="M5 7h14" /><path d="M5 7l-3 6a3 3 0 0 0 6 0z" /><path d="M19 7l-3 6a3 3 0 0 0 6 0z" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  'check-circle': <><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.7 2.7L16 10" /></>,
  'x-circle': <><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6" /><path d="M15 9l-6 6" /></>,
  alert: <><path d="M12 3.5l9.5 16.5h-19z" /><path d="M12 10v4.5" /><path d="M12 17.5h.01" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
  send: <><path d="M21 3L10 14" /><path d="M21 3l-7 18-4-7-7-4z" /></>,
  play: <><circle cx="12" cy="12" r="9" /><path d="M10 8.5v7l6-3.5z" /></>,
  pause: <><circle cx="12" cy="12" r="9" /><path d="M10 9v6" /><path d="M14 9v6" /></>,
  hourglass: <><path d="M6 3h12" /><path d="M6 21h12" /><path d="M7 3c0 5 10 5 10 9s-10 4-10 9" /><path d="M17 3c0 5-10 5-10 9s10 4 10 9" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" /><path d="M4 3v5h5" /><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" /><path d="M20 21v-5h-5" /></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></>,
  speaker: <><path d="M4 9h4l5-4v14l-5-4H4z" /><path d="M16.5 9a4 4 0 0 1 0 6" /><path d="M19 6.5a7.5 7.5 0 0 1 0 11" /></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  stop: <><path d="M8.3 3h7.4L21 8.3v7.4L15.7 21H8.3L3 15.7V8.3z" /><path d="M8 12h8" /></>,
  handoff: <><path d="M4 8h13" /><path d="M13 4l4 4-4 4" /><path d="M20 16H7" /><path d="M11 12l-4 4 4 4" /></>,
  'user-x': <><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><path d="M17 8l4 4" /><path d="M21 8l-4 4" /></>,
  question: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.6v.6" /><path d="M12 17h.01" /></>,
  draft: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h9" /></>,
  save: <><path d="M5 4h11l3 3v13H5z" /><path d="M8 4v5h7V4" /><path d="M8 20v-6h8v6" /></>,
  export: <><path d="M12 15V3" /><path d="M7 8l5-5 5 5" /><path d="M5 13v7h14v-7" /></>,
  eye: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  'eye-off': <><path d="M3 3l18 18" /><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4" /><path d="M6.6 6.6C3.9 8.3 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
  'arrow-left': <><path d="M19 12H5" /><path d="M11 6l-6 6 6 6" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  inbox: <><path d="M3 13l3-8h12l3 8v6H3z" /><path d="M3 13h5l1.5 3h5l1.5-3h5" /></>,
  keyboard: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h.01" /><path d="M10 10h.01" /><path d="M14 10h.01" /><path d="M18 10h.01" /><path d="M7 14h10" /></>,
  captions: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M10.5 10.2a2 2 0 1 0 0 3.6" /><path d="M17 10.2a2 2 0 1 0 0 3.6" /></>,
  list: <><path d="M9 6h11" /><path d="M9 12h11" /><path d="M9 18h11" /><path d="M4.5 6h.01" /><path d="M4.5 12h.01" /><path d="M4.5 18h.01" /></>,
  sparkle: <><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /></>,
  flag: <><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  build: <><path d="M8 7l-5 5 5 5" /><path d="M16 7l5 5-5 5" /><path d="M13.5 4l-3 16" /></>,
  // A signpost: the guided tour points the way around the product.
  tour: <><path d="M12 3v18" /><path d="M9 21h6" /><path d="M12 5h7l2 2.5L19 10h-7" /><path d="M12 12H6l-2 2.5L6 17h6" /></>,
};

/**
 * `label` is for the rare icon that carries meaning on its own (an icon-only
 * control, say). Without it the icon is decorative and hidden, as before.
 */
export function Icon({ name, size = 18, className, label }: { name: IconName; size?: number; className?: string; label?: string }) {
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
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      focusable="false"
      className={className ? `icon ${className}` : 'icon'}
    >
      {PATHS[name]}
    </svg>
  );
}
