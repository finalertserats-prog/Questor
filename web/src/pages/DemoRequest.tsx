import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Banner } from '../components/ui';
import { BrandLogo } from '../components/BrandLogo';

export function DemoRequest() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await api.post('/demo/request', { name, email, company });
      setSent(true);
    } catch (error: unknown) {
      setErr(error instanceof Error ? error.message : 'Could not request the demo.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="public-shell">
      <header className="public-bar"><Link to="/login" className="public-brand"><BrandLogo variant="lockup" size={28} /></Link><Link to="/login" className="btn sm secondary">Sign in</Link></header>
      <main className="public-body"><div className="card auth-card" style={{ width: '100%', maxWidth: 520, margin: '0 auto' }}>
        {sent ? <><h1>Check your inbox</h1><p className="muted">We sent a one-time sign-in link if this address can receive a demo. It opens a private sandbox and expires after one use.</p></> : <>
          <h1>Ask for a demo</h1><p className="muted small">We only use these details to provision and operate your private demo sandbox.</p>{err && <Banner kind="error">{err}</Banner>}
          <form onSubmit={submit}>
            <label htmlFor="demo-name">Your name</label><input id="demo-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
            <label htmlFor="demo-email">Work email</label><input id="demo-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} required />
            <label htmlFor="demo-company">Company</label><input id="demo-company" value={company} onChange={(e) => setCompany(e.target.value)} maxLength={120} required />
            <button className="btn" style={{ width: '100%', marginTop: 18 }} disabled={busy}>{busy ? 'Sending…' : 'Send demo link'}</button>
          </form>
        </>}
      </div></main>
    </div>
  );
}
