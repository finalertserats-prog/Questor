import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { useTour } from './tourContext';
import { anchorElement, anchorPresent, TourOverlay } from './TourOverlay';
import { DASHBOARD_TAB, onDashboardTab } from './hrbox/landingTabModel';
import { IDLE_TOUR, TOUR_STEPS, restartTour, shouldAutoStartTour, tourHasEnded, type TourState } from './tourModel';

// Long enough for the drawer to have closed and the page behind it to have
// stopped being inert, short enough not to be noticed.
const FOCUS_SETTLE_MS = 50;

interface ProductTourProps {
  /** Below the sidebar breakpoint, where the sidebar is a drawer. */
  readonly isNarrow: boolean;
  /** Opens or closes that drawer, for steps that point into it. */
  readonly setDrawerOpen: (open: boolean) => void;
}

/**
 * The guided product tour for a signed-in user: the steps in tourModel, shown
 * by TourOverlay. This decides when it runs and what its ending means.
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

  const [state, setState] = useState<TourState>(IDLE_TOUR);
  // Where focus goes back to when the tour ends.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // The automatic first run happens once per session even if recording it fails.
  const autoStartedRef = useRef(false);
  const handledRequestRef = useRef(0);
  const returnFocusTimerRef = useRef<number | undefined>(undefined);

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

  return (
    <TourOverlay
      steps={TOUR_STEPS}
      state={state}
      setState={setState}
      present={anchorPresent}
      isNarrow={isNarrow}
      setDrawerOpen={setDrawerOpen}
    />
  );
}
