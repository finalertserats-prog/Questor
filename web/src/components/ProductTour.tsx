import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Icon } from './Icon';
import { useTour } from './tourContext';
import { DASHBOARD_TAB, onDashboardTab } from './hrbox/landingTabModel';
import {
  IDLE_TOUR,
  TOUR_STEPS,
  isFirstStep,
  isLastStep,
  keyAction,
  needsDrawer,
  nextStep,
  placeTourCard,
  previousStep,
  restartTour,
  shouldAutoStartTour,
  skipTour,
  stepAnnouncement,
  stepPosition,
  tourHasEnded,
  tourMotion,
  type AnchorPresence,
  type CardPlacement,
  type Rect,
  type TourState,
} from './tourModel';

const SPOTLIGHT_PADDING = 6;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
// Long enough for the drawer to have opened or closed and the page behind it
// to have stopped being inert, short enough not to be noticed.
const FOCUS_SETTLE_MS = 50;
const DRAWER_SETTLE_MS = 250;

interface ProductTourProps {
  /** Below the sidebar breakpoint, where the sidebar is a drawer. */
  readonly isNarrow: boolean;
  /** Opens or closes that drawer, for steps that point into it. */
  readonly setDrawerOpen: (open: boolean) => void;
}

function anchorElement(anchor: string | undefined): HTMLElement | null {
  if (anchor === undefined) return null;
  return document.querySelector<HTMLElement>(`[data-tour="${anchor}"]`);
}

const anchorPresent: AnchorPresence = (anchor) => anchor === undefined || anchorElement(anchor) !== null;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    try {
      return window.matchMedia(REDUCED_MOTION).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia(REDUCED_MOTION);
    } catch {
      return undefined;
    }
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

