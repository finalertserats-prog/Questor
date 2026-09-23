import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api/client';
import { Link, Navigate, Route, Routes, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { Icon } from './components/Icon';
import { BrandLogo } from './components/BrandLogo';
import { ProfileMenu } from './components/ProfileMenu';
import { ProductTour } from './components/ProductTour';
import { TourProvider } from './components/tourContext';
import { demoHasEnded, formatDemoCountdown, isFinalDemoMinute } from './components/demoModel';
import {
  brandDisplay,
  navItemTooltip,
  pageTitleFor,
  RAIL_TRANSITION_MS,
  readSidebarMode,
  shellClassName,
  sidebarToggleLabel,
  toggleSidebarMode,
  railToggleTurned,
  writeSidebarMode,
  type SidebarMode,
} from './components/sidebarModel';
import { Login } from './pages/Login';
import { OrgLogin } from './pages/OrgLogin';
import { Signup } from './pages/Signup';
import { ForgotPassword } from './pages/ForgotPassword';
import { ResetPassword } from './pages/ResetPassword';
import { TeamUsers } from './pages/TeamUsers';
import { SignupDecision } from './pages/SignupDecision';
import { DemoRequest } from './pages/DemoRequest';
import { DemoEnded, DemoRedeem } from './pages/DemoRedeem';
import { DemoDecision } from './pages/DemoDecision';
import { SignupQueue } from './pages/SignupQueue';
import { Onboard } from './pages/Onboard';
import { Landing } from './pages/Landing';
import { NeedsYouBell, useNeedsYouCount } from './components/hrbox/NeedsYouBell';
import { RoleCreate } from './pages/RoleCreate';
import { RoleDetail } from './pages/RoleDetail';
import { RolesList } from './pages/RolesList';
import { CandidateCreate } from './pages/CandidateCreate';
import { CandidateImport } from './pages/CandidateImport';
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
import { TalkToAPerson } from './pages/TalkToAPerson';
import { ObserverRoom } from './pages/ObserverRoom';
import { ObserverConsent } from './pages/ObserverConsent';
import { FeedbackConsent } from './pages/FeedbackConsent';
import { CatalogReview } from './pages/CatalogReview';
import { LibraryAdmin } from './pages/LibraryAdmin';
import { can, onlyWhoCan } from './components/capabilityModel';
import { canManageAdmin } from './components/profileMenuModel';
import { EmptyState } from './components/EmptyState';
import { ErrorBoundary } from './components/ErrorBoundary';
import { isPublicPath } from './components/errorBoundaryModel';

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

/**
 * The demo's own bar: time left, the way into the sample interview as its
 * candidate, and an end that ends it on the server, not only in this tab.
 */
function DemoBanner({ endsAt }: { endsAt: string }) {
  const [now, setNow] = useState(Date.now());
  const [interviewError, setInterviewError] = useState('');
  const [confirmEnd, setConfirmEnd] = useState(false);
  // The clock ticks every second; without this the expiry effect posted
  // /demo/end on every tick until the page finally navigated away.
  const endingRef = useRef(false);
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(id); }, []);
  const endDemo = useCallback(async () => {
    if (endingRef.current) return;
    endingRef.current = true;
    try { await api.post('/demo/end', {}); } catch { /* the session is ending either way */ }
    window.location.assign('/demo/ended');
  }, []);
  useEffect(() => { if (demoHasEnded(endsAt, now)) void endDemo(); }, [endsAt, now, endDemo]);
  const remainingMs = Date.parse(endsAt) - now;
  const openInterview = async () => {
    setInterviewError('');
    // Opened before the request so the browser treats it as a click, not a pop-up.
    const tab = window.open('', '_blank');
    // The portal must not be able to reach back into this console.
    if (tab) tab.opener = null;
    try {
      const { portalUrl } = await api.get<{ portalUrl: string }>('/demo/interview');
      if (tab) tab.location.href = portalUrl; else window.location.assign(portalUrl);
    } catch (err: unknown) {
      tab?.close();
      setInterviewError(err instanceof Error ? err.message : 'The sample interview could not be opened.');
    }
  };
  return (
    // Not a live region itself: a countdown announced every second drowns out
    // everything else a screen reader has to say. Only the final minute and
    // errors are announced.
    <div className="banner" style={{ borderRadius: 0, margin: 0, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
      <span>Demo · ends in {formatDemoCountdown(remainingMs)}</span>
      <span className="visually-hidden" role="status">{isFinalDemoMinute(remainingMs) ? 'Less than a minute of the demo is left.' : ''}</span>
      <button type="button" className="btn sm" onClick={() => void openInterview()}>Try the interview as the candidate</button>
      {confirmEnd ? (
        <>
          <span className="small">End the demo and sign out?</span>
          <button type="button" className="btn sm secondary" onClick={() => void endDemo()}>Yes, end demo</button>
          <button type="button" className="btn sm ghost" onClick={() => setConfirmEnd(false)}>Keep going</button>
        </>
      ) : (
        <button type="button" className="btn sm secondary" onClick={() => setConfirmEnd(true)}>End demo</button>
      )}
      {interviewError && <span className="small" role="alert">{interviewError}</span>}
    </div>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  // Two separate ideas. On a desktop the sidebar is docked beside the page and
  // open by default; the collapse control narrows it to an icon rail. On a
  // phone it is still a drawer, closed until asked for. Collapsible was never
  // meant to mean collapsed.
  const { tenant, user } = useAuth();
  const isNarrow = useIsNarrowViewport();
  const [navOpen, setNavOpen] = useState(false);
  const [mode, setMode] = useState<SidebarMode>(() => readSidebarMode());
  // True only just after the rail is toggled; the width transition is scoped to it.
  const [railAnimating, setRailAnimating] = useState(false);
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
    setRailAnimating(true);
  };

  // A timer rather than transitionend: with reduced motion there is no
  // transition to end, and the class must still come off.
  useEffect(() => {
    if (!railAnimating) return undefined;
    const timer = window.setTimeout(() => setRailAnimating(false), RAIL_TRANSITION_MS + 60);
    return () => window.clearTimeout(timer);
  }, [railAnimating, mode]);

  // The bell counts what waits on this user; someone who cannot read candidates
  // (an auditor) has no queue, so no bell.
  const mayReadCandidates = can(user, 'candidate:read');
  const needsYouTotal = useNeedsYouCount(mayReadCandidates);

  const brand = brandDisplay(railMode);
  const tip = (label: string) => navItemTooltip(railMode, label);

  return (
    <div className={shellClassName(railMode, railAnimating)}>
      {/* The narrow-viewport top bar. It is in the page's flow and reserves its
          own height, so nothing it carries can sit on top of the page beneath
          it; sticky, so the way into the menu stays reachable once scrolled.
          Above the page, below the drawer, the tour and the toasts. Hidden
          entirely on a wide viewport, where the sidebar is docked. The title
          is a visual wayfinder for a bar that outlives the page heading, and
          is hidden from screen readers because the page's own <h1> is the
          heading they already have. */}
      <header className="nav-bar">
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
        <span className="nav-bar-title" aria-hidden="true">{pageTitleFor(location.pathname)}</span>
        {mayReadCandidates && <NeedsYouBell total={needsYouTotal} className="hb-bell--top" />}
      </header>

      {overlayOpen && <button type="button" className="nav-backdrop" aria-label="Close menu" tabIndex={-1} onClick={closeNav} />}

      <aside id="app-sidebar" className={overlayOpen ? 'sidebar is-open' : 'sidebar'} aria-label="Main navigation">
        {/* The aside is the full-height column that carries the background and
            the edge rule; this inner box is what stays pinned to the viewport.
            Pinning the aside itself stopped its background at the first
            screenful and left a bare strip under it on a long page. */}
        <div className="sidebar-inner">
          <button ref={closeRef} type="button" className="nav-close" aria-label="Close menu" onClick={closeNav}>
            <Icon name="close" />
          </button>
          <div>
            <div className="sidebar-head">
              {/* Collapsing narrows the sidebar; it does not take the product's
                  name off the screen. In the rail the wordmark is simply set
                  smaller, above the icons it names. */}
              <div className={brand.className} title={brand.label}>
                {/* Expanded, the lockup draws the name and is its accessible
                    label. In the rail the mark alone is decorative and the name
                    beside it, set in text, is the label. */}
                {brand.artwork === 'lockup'
                  ? <BrandLogo variant="lockup" size={28} className="logo-lockup" />
                  : <BrandLogo variant="mark" size={30} decorative className="logo-mark" />}
                {brand.showText && <span className="logo-text">{brand.lead}<span>{brand.tail}</span></span>}
              </div>
              <div className="hb-head-actions">
              {mayReadCandidates && <NeedsYouBell total={needsYouTotal} className="hb-bell--side" />}
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
                <Icon name="sidebar-collapse" className={`rail-toggle-icon${railToggleTurned(railMode) ? ' is-turned' : ''}`} />
              </button>
              </div>
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
            <NavLink to="/" end data-tip={tip('Home')} data-tour="nav-dashboard"><Icon name="dashboard" /><span className="nav-label">Home</span></NavLink>
            {/* Candidates sits above "Add Candidate" because finding an existing
                one is the far more frequent errand — and for a long time it was
                the impossible one: creation had a nav entry, retrieval had none. */}
            {/* Each entry only for someone its page's API lets in (an auditor
                holds audit:read alone); the tour skips an anchor that is absent. */}
            {can(user, 'candidate:read') && <NavLink to="/candidates" end data-tip={tip('Candidates')} data-tour="nav-candidates"><Icon name="candidates" /><span className="nav-label">Candidates</span></NavLink>}
            {can(user, 'role:read') && <NavLink to="/roles" end data-tip={tip('Roles')} data-tour="nav-roles"><Icon name="role" /><span className="nav-label">Roles</span></NavLink>}
            {can(user, 'candidate:read') && <NavLink to="/interviews" data-tip={tip('Interviews')} data-tour="nav-interviews"><Icon name="interviews" /><span className="nav-label">Interviews</span></NavLink>}

            {(can(user, 'candidate:create') || can(user, 'role:create')) && <div className="nav-group">Set up</div>}
            {can(user, 'candidate:create') && <NavLink to="/candidates/new" data-tip={tip('Add candidate')} data-tour="nav-add-candidate"><Icon name="resume-upload" /><span className="nav-label">Add candidate</span></NavLink>}
            {can(user, 'role:create') && <NavLink to="/roles/new" data-tip={tip('New role')} data-tour="nav-new-role"><Icon name="job-description" /><span className="nav-label">New role</span></NavLink>}
          </nav>
          <ProfileMenu />
        </div>
      </aside>

      <main ref={mainRef} className="main">
        {tenant?.isDemo && tenant.sessionEndsAt && <DemoBanner endsAt={tenant.sessionEndsAt} />}
        {/* Per page, inside the shell: a page that throws keeps the sidebar and
            every other page reachable. Keyed by the address so leaving clears it. */}
        <ErrorBoundary scope="page" resetKey={location.pathname}>{children}</ErrorBoundary>
      </main>

      {/* Outside <main>, which is inert while the drawer is open: a tour step
          that opens the drawer to point into it must stay reachable itself. */}
      <ProductTour isNarrow={isNarrow} setDrawerOpen={setNavOpen} />
    </div>
  );
}

/**
 * Shown when the session check failed for a reason that is not "signed out".
 *
 * The session is still standing — the server simply could not be reached or
 * answered with a fault — so the way out is to ask again, not to send someone
 * to the login page and lose whatever they were in the middle of.
 */
function SessionRetry({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="center-screen">
      <div className="banner error" style={{ maxWidth: 480 }}>
        <div>We could not confirm your sign-in. {message}</div>
        <div className="small muted" style={{ marginTop: 6 }}>You are still signed in; this is a problem reaching the server.</div>
        <button type="button" className="btn sm" style={{ marginTop: 10 }} onClick={onRetry}>Try again</button>
      </div>
    </div>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  const { user, tenant, loading, loadError, retrySession } = useAuth();
  if (loading) return <div className="center-screen muted">Loading…</div>;
  if (!user && loadError) return <SessionRetry message={loadError} onRetry={retrySession} />;
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
          {/* The lockup draws the name; its alt text is the link's name. */}
          <BrandLogo variant="lockup" size={28} />
        </Link>
        <Link to="/login" className="btn sm">Sign in</Link>
      </header>
      <main className="public-body">{children}</main>
    </div>
  );
}

/**
 * Around every route, including the candidate-facing ones that have no shell:
 * a fault there shows a way forward rather than a blank page. A candidate has
 * no dashboard, so their pages offer only "Try again".
 */
/**
 * A landmark around a page that has no shell to give it one.
 *
 * Every page a candidate, an applicant or an operator-with-a-link sees is
 * rendered on its own, outside the signed-in Layout -- and so none of them had
 * a `main`. axe reported `landmark-one-main` on 43 screens and `region` on 45,
 * 1,080 observations between them, and what that means in use is that a screen
 * reader offers no way to skip past the furniture to the content on any page a
 * candidate ever reaches.
 *
 * It sits at the route rather than inside each page because these pages return
 * a different tree per phase -- loading, open, decided, expired, refused -- and
 * a landmark that depends on which branch rendered is a landmark that goes
 * missing exactly when someone is lost. Unstyled on purpose: <main> is a block
 * box like the <div> each page roots itself in, so nothing moves.
 *
 * Pages that already carry their own <main> (the demo pages, the portal, the
 * candidate's status page) are not wrapped: two of them would be no landmark
 * at all.
 */
function CandidatePage({ children }: { children: React.ReactNode }) {
  return <main>{children}</main>;
}

/**
 * The admin console, refused at the door.
 *
 * The /admin addresses were not gated here at all: any signed-in user could
 * open one, and the console asked for connectors, model executions and
 * webhooks before its own role check could send them away -- so the sweep
 * watched a recruiter's page fire three requests it knew would be refused and
 * counted the 403s. The server held, which is the part that matters, but
 * asking a question whose answer is "no" is not a way to find out.
 *
 * Now the route decides, before the console mounts: one sentence saying who
 * this is for, and no request at all.
 */
function AdminOnly({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  if (!user) return null;
  // The role, not the capability list. `can` deliberately answers true when a
  // server sends no list, so that an older server decides for itself -- which
  // is the right default for hiding a button and the wrong one for a door.
  // This is the check the console itself already made, moved to where the
  // router can see it.
  if (canManageAdmin(user.role)) return <>{children}</>;
  return (
    <EmptyState
      heading="page"
      icon="lock"
      title="Admin console"
      message={onlyWhoCan('admin:manage', 'open the admin console')}
      action={<Link className="btn secondary" to="/"><Icon name="arrow-left" size={16} />Back to Home</Link>}
    />
  );
}

function RouteBoundary({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  return <ErrorBoundary scope="page" resetKey={pathname} homeHref={isPublicPath(pathname) ? null : '/'}>{children}</ErrorBoundary>;
}

export function App() {
  return (
    <TourProvider>
    <RouteBoundary>
    <Routes>
      <Route path="/login" element={<CandidatePage><Login /></CandidatePage>} />
      <Route path="/o/:slug" element={<CandidatePage><OrgLogin /></CandidatePage>} />
      {/* Both unauthenticated, for the same reason from two directions: someone
          asking for an account has none to sign in with, and the operator's
          emailed link carries its own credential in the token — putting the
          decision behind a session would gate granting access on having it. */}
      {/* Recovery is public by necessity: the person reaching it cannot sign
          in. Neither page names anyone — the confirmation is the same sentence
          whether or not the address has an account, and the token lives in the
          URL fragment, which a browser never sends to a server. */}
      <Route path="/forgot-password" element={<CandidatePage><ForgotPassword /></CandidatePage>} />
      <Route path="/reset-password" element={<CandidatePage><ResetPassword /></CandidatePage>} />
      <Route path="/signup" element={<CandidatePage><Signup /></CandidatePage>} />
      <Route path="/onboard" element={<CandidatePage><Onboard /></CandidatePage>} />
      <Route path="/signup/decision/:token" element={<CandidatePage><SignupDecision /></CandidatePage>} />
      <Route path="/demo" element={<DemoRequest />} />
      <Route path="/demo/ended" element={<DemoEnded />} />
      <Route path="/demo/:token" element={<DemoRedeem />} />
      <Route path="/demo/decision/:token" element={<CandidatePage><DemoDecision /></CandidatePage>} />
      <Route path="/portal/:token" element={<Portal />} />
      <Route path="/room/:token" element={<CandidatePage><InterviewRoom /></CandidatePage>} />
      {/* Followed from a feedback email. Unauthenticated by design: asking to
          speak to a person must not require making an account. */}
      <Route path="/talk-to-a-person/:token" element={<CandidatePage><TalkToAPerson /></CandidatePage>} />
      <Route path="/observer-consent/:token" element={<CandidatePage><ObserverConsent /></CandidatePage>} />
      <Route path="/rounds/:roundId/observer" element={<Protected><ObserverRoom /></Protected>} />
      {/* Followed from a recruiter's "would you like feedback?" email; answering
          must not require an account. */}
      <Route path="/feedback-consent/:token" element={<CandidatePage><FeedbackConsent /></CandidatePage>} />
      {/* Home (HR-Box) and Dashboard, as sub-tabs: ?tab=home|dashboard. */}
      <Route path="/" element={<Protected><Landing /></Protected>} />
      <Route path="/roles" element={<Protected><RolesList /></Protected>} />
      <Route path="/roles/new" element={<Protected><RoleCreate /></Protected>} />
      <Route path="/roles/:id" element={<Protected><RoleDetail /></Protected>} />
      <Route path="/candidates" element={<Protected><CandidatesList /></Protected>} />
      <Route path="/candidates/new" element={<Protected><CandidateCreate /></Protected>} />
      <Route path="/candidates/import" element={<Protected><CandidateImport /></Protected>} />
      <Route path="/candidates/:id" element={<Protected><CandidateDetail /></Protected>} />
      <Route path="/interviews" element={<Protected><InterviewsList /></Protected>} />
      <Route path="/interviews/:id" element={<Protected><InterviewDetail /></Protected>} />
      <Route path="/interviews/:id/observe" element={<Protected><ObserveInterview /></Protected>} />
      <Route path="/assessments/:id" element={<Protected><AssessmentView /></Protected>} />
      {/* The assessment's three readings are addressable: /ai and /differences
          open on that tab, and the plain address opens on the human review. */}
      <Route path="/assessments/:id/human" element={<Protected><AssessmentView /></Protected>} />
      <Route path="/assessments/:id/ai" element={<Protected><AssessmentView /></Protected>} />
      <Route path="/assessments/:id/differences" element={<Protected><AssessmentView /></Protected>} />
      {/* Declared before nothing else claims it; the blind view is a distinct
          surface from the full assessment precisely so a reviewer cannot land on
          the score by accident. */}
      <Route path="/assessments/:id/review" element={<Protected><BlindReview /></Protected>} />
      {/* The platform owner's queue; the page itself refuses anyone else, as the API does. */}
      <Route path="/catalog-review" element={<Protected><CatalogReview /></Protected>} />
      <Route path="/library-admin" element={<Protected><LibraryAdmin /></Protected>} />
      <Route path="/admin" element={<Protected><AdminOnly><Admin /></AdminOnly></Protected>} />
      {/* Before /admin/:tab, which would otherwise swallow it. */}
      <Route path="/admin/users" element={<Protected><AdminOnly><TeamUsers /></AdminOnly></Protected>} />
      <Route path="/admin/signups" element={<Protected><AdminOnly><SignupQueue /></AdminOnly></Protected>} />
      {/* The console's sub-tabs; /admin itself is the System health tab. */}
      <Route path="/admin/:tab" element={<Protected><AdminOnly><Admin /></AdminOnly></Protected>} />
      <Route path="/audit" element={<Protected><AuditLog /></Protected>} />
      <Route path="/settings" element={<Protected><Settings /></Protected>} />
      <Route path="/about" element={<PublicOrApp><About /></PublicOrApp>} />
      <Route path="/contact" element={<Protected><Contact /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </RouteBoundary>
    </TourProvider>
  );
}
