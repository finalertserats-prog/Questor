import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { Icon } from './components/Icon';
import { ProfileMenu } from './components/ProfileMenu';
import { ProductTour } from './components/ProductTour';
import { TourProvider } from './components/tourContext';
import {
  brandDisplay,
  navItemTooltip,
  readSidebarMode,
  shellClassName,
  sidebarToggleLabel,
  toggleSidebarMode,
  writeSidebarMode,
  type SidebarMode,
} from './components/sidebarModel';
import { Login } from './pages/Login';
import { OrgLogin } from './pages/OrgLogin';
import { Dashboard } from './pages/Dashboard';
import { RoleCreate } from './pages/RoleCreate';
import { RoleDetail } from './pages/RoleDetail';
import { CandidateCreate } from './pages/CandidateCreate';
import { CandidatesList } from './pages/CandidatesList';
import { CandidateDetail } from './pages/CandidateDetail';
import { InterviewsList } from './pages/InterviewsList';
import { InterviewDetail } from './pages/InterviewDetail';
import { AssessmentView } from './pages/AssessmentView';
import BlindReview from './pages/BlindReview';
import { Admin } from './pages/Admin';
import { AuditLog } from './pages/AuditLog';
import { Portal } from './pages/Portal';
import { InterviewRoom } from './pages/InterviewRoom';
import { Settings } from './pages/Settings';
import { About } from './pages/About';
import { Contact } from './pages/Contact';
import { ObserveInterview } from './pages/ObserveInterview';

// Below this width the sidebar is an overlay drawer; above it, it is docked
// beside the page. Kept in step with the breakpoint in styles/sidebar.css.
// Matches sidebar.css exactly, fractional bound included: a viewport at 820.5px
// must be narrow for both, or the drawer and the docked sidebar disagree.
const NARROW_VIEWPORT = '(max-width: 820.98px)';

function narrowViewportQuery(): MediaQueryList | null {
  try {
    return window.matchMedia(NARROW_VIEWPORT);
  } catch {
    // No matchMedia (or it throws): assume the desktop, docked layout.
    return null;
  }
}

