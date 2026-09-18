/**
 * The guided product tour's decisions, kept free of React so they can be unit
 * tested in the node test environment (see web/tests/tourModel.test.ts).
 *
 * A step points at an element by its `data-tour` attribute — never by class or
 * position, which break silently when the markup moves. A step whose anchor is
 * not on the current page is skipped rather than shown pointing at nothing:
 * presence is asked for at the moment of stepping, so an element that appears
 * late (a chart after its data loads) is still found.
 */

export interface TourStep {
  readonly id: string;
  /** The `data-tour` value of the element pointed at. Absent: a centred card. */
  readonly anchor?: string;
  readonly title: string;
  readonly body: string;
  /** Lives in the sidebar, which on a phone is a drawer that must be opened first. */
  readonly inSidebar?: boolean;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Questor',
    body: 'Questor runs the first interview round for you and keeps every later round on one evidence trail. This short tour shows where everything is. Use Next and Back, or the arrow keys; Escape skips it. You can take it again any time.',
  },
  {
    id: 'nav-dashboard',
    anchor: 'nav-dashboard',
    inSidebar: true,
    title: 'Dashboard',
    body: 'Your home page: the hiring workflow, the numbers that matter this week, trends, and the interviews that most recently moved. Start here each morning.',
  },
  {
    id: 'nav-candidates',
    anchor: 'nav-candidates',
    inSidebar: true,
    title: 'Candidates',
    body: 'Everyone you are hiring, with their role, fit score and latest interview state. Open a candidate to see their profile, résumé, interviews and their place in the hiring pipeline.',
  },
  {
    id: 'nav-roles',
    anchor: 'nav-roles',
    inSidebar: true,
    title: 'Roles',
    body: 'Every role you can see, with its hiring funnel and the counts behind candidate movement.',
  },
  {
    id: 'nav-interviews',
    anchor: 'nav-interviews',
    inSidebar: true,
    title: 'Interviews',
    body: 'Every AI first-round interview: who, for which role, and how far along it is. Open one to read the transcript and the assessment, then record your own review.',
  },
  {
    id: 'nav-add-candidate',
    anchor: 'nav-add-candidate',
    inSidebar: true,
    title: 'Add candidate',
    body: 'Onboard a person: enter their details, upload a résumé for Questor to parse, and attach them to a role. From their page you can then invite them to an AI interview.',
  },
  {
    id: 'nav-new-role',
    anchor: 'nav-new-role',
    inSidebar: true,
    title: 'New role',
    body: 'Paste a job description and Questor drafts a scorecard — the competencies every interview is measured against. Approve it before interviewing so every candidate is judged the same way.',
  },
  {
    id: 'workflow',
    anchor: 'workflow',
    title: 'The hiring workflow',
    body: 'The four steps in order: create a role from its job description, onboard a candidate, schedule the interviews, then assess through evidence. Each step is a link to where it is done.',
  },
  {
    id: 'kpis',
    anchor: 'kpis',
    title: 'Key metrics',
    body: 'Open roles, candidates, who is in the pipeline, what is scheduled in the next week, what completed in the last month, and what is waiting for a person to review. Tiles with a link take you straight to the list behind the number.',
  },
  {
    id: 'trends',
    anchor: 'trends',
    title: 'Trends',
    body: 'Interviews per week, how many candidates sit at each pipeline stage, and where every AI interview is right now — so a slowdown shows up before someone complains about it.',
  },
  {
    id: 'pipeline-stages',
    anchor: 'pipeline-stages',
    title: 'The medallion pipeline',
    body: 'Every candidate moves through Participation (onboarding), Bronze (profile review), Silver — the AI interview, run by Schranders while HR may quietly observe — and then the human rounds: Gold, Platinum and Diamond, where the AI only listens and transcribes. A person decides every advancement and the final outcome, from the Hiring pipeline panel on the candidate’s page.',
  },
  {
    id: 'recent-interviews',
    anchor: 'recent-interviews',
    title: 'Recent interviews',
    body: 'The interviews that changed most recently, with their state and date. Open one directly, or view the full list.',
  },
  {
    id: 'profile-menu',
    anchor: 'profile-menu',
    inSidebar: true,
    title: 'Your profile menu',
    body: 'Settings for your account and organisation, the Audit log of who did what, the Admin console for users, roles and connectors (administrators only), About, Contact, the light or dark theme, and Sign out.',
  },
  {
    id: 'finish',
    anchor: 'profile-menu',
    inSidebar: true,
    title: 'That is the tour',
    body: 'Whenever you want to see it again, open this profile menu and choose “Take the tour”. Now, a good first step is creating a role from a job description.',
  },
];

export type TourStatus = 'idle' | 'running' | 'completed' | 'skipped';

export interface TourState {
  readonly status: TourStatus;
  readonly index: number;
}

export const IDLE_TOUR: TourState = { status: 'idle', index: -1 };

/** Answers whether the element a step points at is on the page. A centred step always is. */
export type AnchorPresence = (anchor: string | undefined) => boolean;

function isPresent(step: TourStep, present: AnchorPresence): boolean {
  return step.anchor === undefined || present(step.anchor);
}

function findPresent(steps: readonly TourStep[], from: number, direction: 1 | -1, present: AnchorPresence): number {
  for (let index = from; index >= 0 && index < steps.length; index += direction) {
    if (isPresent(steps[index], present)) return index;
  }
  return -1;
}

