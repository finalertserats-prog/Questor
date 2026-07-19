import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Banner } from '../components/ui';

export function Login() {
  const { login, register, user } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('demo@questor.local');
  const [password, setPassword] = useState('questor123');
  const [name, setName] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (user) nav('/'); }, [user, nav]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register({ email, password, name, tenantName });
      nav('/');
    } catch (e: any) {
      setErr(e.message || 'Failed');
    } finally { setBusy(false); }
  };

  return (
    <div className="center-screen">
      <form className="card auth-card" onSubmit={submit}>
        <div className="logo" style={{ fontSize: 26, fontWeight: 800 }}>QUES<span style={{ color: 'var(--brand)' }}>TOR</span></div>
        <div className="muted small" style={{ marginBottom: 16 }}>Autonomous AI First-Round Interview Agent</div>
        {err && <Banner kind="error">{err}</Banner>}
        {mode === 'register' && (
          <>
            <label>Your name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
            <label>Organization name</label>
            <input value={tenantName} onChange={(e) => setTenantName(e.target.value)} placeholder="Acme Corp" />
          </>
        )}
        <label>Email</label>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button className="btn" style={{ width: '100%', marginTop: 18 }} disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        <div className="small muted" style={{ marginTop: 14, textAlign: 'center' }}>
          {mode === 'login' ? (
            <>No account? <a onClick={() => setMode('register')} style={{ cursor: 'pointer' }}>Register</a></>
          ) : (
            <>Have an account? <a onClick={() => setMode('login')} style={{ cursor: 'pointer' }}>Sign in</a></>
          )}
        </div>
        {mode === 'login' && <div className="small muted" style={{ marginTop: 10, textAlign: 'center' }}>Demo: demo@questor.local / questor123 (run <code>npm run db:seed</code>)</div>}
      </form>
    </div>
  );
}
