import type { CSSProperties, ReactNode } from 'react';

/**
 * Questor's icon set: 24px outline icons drawn in-house, so there is no icon
 * dependency and every glyph shares one weight and style. The product icons
 * follow the 2026 icon sheet; the small utility glyphs (arrows, play, copy…)
 * predate it and are drawn to the same stroke. Icons inherit the surrounding
 * text colour, so they follow the light and dark themes on their own, and are
 * hidden from assistive technology — the text next to them carries the meaning.
 *
 * Geometry sits on whole and half units of the 24 grid so straight strokes
 * land on the same pixel rows at 16, 18, 20 and 24px instead of smearing.
 */

// Two icons carry a signal colour the sheet draws red in both themes: the
// cross on Rejected and the unread dot on Notifications. A CSS variable does
// not resolve inside an SVG presentation attribute, so it goes through style.
const DANGER = 'var(--stop, #dc2626)';
const DANGER_STROKE: CSSProperties = { stroke: DANGER };
const DANGER_FILL: CSSProperties = { fill: DANGER, stroke: 'none' };

// A page with a folded corner and three lines of text, its lower right left
// open for a round badge (upload, accepted, rejected).
const BADGED_PAGE = <><path d="M12 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l4 4v5" /><path d="M14 3v4h4" /><path d="M8.5 9H11" /><path d="M8.5 12h4" /><path d="M8.5 15H11" /></>;
const PAGE_BADGE = <circle cx="17" cy="17" r="4.5" />;

