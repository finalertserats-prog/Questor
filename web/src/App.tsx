import { Navigate, Route, Routes, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';
import { ThemeToggle } from './components/theme';
import { Login } from './pages/Login';
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

function Layout({ children }: { children: React.ReactNode }) {
  const { user, tenant, logout } = useAuth();
  const nav = useNavigate();
  return (
    <div className="app">
      <aside className="sidebar">
        <div>
          <div className="logo">QUES<span>TOR</span></div>
          {/* The ticked rule is the instrument's edge; it recurs under every
              page title, which is what ties the console together. */}
          <div className="brand-line" aria-hidden="true" />
          <div className="small muted" style={{ marginTop: 8 }}>First-round interview screening</div>
        </div>
        {/* Grouped by cadence, not by entity: the top group is the daily
            reviewing loop, the bottom is what you set up once. The old flat
            list gave a connector settings page the same weight as the
            candidate queue. */}
        <nav>
          <div className="nav-group">Review</div>
          <NavLink to="/" end>Dashboard</NavLink>
          {/* Candidates sits above "Add Candidate" because finding an existing
              one is the far more frequent errand — and for a long time it was
              the impossible one: creation had a nav entry, retrieval had none. */}
          <NavLink to="/candidates" end>Candidates</NavLink>
          <NavLink to="/interviews">Interviews</NavLink>

          <div className="nav-group">Set up</div>
          <NavLink to="/candidates/new">Add candidate</NavLink>
          <NavLink to="/roles/new">New role</NavLink>
          <NavLink to="/admin">Admin &amp; connectors</NavLink>
        </nav>
        <div className="foot small muted">
          <div className="who">{user?.name}</div>
          <div>{tenant?.name}</div>
          <ThemeToggle />
          <a onClick={() => { logout(); nav('/login'); }} style={{ cursor: 'pointer' }}>Sign out</a>
        </div>
      </aside>
      <main className="main">{children}</main>
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
      <Route path="/assessments/:id" element={<Protected><AssessmentView /></Protected>} />
      {/* Declared before nothing else claims it; the blind view is a distinct
          surface from the full assessment precisely so a reviewer cannot land on
          the score by accident. */}
      <Route path="/assessments/:id/review" element={<Protected><BlindReview /></Protected>} />
      <Route path="/admin" element={<Protected><Admin /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