const sameRect = (a: Rect | null, b: Rect | null) =>
  a === b || (a !== null && b !== null && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

const samePlacement = (a: CardPlacement, b: CardPlacement) => a.top === b.top && a.left === b.left && a.placement === b.placement;

/**
 * The guided tour: a spotlight on one element at a time with a coach-mark card
 * beside it. Which steps exist and how they progress is decided in tourModel;
 * this component measures the page, draws, and keeps keyboard focus inside.
 *
 * It runs by itself the first time a user reaches the dashboard, until they
 * finish or skip it — recorded on the server, so it stays away on every
 * browser — and again whenever "Take the tour" is chosen from the profile menu.
 */
export function ProductTour({ isNarrow, setDrawerOpen }: ProductTourProps) {
  const { user, markTourComplete, refreshTourStatus } = useAuth();
  const { startRequest } = useTour();
  const location = useLocation();
  const navigate = useNavigate();
  const reducedMotion = usePrefersReducedMotion();
  const titleId = useId();
  const bodyId = useId();

  const [state, setState] = useState<TourState>(IDLE_TOUR);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [card, setCard] = useState<CardPlacement>({ top: 0, left: 0, placement: 'center' });
  const cardRef = useRef<HTMLDivElement>(null);
  // Where focus goes back to when the tour ends.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // The automatic first run happens once per session even if recording it fails.
  const autoStartedRef = useRef(false);
  const handledRequestRef = useRef(0);
  const returnFocusTimerRef = useRef<number | undefined>(undefined);

  const running = state.status === 'running';
  const step = running ? TOUR_STEPS[state.index] : null;
  const motion = tourMotion(reducedMotion);

  // Any run counts as the session's first run: a tour taken from the menu
  // must not be followed by the automatic one the moment it ends, while the
  // server is still being told about it.
  const begin = useCallback(() => {
    autoStartedRef.current = true;
    setState(restartTour(TOUR_STEPS, anchorPresent));
  }, []);

  // First sign-in: once the dashboard is reached and the server has no record
  // of this user finishing or skipping the tour.
  useEffect(() => {
    if (autoStartedRef.current || state.status !== 'idle') return;
    if (!shouldAutoStartTour(user, location.pathname)) return;
    // Claimed before the request, not after: otherwise a re-render while the
    // server is answering would start a second one.
    autoStartedRef.current = true;
    const active = document.activeElement;
    returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    let cancelled = false;
    // This tab's flag may be stale — another tab may have finished the tour
    // since this page loaded.
    void refreshTourStatus().then((completedAt) => {
      if (cancelled || completedAt !== null) return;
      // Its steps point into the Dashboard tab; Home is the landing default.
      if (!onDashboardTab(location.search)) navigate(DASHBOARD_TAB);
      begin();
    });
    return () => { cancelled = true; };
  }, [user, location.pathname, location.search, navigate, state.status, begin, refreshTourStatus]);

  // "Take the tour" from the profile menu: from anywhere, back to step one on
  // the dashboard, where the steps live. Focus goes back to the menu's trigger
  // afterwards, since the menu item that was pressed is gone.
  useEffect(() => {
    if (startRequest === handledRequestRef.current) return;
    handledRequestRef.current = startRequest;
    returnFocusRef.current = anchorElement('profile-menu');
    if (location.pathname !== '/' || !onDashboardTab(location.search)) navigate(DASHBOARD_TAB);
    begin();
  }, [startRequest, location.pathname, location.search, navigate, begin]);

  // Each step: open or close the phone drawer as the step needs, and bring the
  // element into view. Measuring happens continuously below, so a drawer still
  // sliding in or a page still scrolling is caught up with.
  useEffect(() => {
    if (!step) return;
    setDrawerOpen(needsDrawer(step, isNarrow));
    const element = anchorElement(step.anchor);
    if (element) element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: motion.scrollBehavior });
  }, [step, isNarrow, setDrawerOpen, motion.scrollBehavior]);

  // Focus the card for every step. Synchronously, so it holds even where
  // animation frames are throttled (a background tab); and once more a moment
  // later, since the drawer focuses its own close button as it opens and the
  // focus trap below only guards against focus leaving afterwards.
  useEffect(() => {
    if (!step) return undefined;
    // The card is fixed to the viewport; focusing it must not cut short the
    // page's own scroll towards the element.
    const focusCard = () => cardRef.current?.focus({ preventScroll: true });
    focusCard();
    const timer = window.setTimeout(focusCard, FOCUS_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [step]);

  // Where the element and the card are. State only changes when a number
  // actually moves, so calling this often is cheap.
  const measure = useCallback(() => {
    if (!step) return;
    const element = anchorElement(step.anchor);
    const box = element?.getBoundingClientRect();
    const next: Rect | null = box ? { top: box.top, left: box.left, width: box.width, height: box.height } : null;
    setTargetRect((current) => (sameRect(current, next) ? current : next));
    const cardBox = cardRef.current?.getBoundingClientRect();
    if (cardBox) {
      const placed = placeTourCard(next, { width: cardBox.width, height: cardBox.height }, { width: window.innerWidth, height: window.innerHeight });
      setCard((current) => (samePlacement(current, placed) ? current : placed));
    }
  }, [step]);

  // Measured before paint on every step, so the card never shows at its
  // previous position first...
  useLayoutEffect(() => {
    if (!step) {
      setTargetRect(null);
      return;
    }
    measure();
  }, [step, measure]);

  // ...then kept in step with scrolling and resizing, and with anything else
  // that moves — a drawer sliding in, a chart arriving with its data — by an
  // animation-frame loop while the tour runs.
  useEffect(() => {
    if (!step) return undefined;
    let frame = 0;
    const tick = () => {
      measure();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // The drawer's slide takes 0.2s; this catches its resting place even where
    // frames are throttled.
    const settled = window.setTimeout(measure, DRAWER_SETTLE_MS);
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settled);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [step, measure]);

  // Keyboard: Escape skips, the arrow keys step, and focus cannot leave the
  // card. Capture phase, so the sidebar's own Escape (which closes the drawer)
  // and the page underneath never see these keys.
  useEffect(() => {
    if (!running) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const action = keyAction(event.key);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === 'skip') setState((current) => skipTour(current));
      else if (action === 'next') setState((current) => nextStep(current, TOUR_STEPS, anchorPresent));
      else setState((current) => previousStep(current, TOUR_STEPS, anchorPresent));
    };
    const onFocusIn = (event: FocusEvent) => {
      const dialog = cardRef.current;
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) dialog.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [running]);

  // The end, by either door: close the drawer, tell the server, hand focus
  // back, and reset so the tour can be taken again.
  useEffect(() => {
    if (!tourHasEnded(state)) return;
    setDrawerOpen(false);
    if (user && user.tourCompletedAt === null) {
      // A failed save only means the tour offers itself once more next sign-in.
      markTourComplete().catch(() => undefined);
    }
    // On a phone the drawer is closing, so nothing inside it can hold focus;
    // the Menu button that opens it is the sensible place. It is also inert
    // until the drawer has closed, so the focus waits a frame.
    const previous = returnFocusRef.current;
    const target = !isNarrow && previous?.isConnected ? previous : anchorElement(isNarrow ? 'nav-toggle' : 'profile-menu');
    returnFocusRef.current = null;
    window.clearTimeout(returnFocusTimerRef.current);
    returnFocusTimerRef.current = window.setTimeout(() => target?.focus(), FOCUS_SETTLE_MS);
    setState(IDLE_TOUR);
  }, [state, user, markTourComplete, setDrawerOpen, isNarrow]);

  useEffect(() => () => window.clearTimeout(returnFocusTimerRef.current), []);

  // Tab wraps within the card's controls, so it cannot reach the page behind.
  const onCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const controls = Array.from(cardRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []);
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === cardRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const position = step ? stepPosition(state, TOUR_STEPS, anchorPresent) : null;
  const announcement = step && position ? stepAnnouncement(step, position) : '';

  return (
    <>
      {/* Always present so assistive technology has it registered before the
          first step is announced into it. */}
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">{announcement}</div>
      {step && position && (
        <div className={motion.animate ? 'tour is-animated' : 'tour'}>
          <div className="tour-scrim" aria-hidden="true" />
          {targetRect && (
            <div
              className="tour-spotlight"
              aria-hidden="true"
              style={{
                top: targetRect.top - SPOTLIGHT_PADDING,
                left: targetRect.left - SPOTLIGHT_PADDING,
                width: targetRect.width + SPOTLIGHT_PADDING * 2,
                height: targetRect.height + SPOTLIGHT_PADDING * 2,
              }}
            />
          )}
          <div
            ref={cardRef}
            className={`tour-card is-${card.placement}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={bodyId}
            tabIndex={-1}
            style={card.placement === 'sheet' ? undefined : { top: card.top, left: card.left }}
            onKeyDown={onCardKeyDown}
          >
            <div className="tour-progress">
              <Icon name="tour" size={14} />
              Step {position.current} of {position.total}
            </div>
            <h2 id={titleId} className="tour-title">{step.title}</h2>
            <p id={bodyId} className="tour-body">{step.body}</p>
            <div className="tour-actions">
              <button type="button" className="btn sm secondary tour-skip" onClick={() => setState((current) => skipTour(current))}>
                <Icon name="close" size={14} />Skip tour
              </button>
              <span className="row tour-steps">
                {!isFirstStep(state, TOUR_STEPS, anchorPresent) && (
                  <button type="button" className="btn sm secondary" onClick={() => setState((current) => previousStep(current, TOUR_STEPS, anchorPresent))}>
                    <Icon name="arrow-left" size={14} />Back
                  </button>
                )}
                {isLastStep(state, TOUR_STEPS, anchorPresent) ? (
                  <button type="button" className="btn sm" onClick={() => setState((current) => nextStep(current, TOUR_STEPS, anchorPresent))}>
                    <Icon name="check" size={14} />Finish
                  </button>
                ) : (
                  <button type="button" className="btn sm" onClick={() => setState((current) => nextStep(current, TOUR_STEPS, anchorPresent))}>
                    Next<Icon name="arrow-right" size={14} />
                  </button>
                )}
              </span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
