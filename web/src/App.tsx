import { useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { Icon } from './components/Icon';
import { ProfileMenu } from './components/ProfileMenu';
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
import { Portal } from './pages/Portal';
import { InterviewRoom } from './pages/InterviewRoom';
import { Settings } from './pages/Settings';
import { About } from './pages/About';
import { Contact } from './pages/Contact';
import { ObserveInterview } from './pages/ObserveInterview';

function Layout({ children }: { children: React.ReactNode }) {
  // The sidebar is a drawer: hidden until asked for, so pages get the full width.
  const [navOpen, setNavOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  // Set when the user closes the drawer themselves, so focus returns to the
  // toggle — but only after the toggle stops being inert.
  const restoreFocusRef = useRef(false);
  const location = useLocation();

  // While the drawer is open, the page behind it is inert: keyboard focus and
  // clicks stay inside the drawer instead of wandering into hidden content.
  useEffect(() => {
    mainRef.current?.toggleAttribute('inert', navOpen);
    toggleRef.current?.toggleAttribute('inert', navOpen);
    if (!navOpen && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      toggleRef.current?.focus();
    }
  }, [navOpen]);

  // Following a link is the end of the errand the drawer was opened for.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!navOpen) return undefined;
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
  }, [navOpen]);

  const closeNav = () => {
    restoreFocusRef.current = true;
    setNavOpen(false);
  };

  return (
    <div className="app">
      <button
        ref={toggleRef}
        type="button"
        className="nav-toggle"
        aria-controls="app-sidebar"
        aria-expanded={navOpen}
        onClick={() => setNavOpen(true)}
      >
        <Icon name="menu" />
        <span>Menu</span>
      </button>

      {navOpen && <button type="button" className="nav-backdrop" aria-label="Close menu" tabIndex={-1} onClick={closeNav} />}

      <aside id="app-sidebar" className={navOpen ? 'sidebar is-open' : 'sidebar'} aria-label="Main navigation">
        <button ref={closeRef} type="button" className="nav-close" aria-label="Close menu" onClick={closeNav}>
          <Icon name="close" />
        </button>
        <div>
          <div className="logo">QUES<span>TOR</span></div>
          {/* The ticked rule is the instrument's edge; it recurs under every
              page title, which is what ties the console together. */}
          <div className="brand-line" aria-hidden="true" />
          <div className="small muted" style={{ marginTop: 8 }}>Hire through evidence</div>
        </div>
        {/* Grouped by cadence, not by entity: the top group is the daily
            reviewing loop, the bottom is what you set up once. The admin console
            lives in the profile menu, beside the other account-level pages. */}
        <nav>
          <div className="nav-group">Review</div>
          <NavLink to="/" end><Icon name="dashboard" /><span>Dashboard</span></NavLink>
          {/* Candidates sits above "Add Candidate" because finding an existing
              one is the far more frequent errand — and for a long time it was
              the impossible one: creation had a nav entry, retrieval had none. */}
          <NavLink to="/candidates" end><Icon name="candidates" /><span>Candidates</span></NavLink>
          <NavLink to="/interviews"><Icon name="interviews" /><span>Interviews</span></NavLink>

          <div className="nav-group">Set up</div>
          <NavLink to="/candidates/new"><Icon name="add-candidate" /><span>Add candidate</span></NavLink>
          <NavLink to="/roles/new"><Icon name="role" /><span>New role</span></NavLink>
        </nav>
        <ProfileMenu />
      </aside>

      <main ref={mainRef} className="main">{children}</main>
    </div>
  );
}

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="center-screen muted">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
}

export function App() {
  return (
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
      <Route path="/settings" element={<Protected><Settings /></Protected>} />
      <Route path="/about" element={<Protected><About /></Protected>} />
      <Route path="/contact" element={<Protected><Contact /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