const PATHS = {
  menu: <><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></>,
  close: <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>,
  // A panel with its rail drawn in, and the direction the rail is about to go.
  'sidebar-collapse': <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M10 4v16" /><path d="M7 9l-2 3 2 3" /></>,
  'sidebar-expand': <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M10 4v16" /><path d="M5 9l2 3-2 3" /></>,
  'arrow-right': <><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></>,

  // The 2026 sheet.
  dashboard: <><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></>,
  candidates: <><circle cx="12" cy="7.5" r="3" /><path d="M6.5 19.5V19a5.5 5.5 0 0 1 11 0v.5z" /><circle cx="5.5" cy="9.5" r="2" /><path d="M2 18a4 4 0 0 1 4-4" /><circle cx="18.5" cy="9.5" r="2" /><path d="M22 18a4 4 0 0 0-4-4" /></>,
  'candidate-profile': <><circle cx="12" cy="8" r="3.5" /><path d="M5.5 20v-.5a6.5 6.5 0 0 1 13 0v.5z" /></>,
  'resume-upload': <>{BADGED_PAGE}{PAGE_BADGE}<path d="M17 19.5v-5" /><path d="M15 16.5l2-2 2 2" /></>,
  jobs: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" /><path d="M3 12h18" /><path d="M10.5 12v1.5a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1V12" /></>,
  'job-description': <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 11h3" /><path d="M9 14h6" /><path d="M9 17h3" /></>,
  'role-match': <><path d="M18.3 9.6A8 8 0 1 1 14.1 5.6" /><circle cx="11" cy="13" r="4" /><path d="M11 13l9-9" /><path d="M16.5 4.5v3h3" /><path d="M18.5 2.5v3h3" /></>,
  'ai-interview': <><path d="M12.5 17.5H7a4 4 0 0 1-4-4v-1a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v1" /><path d="M10 8.5v-3" /><circle cx="10" cy="4.5" r="1" /><path d="M7.5 13h.01" strokeWidth={2.5} /><path d="M12.5 13h.01" strokeWidth={2.5} /><path d="M15 14.5h5.5a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5H17l-2 2v-2a1.5 1.5 0 0 1-1.5-1.5v-3a1.5 1.5 0 0 1 1.5-1.5z" /></>,
  interviews: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 9.5h18" /><path d="M8 3v4" /><path d="M16 3v4" /><circle cx="12" cy="13" r="1.25" /><path d="M9.5 18a2.5 2.5 0 0 1 5 0" /><circle cx="7.5" cy="14" r="1" /><path d="M6 18a1.5 1.5 0 0 1 1.5-1.5" /><circle cx="16.5" cy="14" r="1" /><path d="M18 18a1.5 1.5 0 0 0-1.5-1.5" /></>,
  schedule: <><path d="M20 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" /><path d="M3 10h17" /><path d="M8 3v4" /><path d="M15 3v4" /><circle cx="17.5" cy="17.5" r="4.5" /><path d="M17.5 15v2.5H19" /></>,
  'human-review': <><circle cx="8.5" cy="7" r="3.5" /><path d="M12 19.5H3v-1a5 5 0 0 1 5-5h3.5" /><path d="M17.5 11.5l4 1.5v3.5c0 2.6-1.8 4.7-4 5.5-2.2-.8-4-2.9-4-5.5V13z" /><path d="M15.75 16.5l1.25 1.25 2.5-2.5" /></>,
  'evidence-review': <><path d="M11 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v3" /><path d="M13 3v5h5" /><path d="M7.5 9H10" /><path d="M7.5 12h5" /><path d="M7.5 15H10" /><circle cx="16" cy="16" r="3.5" /><path d="M18.5 18.5l3 3" /></>,
  scorecard: <><path d="M9 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3" /><rect x="9" y="3" width="6" height="3.5" rx="1" /><path d="M9 17.5v-2" /><path d="M12 17.5v-4" /><path d="M15 17.5v-6" /></>,
  'skills-assessment': <><rect x="3" y="13" width="4" height="8" rx="1" /><rect x="10" y="8" width="4" height="13" rx="1" /><rect x="17" y="3" width="4" height="18" rx="1" /></>,
  'communication-score': <><path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9l-4 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" /><path d="M9 13v-2" /><path d="M12 13V9" /><path d="M15 13V7.5" /></>,
  shortlist: <><rect x="2.5" y="4" width="3" height="3" rx=".5" /><path d="M9 5.5h11" /><rect x="2.5" y="9.5" width="3" height="3" rx=".5" /><path d="M9 11h7" /><rect x="2.5" y="15" width="3" height="3" rx=".5" /><path d="M9 16.5h2.5" /><path d="M17.5 12.5l1.23 2.8 3.05.31-2.28 2.04.65 2.99-2.65-1.54-2.65 1.54.65-2.99-2.28-2.04 3.05-.31z" /></>,
  decision: <><path d="M12 3a1.9 1.9 0 0 1 3.25.87 1.9 1.9 0 0 1 2.38 2.38A1.9 1.9 0 0 1 18.5 9.5a1.9 1.9 0 0 1-.87 3.25 1.9 1.9 0 0 1-2.38 2.38A1.9 1.9 0 0 1 12 16a1.9 1.9 0 0 1-3.25-.87 1.9 1.9 0 0 1-2.38-2.38A1.9 1.9 0 0 1 5.5 9.5a1.9 1.9 0 0 1 .87-3.25 1.9 1.9 0 0 1 2.38-2.38A1.9 1.9 0 0 1 12 3z" /><path d="M9.5 9.5l1.75 1.75L14.5 8" /><path d="M8.5 15.5L6.5 21l2.5-.5 1.5 1.5 1-5" /><path d="M15.5 15.5l2 5.5-2.5-.5-1.5 1.5-1-5" /></>,
  offer: <>{BADGED_PAGE}{PAGE_BADGE}<path d="M15 17l1.5 1.5 3-3" /></>,
  rejected: <>{BADGED_PAGE}<g style={DANGER_STROKE}>{PAGE_BADGE}<path d="M15.5 15.5l3 3" /><path d="M18.5 15.5l-3 3" /></g></>,
  search: <><circle cx="9.5" cy="9.5" r="6.5" /><path d="M14.1 14.1l1.9 1.9" /><rect x="15.1" y="17" width="6.6" height="2.8" rx="1.4" transform="rotate(45 18.4 18.4)" /></>,
  insights: <><path d="M9.5 17v-1c0-1.2-.6-2-1.5-3a5 5 0 1 1 8 0c-.9 1-1.5 1.8-1.5 3v1z" /><path d="M9.5 19.5h5" /><path d="M10.5 21.5h3" /><path d="M12 1.5V3" /><path d="M5.5 4.5l1 1" /><path d="M18.5 4.5l-1 1" /><path d="M3 10h1.5" /><path d="M19.5 10H21" /></>,
  reports: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 17.5v-2" /><path d="M12 17.5v-4" /><path d="M15 17.5v-6" /></>,
  notes: <><path d="M17 9.5V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4" /><path d="M8 7h6" /><path d="M8 10h6" /><path d="M8 13h3" /><path d="M18.5 11.5a1.41 1.41 0 0 1 2 2L14 20l-3 1 1-3z" /><path d="M17 13l2 2" /></>,
  recording: <><rect x="9" y="2.5" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0" /><path d="M12 17v4" /><path d="M8.5 21h7" /><path d="M3 9v4" /><path d="M21 9v4" /></>,
  team: <><circle cx="12" cy="7" r="3" /><path d="M7 19v-1a5 5 0 0 1 10 0v1z" /><circle cx="5.5" cy="9" r="2.25" /><path d="M2 18.5a4 4 0 0 1 4-4" /><circle cx="18.5" cy="9" r="2.25" /><path d="M22 18.5a4 4 0 0 0-4-4" /></>,
  notifications: <><path d="M4.5 18c1-1 1.5-2.5 1.5-4.5V11a6 6 0 0 1 12 0v2.5c0 2 .5 3.5 1.5 4.5z" /><path d="M10.75 5.1v-.6a1.25 1.25 0 0 1 2.5 0v.6" /><path d="M10 18a2 2 0 0 0 4 0" /><circle cx="19.5" cy="4" r="2.5" style={DANGER_FILL} /></>,
  settings: <><path d="M9.87 5.12l.24-2.43h3.78l.24 2.43 1.23.51 1.89-1.55 2.67 2.67-1.55 1.89.51 1.23 2.43.24v3.78l-2.43.24-.51 1.23 1.55 1.89-2.67 2.67-1.89-1.55-1.23.51-.24 2.43h-3.78l-.24-2.43-1.23-.51-1.89 1.55-2.67-2.67 1.55-1.89-.51-1.23-2.43-.24v-3.78l2.43-.24.51-1.23-1.55-1.89 2.67-2.67 1.89 1.55z" /><circle cx="12" cy="12" r="3" /></>,
  integrations: <><path d="M9 8h2a2.5 2.5 0 1 1 4 0h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3a2.5 2.5 0 1 0-4 0H9a2 2 0 0 1-2-2v-3a2.5 2.5 0 1 1 0-4v-2a2 2 0 0 1 2-2z" /></>,
  tasks: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M7.5 8l1.25 1.25L11 7" /><path d="M13.5 8H17" /><path d="M7.5 12.5l1.25 1.25L11 11.5" /><path d="M13.5 12.5H17" /><path d="M7.5 17l1.25 1.25L11 16" /><path d="M13.5 17H17" /></>,
  analytics: <><rect x="3" y="16" width="3.5" height="5" rx=".5" /><rect x="10" y="13" width="3.5" height="8" rx=".5" /><rect x="17" y="10" width="3.5" height="11" rx=".5" /><path d="M3 12c6-1.5 11-5 17-9" /><path d="M15.5 3H20v4.5" /></>,

  // Utility glyphs, older than the sheet, on the same stroke.
  'add-candidate': <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20v-.5a6.5 6.5 0 0 1 13 0v.5z" /><path d="M19 8v6" /><path d="M16 11h6" /></>,
  admin: <><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></>,
  about: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></>,
  contact: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
  'sign-out': <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></>,
  onboard: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20v-.5a6.5 6.5 0 0 1 13 0v.5z" /><path d="M16 11l2 2 4-4" /></>,
  audit: <><path d="M8 4h11v16H5V7z" /><path d="M8 4v3H5" /><path d="M9 11h6" /><path d="M9 15h4" /></>,
  funnel: <path d="M3 4h18l-7 8v6l-4 2v-8z" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  scale: <><path d="M12 3v18" /><path d="M7 21h10" /><path d="M5 7h14" /><path d="M5 7l-3 6a3 3 0 0 0 6 0z" /><path d="M19 7l-3 6a3 3 0 0 0 6 0z" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  'check-circle': <><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.5 2.5L16 9.5" /></>,
  'x-circle': <><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6" /><path d="M15 9l-6 6" /></>,
  alert: <><path d="M12 3.5l9.5 16.5h-19z" /><path d="M12 10v4.5" /><path d="M12 17.5h.01" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
  send: <><path d="M21 3L10 14" /><path d="M21 3l-7 18-4-7-7-4z" /></>,
  play: <><circle cx="12" cy="12" r="9" /><path d="M10 8.5v7l6-3.5z" /></>,
  pause: <><circle cx="12" cy="12" r="9" /><path d="M10 9v6" /><path d="M14 9v6" /></>,
  hourglass: <><path d="M6 3h12" /><path d="M6 21h12" /><path d="M7 3c0 5 10 5 10 9s-10 4-10 9" /><path d="M17 3c0 5-10 5-10 9s10 4 10 9" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" /><path d="M4 3v5h5" /><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" /><path d="M20 21v-5h-5" /></>,
  speaker: <><path d="M4 9h4l5-4v14l-5-4H4z" /><path d="M16.5 9a4 4 0 0 1 0 6" /><path d="M19 6.5a7.5 7.5 0 0 1 0 11" /></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  stop: <><path d="M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7z" /><path d="M8 12h8" /></>,
  handoff: <><path d="M4 8h13" /><path d="M13 4l4 4-4 4" /><path d="M20 16H7" /><path d="M11 12l-4 4 4 4" /></>,
  'user-x': <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20v-.5a6.5 6.5 0 0 1 13 0v.5z" /><path d="M17 8l4 4" /><path d="M21 8l-4 4" /></>,
  question: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.6v.6" /><path d="M12 17h.01" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h9" /></>,
  save: <><path d="M5 4h11l3 3v13H5z" /><path d="M8 4v5h7V4" /><path d="M8 20v-6h8v6" /></>,
  export: <><path d="M12 15V3" /><path d="M7 8l5-5 5 5" /><path d="M5 13v7h14v-7" /></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  'eye-off': <><path d="M3 3l18 18" /><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4" /><path d="M6.6 6.6C3.9 8.3 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
  'arrow-left': <><path d="M19 12H5" /><path d="M11 6l-6 6 6 6" /></>,
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
} as const satisfies Record<string, ReactNode>;

type DrawnIconName = keyof typeof PATHS;

/**
 * Names from before the 2026 sheet that mean the same thing as one of its
 * drawings. They render that drawing, so there is one look per idea and no
 * call site has to change to get it.
 */
export const ICON_ALIASES = {
  role: 'jobs',
  job: 'job-description',
  evidence: 'evidence-review',
  draft: 'notes',
  mic: 'recording',
} as const satisfies Record<string, DrawnIconName>;

type AliasIconName = keyof typeof ICON_ALIASES;

export type IconName = DrawnIconName | AliasIconName;

/** Every name an Icon accepts: the drawings, then the aliases. */
export const ICON_NAMES: readonly IconName[] = [
  ...(Object.keys(PATHS) as DrawnIconName[]),
  ...(Object.keys(ICON_ALIASES) as AliasIconName[]),
];

function isAlias(name: IconName): name is AliasIconName {
  return Object.prototype.hasOwnProperty.call(ICON_ALIASES, name);
}

export function resolveIconName(name: IconName): DrawnIconName {
  return isAlias(name) ? ICON_ALIASES[name] : name;
}

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
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      focusable="false"
      className={className ? `icon ${className}` : 'icon'}
    >
      {PATHS[resolveIconName(name)]}
    </svg>
  );
}