function useIsNarrowViewport(): boolean {
  const [isNarrow, setIsNarrow] = useState(() => narrowViewportQuery()?.matches ?? false);

  useEffect(() => {
    const query = narrowViewportQuery();
    if (!query) return undefined;
    setIsNarrow(query.matches);
    const onChange = (event: MediaQueryListEvent) => setIsNarrow(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return isNarrow;
}

function Layout({ children }: { children: React.ReactNode }) {
  // Two separate ideas. On a desktop the sidebar is docked beside the page and
  // open by default; the collapse control narrows it to an icon rail. On a
  // phone it is still a drawer, closed until asked for. Collapsible was never
  // meant to mean collapsed.
  const isNarrow = useIsNarrowViewport();
  const [navOpen, setNavOpen] = useState(false);
  const [mode, setMode] = useState<SidebarMode>(() => readSidebarMode());
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const railToggleRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  // Mirrors navOpen for the breakpoint effect below, which must not re-run every
  // time the drawer opens or closes.
  const navOpenRef = useRef(false);
  // Set when the user closes the drawer themselves, so focus returns to the
  // toggle — but only after the toggle stops being inert.
  const restoreFocusRef = useRef(false);
  const location = useLocation();

  // Only the drawer overlays anything. Docked, the sidebar sits beside the
  // content, so there is no backdrop and nothing is made inert.
  const overlayOpen = isNarrow && navOpen;
  // A rail is a desktop idea: the drawer always shows its labels in full.
  const railMode: SidebarMode = isNarrow ? 'expanded' : mode;

  // While the drawer is open, the page behind it is inert: keyboard focus and
  // clicks stay inside the drawer instead of wandering into hidden content.
  useEffect(() => {
    mainRef.current?.toggleAttribute('inert', overlayOpen);
    toggleRef.current?.toggleAttribute('inert', overlayOpen);
    if (!overlayOpen && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      toggleRef.current?.focus();
    }
  }, [overlayOpen]);

  useEffect(() => { navOpenRef.current = navOpen; }, [navOpen]);

  // Crossing the breakpoint ends the errand the drawer was opened for. Without
  // this the flag outlives the drawer: widen the window and it disappears,
  // narrow it again — rotate a tablet, restore a window — and it springs open
  // on its own, making the page inert and pulling focus out of whatever the
  // person was doing. Focus is handed over deliberately too, because the close
  // button it was sitting on is display:none once docked, and focus would
  // otherwise fall to the document.
  useEffect(() => {
    if (!navOpenRef.current) return;
    restoreFocusRef.current = false;
    setNavOpen(false);
    if (!isNarrow) railToggleRef.current?.focus();
  }, [isNarrow]);

  // Following a link is the end of the errand the drawer was opened for.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!overlayOpen) return undefined;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      // The profile menu handles Escape first (capture phase) and marks it, so
      // one press closes only the innermost layer.
      if (event.key === 'Escape' && !event.defaultPrevented) {
        restoreFocusRef.current = true;
        setNavOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [overlayOpen]);

  const closeNav = () => {
    restoreFocusRef.current = true;
    setNavOpen(false);
  };

  // The choice outlives the reload; a storage that refuses is not an error.
  const toggleRail = () => {
    const next = toggleSidebarMode(mode);
    setMode(next);
    writeSidebarMode(next);
  };

  const brand = brandDisplay(railMode);
  const tip = (label: string) => navItemTooltip(railMode, label);

  return (
    <div className={shellClassName(railMode)}>
      <button
        ref={toggleRef}
        type="button"
        className="nav-toggle"
        data-tour="nav-toggle"
        aria-controls="app-sidebar"
        aria-expanded={overlayOpen}
        onClick={() => setNavOpen(true)}
      >
        <Icon name="menu" />
        <span>Menu</span>
      </button>

      {overlayOpen && <button type="button" className="nav-backdrop" aria-label="Close menu" tabIndex={-1} onClick={closeNav} />}

      <aside id="app-sidebar" className={overlayOpen ? 'sidebar is-open' : 'sidebar'} aria-label="Main navigation">
        <button ref={closeRef} type="button" className="nav-close" aria-label="Close menu" onClick={closeNav}>
          <Icon name="close" />
        </button>
        <div>
          <div className="sidebar-head">
            {/* Collapsing narrows the sidebar; it does not take the product's
                name off the screen. In the rail the wordmark is simply set
                smaller, above the icons it names. */}
            <div className={brand.className} title={brand.label}>
              {/* The mark carries no meaning the name does not: it is decorative
                  here, and the name beside it is the accessible label. */}
              <img className="logo-mark" src="/brand/questor-mark.webp" alt="" width={26} height={27} />
              <span className="logo-text">{brand.lead}<span>{brand.tail}</span></span>
            </div>
            <button
              ref={railToggleRef}
              type="button"
              className="rail-toggle"
              aria-controls="app-sidebar"
              // Not aria-expanded: the navigation is never hidden here, only
              // narrowed, and "collapsed" would tell a screen reader the links
              // are gone while every one of them is still focusable.
              aria-pressed={railMode === 'collapsed'}
              aria-label={sidebarToggleLabel(railMode)}
              title={sidebarToggleLabel(railMode)}
              onClick={toggleRail}
            >
              <Icon name={railMode === 'collapsed' ? 'sidebar-expand' : 'sidebar-collapse'} />
            </button>
          </div>
          {/* The ticked rule is the instrument's edge; it recurs under every
              page title, which is what ties the console together. */}
          <div className="brand-line" aria-hidden="true" />
          <div className="small muted sidebar-tagline" style={{ marginTop: 8 }}>Hire through evidence</div>
        </div>
        {/* Grouped by cadence, not by entity: the top group is the daily
            reviewing loop, the bottom is what you set up once. The admin console
            lives in the profile menu, beside the other account-level pages.

            Each label stays in the markup in both states: in the rail it is
            clipped rather than removed, so every icon keeps its name for a
            screen reader, and data-tip shows that name on hover and on focus.

            data-tour is what the guided tour points at (components/tourModel.ts):
            an explicit anchor, so moving the markup cannot silently strand a step. */}
        <nav>
          <div className="nav-group">Review</div>
          <NavLink to="/" end data-tip={tip('Dashboard')} data-tour="nav-dashboard"><Icon name="dashboard" /><span className="nav-label">Dashboard</span></NavLink>
          {/* Candidates sits above "Add Candidate" because finding an existing
              one is the far more frequent errand — and for a long time it was
              the impossible one: creation had a nav entry, retrieval had none. */}
          <NavLink to="/candidates" end data-tip={tip('Candidates')} data-tour="nav-candidates"><Icon name="candidates" /><span className="nav-label">Candidates</span></NavLink>
          <NavLink to="/interviews" data-tip={tip('Interviews')} data-tour="nav-interviews"><Icon name="interviews" /><span className="nav-label">Interviews</span></NavLink>

          <div className="nav-group">Set up</div>
          <NavLink to="/candidates/new" data-tip={tip('Add candidate')} data-tour="nav-add-candidate"><Icon name="add-candidate" /><span className="nav-label">Add candidate</span></NavLink>
          <NavLink to="/roles/new" data-tip={tip('New role')} data-tour="nav-new-role"><Icon name="role" /><span className="nav-label">New role</span></NavLink>
        </nav>
        <ProfileMenu />
      </aside>

      <main ref={mainRef} className="main">{children}</main>

      {/* Outside <main>, which is inert while the drawer is open: a tour step
          that opens the drawer to point into it must stay reachable itself. */}
      <ProductTour isNarrow={isNarrow} setDrawerOpen={setNavOpen} />
    </div>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="center-screen muted">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
}

/**
 * Readable without an account.
 *
 * Someone deciding whether to use Questor should be able to read what it is,
 * what it will not do and who it serves without signing in first — and the
 * sign-in page stays light because this page exists. Signed in, it sits inside
 * the console like every other page rather than becoming a second front door.
 */
function PublicOrApp({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="center-screen muted">Loading…</div>;
  if (user) return <Layout>{children}</Layout>;
  return (
    <div className="public-shell">
      <header className="public-bar">
        <Link to="/login" className="public-brand">
          <img src="/brand/questor-mark.webp" alt="" width={26} height={27} />
          <span>Questor</span>
        </Link>
        <Link to="/login" className="btn sm">Sign in</Link>
      </header>
      <main className="public-body">{children}</main>
    </div>
  );
}

export function App() {
  return (
    <TourProvider>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/o/:slug" element={<OrgLogin />} />
      <Route path="/portal/:token" element={<Portal />} />
      <Route path="/room/:token" element={<InterviewRoom />} />
      <Route path="/" element={<Protected><Dashboard /></Protected>} />
      <Route path="/roles/new" element={<Protected><RoleCreate /></Protected>} />
      <Route path="/roles/:id" element={<Protected><RoleDetail /></Protected>} />
      <Route path="/candidates" element={<Protected><CandidatesList /></Protected>} />
      <Route path="/candidates/new" element={<Protected><CandidateCreate /></Protected>} />
      <Route path="/candidates/:id" element={<Protected><CandidateDetail /></Protected>} />
      <Route path="/interviews" element={<Protected><InterviewsList /></Protected>} />
      <Route path="/interviews/:id" element={<Protected><InterviewDetail /></Protected>} />
      <Route path="/interviews/:id/observe" element={<Protected><ObserveInterview /></Protected>} />
      <Route path="/assessments/:id" element={<Protected><AssessmentView /></Protected>} />
      {/* Declared before nothing else claims it; the blind view is a distinct
          surface from the full assessment precisely so a reviewer cannot land on
          the score by accident. */}
      <Route path="/assessments/:id/review" element={<Protected><BlindReview /></Protected>} />
      <Route path="/admin" element={<Protected><Admin /></Protected>} />
      <Route path="/audit" element={<Protected><AuditLog /></Protected>} />
      <Route path="/settings" element={<Protected><Settings /></Protected>} />
      <Route path="/about" element={<PublicOrApp><About /></PublicOrApp>} />
      <Route path="/contact" element={<Protected><Contact /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </TourProvider>
  );
}
