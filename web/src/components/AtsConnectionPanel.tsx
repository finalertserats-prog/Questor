import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Badge, Banner } from './ui';
import { formatDateTime } from './dateFormat';
import {
  ATS_PROVIDER_LABELS,
  atsFormProblem,
  connectionStatus,
  formFromConnection,
  keepsSavedKey,
  savePayload,
  type AtsConnectionView,
  type AtsForm,
  type AtsProvider,
} from './atsModel';
import { useToast } from './Toast';

type Busy = 'save' | 'test' | 'disconnect' | null;

interface Notice { kind: 'ok' | 'error' | 'info'; text: string }

const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

/**
 * The organisation's own ATS connection, for its admins. The key field is
 * write-only: it is never filled from the server, and leaving it blank keeps
 * the key already saved.
 */
export function AtsConnectionPanel() {
  const [conn, setConn] = useState<AtsConnectionView | null>(null);
  const [form, setForm] = useState<AtsForm>(formFromConnection(null));
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const toast = useToast();

  const adopt = useCallback((next: AtsConnectionView | null) => {
    setConn(next);
    setForm(formFromConnection(next));
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.get<{ connection: AtsConnectionView | null }>('/admin/ats')
      .then((d) => { if (!cancelled) adopt(d.connection); })
      .catch((err: unknown) => { if (!cancelled) setLoadError(errorText(err, 'Could not load the ATS connection.')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [adopt]);

  const problem = atsFormProblem(form, conn);
  const status = connectionStatus(conn);
  const update = (patch: Partial<AtsForm>) => { setForm((prev) => ({ ...prev, ...patch })); setNotice(null); };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problem || busy) return;
    setBusy('save');
    setNotice(null);
    try {
      const d = await api.put<{ connection: AtsConnectionView }>('/admin/ats', savePayload(form));
      adopt(d.connection);
      toast.show('Saved. Test the connection to make sure your ATS accepts it.');
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: errorText(err, 'Could not save the ATS connection.') });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (busy) return;
    setBusy('test');
    setNotice(null);
    try {
      const d = await api.post<{ ok: boolean; message: string; connection: AtsConnectionView | null }>('/admin/ats/test', {});
      setConn(d.connection);
      if (d.ok) toast.show(d.message);
      else setNotice({ kind: 'error', text: d.message });
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: errorText(err, 'The connection test could not be run.') });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (busy) return;
    if (!window.confirm('Disconnect your ATS? Imports and exports stop until it is connected again, and the saved key is deleted.')) return;
    setBusy('disconnect');
    setNotice(null);
    try {
      const d = await api.del<{ connection: AtsConnectionView }>('/admin/ats');
      adopt(d.connection);
      toast.show('Disconnected. The saved key has been deleted.');
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: errorText(err, 'Could not disconnect.') });
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className="card"><h2>ATS connection</h2><div className="muted">Loading…</div></div>;

  // A saved key is kept only for the same ATS account; change the address,
  // account or provider and the field asks for a key again.
  const keyStored = keepsSavedKey(form, conn);
  const keyWillBeDropped = Boolean(conn?.hasApiKey && conn.source !== 'env' && !keyStored);

  return (
    <section className="card" data-testid="ats-connection-panel" aria-labelledby="ats-connection-title">
      <h2 id="ats-connection-title">ATS connection</h2>
      <p className="muted small">
        Connect your organisation's applicant tracking system to import requisitions as roles and send finished assessments back.
        Only your organisation can use this connection.
      </p>
      {loadError && <Banner kind="error">{loadError}</Banner>}

      <div className="row" style={{ gap: 10, marginBottom: 10 }}>
        <Badge kind={status.kind}>{status.label}</Badge>
        {conn?.lastTestedAt && <span className="muted small">Last tested {formatDateTime(conn.lastTestedAt)}</span>}
        {conn?.source === 'env' && <span className="muted small">Set up in the server's configuration.</span>}
      </div>

      {notice && (
        <div role="status" aria-live="polite"><Banner kind={notice.kind}>{notice.text}</Banner></div>
      )}

      <form onSubmit={save}>
        <label htmlFor="ats-provider">ATS</label>
        <select id="ats-provider" value={form.provider} onChange={(e) => update({ provider: e.target.value as AtsProvider })}>
          {(Object.keys(ATS_PROVIDER_LABELS) as AtsProvider[]).map((p) => <option key={p} value={p}>{ATS_PROVIDER_LABELS[p]}</option>)}
        </select>

        <label htmlFor="ats-base-url">API address</label>
        <input
          id="ats-base-url"
          type="url"
          value={form.baseUrl}
          onChange={(e) => update({ baseUrl: e.target.value })}
          placeholder="https://ats.yourco.com/api"
          required
        />

        <label htmlFor="ats-account">Account (only if your ATS serves many companies from one address)</label>
        {/* The browser takes an address, a text box and a password box for a
            sign-in form, and fills in the admin's own Questor email and
            password; saving that would send their password to the ATS. So the
            key is marked as a new secret (browsers never fill a saved one into
            it) and neither field is offered to password managers. */}
        <input
          id="ats-account"
          name="ats-account"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
          value={form.accountId}
          onChange={(e) => update({ accountId: e.target.value })}
          placeholder="yourco"
        />

        <label htmlFor="ats-api-key">API key</label>
        <input
          id="ats-api-key"
          name="ats-api-key"
          type="password"
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          value={form.apiKey}
          onChange={(e) => update({ apiKey: e.target.value })}
          placeholder={keyStored ? 'A key is saved. Leave blank to keep it.' : 'Paste the key your ATS issued'}
        />
        <div className="muted small">The key is stored encrypted and is never shown again, here or anywhere else.</div>
        {keyWillBeDropped && (
          <div className="muted small">You changed the ATS, address or account, so the saved key will not be used. Enter the key for this one.</div>
        )}

        {problem && form.baseUrl.trim() !== '' && <div className="muted small" style={{ marginTop: 8 }}>{problem}</div>}

        <div className="row" style={{ marginTop: 16, gap: 8 }}>
          <button className="btn" type="submit" disabled={Boolean(problem) || busy !== null}>
            {busy === 'save' ? 'Saving…' : conn ? 'Save changes' : 'Connect'}
          </button>
          <button
            className="btn secondary"
            type="button"
            data-testid="ats-test-connection"
            onClick={() => { void test(); }}
            disabled={!conn?.connected || busy !== null}
          >
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          {conn && conn.status !== 'disconnected' && (
            <button className="btn secondary" type="button" onClick={() => { void disconnect(); }} disabled={busy !== null}>
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