/** Begin at the first step that can be shown; with none to show, the tour is already complete. */
export function startTour(steps: readonly TourStep[], present: AnchorPresence): TourState {
  const index = findPresent(steps, 0, 1, present);
  return index < 0 ? { status: 'completed', index: -1 } : { status: 'running', index };
}

export const restartTour = startTour;

/** The next step that can be shown; past the last one, the tour is complete. */
export function nextStep(state: TourState, steps: readonly TourStep[], present: AnchorPresence): TourState {
  if (state.status !== 'running') return state;
  const index = findPresent(steps, state.index + 1, 1, present);
  return index < 0 ? { status: 'completed', index: state.index } : { status: 'running', index };
}

/** The previous step that can be shown; on the first, nothing changes. */
export function previousStep(state: TourState, steps: readonly TourStep[], present: AnchorPresence): TourState {
  if (state.status !== 'running') return state;
  const index = findPresent(steps, state.index - 1, -1, present);
  return index < 0 ? state : { status: 'running', index };
}

export function skipTour(state: TourState): TourState {
  return { status: 'skipped', index: state.index };
}

export function tourHasEnded(state: TourState): boolean {
  return state.status === 'completed' || state.status === 'skipped';
}

export function isFirstStep(state: TourState, steps: readonly TourStep[], present: AnchorPresence): boolean {
  return findPresent(steps, state.index - 1, -1, present) < 0;
}

export function isLastStep(state: TourState, steps: readonly TourStep[], present: AnchorPresence): boolean {
  return findPresent(steps, state.index + 1, 1, present) < 0;
}

/**
 * The tour runs by itself once, for a user the server has never recorded as
 * having finished or skipped it — and only once they reach the dashboard,
 * where the steps live, rather than on whatever deep link they signed in to.
 */
export function shouldAutoStartTour(user: { readonly tourCompletedAt: string | null } | null, pathname: string): boolean {
  return user !== null && user.tourCompletedAt === null && pathname === '/';
}

export interface StepPosition {
  readonly current: number;
  readonly total: number;
}

/** Where the reader is, counted over the steps this page can show. */
export function stepPosition(state: TourState, steps: readonly TourStep[], present: AnchorPresence): StepPosition {
  let current = 0;
  let total = 0;
  steps.forEach((step, index) => {
    if (!isPresent(step, present)) return;
    total += 1;
    if (index <= state.index) current += 1;
  });
  return { current, total };
}

/** What a screen reader hears when the step changes. */
export function stepAnnouncement(step: TourStep, position: StepPosition): string {
  return `Step ${position.current} of ${position.total}: ${step.title}`;
}

export interface TourMotion {
  readonly scrollBehavior: 'auto' | 'smooth';
  readonly animate: boolean;
}

/** With reduced motion, the spotlight jumps and the page scrolls instantly. */
export function tourMotion(reducedMotion: boolean): TourMotion {
  return reducedMotion ? { scrollBehavior: 'auto', animate: false } : { scrollBehavior: 'smooth', animate: true };
}

export type TourKeyAction = 'next' | 'back' | 'skip';

/** Escape skips; the arrow keys step. Tab is left to the focus trap. */
export function keyAction(key: string): TourKeyAction | null {
  switch (key) {
    case 'Escape': return 'skip';
    case 'ArrowRight': return 'next';
    case 'ArrowLeft': return 'back';
    default: return null;
  }
}

/** On a phone the sidebar is a drawer; a step that points into it needs the drawer open. */
export function needsDrawer(step: TourStep, isNarrowViewport: boolean): boolean {
  return step.inSidebar === true && isNarrowViewport;
}

export interface Rect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export type TourPlacement = 'right' | 'bottom' | 'top' | 'left' | 'center' | 'sheet';

export interface CardPlacement {
  readonly top: number;
  readonly left: number;
  readonly placement: TourPlacement;
}

/** Below this width the card is a sheet docked to the bottom edge, whatever it points at. */
export const SHEET_BREAKPOINT = 600;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * Where the card goes: beside a sidebar item, below or above a wide element,
 * centred when there is nothing to point at, and always inside the viewport.
 */
export function placeTourCard(target: Rect | null, card: Size, viewport: Size, gap = 12): CardPlacement {
  if (target === null) {
    return { top: (viewport.height - card.height) / 2, left: (viewport.width - card.width) / 2, placement: 'center' };
  }
  if (viewport.width < SHEET_BREAKPOINT) {
    return { top: viewport.height - card.height - gap, left: gap, placement: 'sheet' };
  }
  const maxLeft = viewport.width - card.width - gap;
  const maxTop = viewport.height - card.height - gap;
  const right = target.left + target.width + gap;
  if (right + card.width + gap <= viewport.width) {
    return { top: clamp(target.top, gap, maxTop), left: right, placement: 'right' };
  }
  const below = target.top + target.height + gap;
  if (below + card.height + gap <= viewport.height) {
    return { top: below, left: clamp(target.left, gap, maxLeft), placement: 'bottom' };
  }
  const above = target.top - card.height - gap;
  if (above >= gap) {
    return { top: above, left: clamp(target.left, gap, maxLeft), placement: 'top' };
  }
  const left = target.left - card.width - gap;
  if (left >= gap) {
    return { top: clamp(target.top, gap, maxTop), left, placement: 'left' };
  }
  return { top: clamp(target.top, gap, maxTop), left: clamp(target.left, gap, maxLeft), placement: 'bottom' };
}
