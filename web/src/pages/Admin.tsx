import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Badge, Banner, Stat } from '../components/ui';

interface ProviderComponent { provider: string; enabled?: boolean; configured?: boolean; mode?: string; notes?: string; }
interface MeetingAdapter {
  provider: string; configured: boolean;
  capabilities: { createSpace: boolean; liveMedia: boolean; recording: boolean; transcript: boolean; botJoin: boolean };
  fallback: string; reference: string;
}
interface Providers {
  llm: ProviderComponent; stt: ProviderComponent; tts: ProviderComponent;
  email: ProviderComponent; ats: ProviderComponent; meeting: MeetingAdapter[];
}
interface Analytics {
  funnel: { roles: number; candidates: number; interviews: number; completed: number };
  stateCounts: Record<string, number>;
  recommendations: Record<string, number>;
  reviews: number;
  quality: { avgEvidenceCoverage: number };
}
interface AuditEvent { id: string; actorId: string; actorType: string; action: string; entityType: string; entityId: string; createdAt: string; }
interface ModelExecution { id: string; provider: string; model: string; function: string; latencyMs: number; inputTokens: number; outputTokens: number; createdAt: string; }
interface Webhook { id: string; url: string; events: string[]; active: boolean; }

function activeBadge(c: ProviderComponent) {
  if (c.enabled || c.configured) return <Badge kind="green">Active</Badge>;
  return <Badge kind="gray">Built-in</Badge>;
}
function check(v: boolean) {
  return v ? <span style={{ color: 'var(--green)' }}>✓</span> : <span className="muted">—</span>;
}

export function Admin() {
  const [providers, setProviders] = useState<Providers | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [executions, setExecutions] = useState<ModelExecution[]>([]);
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [hookUrl, setHookUrl] = useState('');
  const [hookEvents, setHookEvents] = useState('*');
  const [creating, setCreating] = useState(false);

  const loadWebhooks = () =>
    api.get<{ webhooks: Webhook[] }>('/admin/webhooks').then((d) => setWebhooks(d.webhooks ?? []));

  useEffect(() => {
    Promise.all([
      api.get<Providers>('/admin/providers'),
      api.get<Analytics>('/admin/analytics'),
      api.get<{ events: AuditEvent[] }>('/admin/audit'),
      api.get<{ executions: ModelExecution[] }>('/admin/model-executions'),
      api.get<{ webhooks: Webhook[] }>('/admin/webhooks'),
    ])
      .then(([p, a, au, ex, wh]) => {
        setProviders(p); setAnalytics(a);
        setAudit(au.events ?? []); setExecutions(ex.executions ?? []); setWebhooks(wh.webhooks ?? []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="muted">Loading…</div>;

  const createWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setCreating(true);
    try {
      await api.post('/admin/webhooks', {
        url: hookUrl,
        events: hookEvents.split(',').map((s) => s.trim()).filter(Boolean),
      });
      setHookUrl('');
      setHookEvents('*');
      await loadWebhooks();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const connectorRows: { label: string; c?: ProviderComponent }[] = [
    { label: 'LLM', c: providers?.llm },
    { label: 'Speech-to-text', c: providers?.stt },
    { label: 'Text-to-speech', c: providers?.tts },
    { label: 'Email', c: providers?.email },
    { label: 'ATS', c: providers?.ats },
  ];

  return (
    <div>
      <div className="topbar">
        <h1>Admin & Connectors</h1>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      <div className="card">
        <h2>Connectors</h2>
        <div className="muted small" style={{ marginBottom: 10 }}>
          Open-source defaults are active. Paid connectors activate automatically when their API keys are set in the server .env.
        </div>
        <table>
          <thead><tr><th>Component</th><th>Provider</th><th>Status</th><th>Notes</th></tr></thead>
          <tbody>
            {connectorRows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td>{r.c?.provider ?? '—'}</td>
                <td>{r.c ? activeBadge(r.c) : <Badge kind="gray">—</Badge>}</td>
                <td className="muted small">{r.c?.notes ?? (r.c?.mode ? `mode: ${r.c.mode}` : '')}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3 style={{ marginTop: 18 }}>Meeting adapters</h3>
        <table>
          <thead>
            <tr>
              <th>Provider</th><th>Configured</th><th>Space</th><th>Live</th>
              <th>Recording</th><th>Transcript</th><th>Bot</th><th>Fallback</th>
            </tr>
          </thead>
          <tbody>
            {(providers?.meeting ?? []).map((m) => (
              <tr key={m.provider}>
                <td>{m.provider}</td>
                <td>{m.configured ? <Badge kind="green">Yes</Badge> : <Badge kind="gray">No</Badge>}</td>
                <td>{check(m.capabilities.createSpace)}</td>
                <td>{check(m.capabilities.liveMedia)}</td>
                <td>{check(m.capabilities.recording)}</td>
                <td>{check(m.capabilities.transcript)}</td>
                <td>{check(m.capabilities.botJoin)}</td>
                <td className="muted small">{m.fallback}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Analytics</h2>
        <div className="grid cols-4" style={{ marginBottom: 12 }}>
          <Stat label="Roles" value={analytics?.funnel.roles ?? 0} />
          <Stat label="Candidates" value={analytics?.funnel.candidates ?? 0} />
          <Stat label="Interviews" value={analytics?.funnel.interviews ?? 0} />
          <Stat label="Completed" value={analytics?.funnel.completed ?? 0} />
        </div>
        <div className="grid cols-2">
          <div>
            <h3>Recommendations</h3>
            <table>
              <tbody>
                {Object.entries(analytics?.recommendations ?? {}).map(([k, v]) => (
                  <tr key={k}><td>{k.replace(/_/g, ' ')}</td><td>{v}</td></tr>
                ))}
                {Object.keys(analytics?.recommendations ?? {}).length === 0 && (
                  <tr><td className="muted small">No data yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div>
            <h3>Quality</h3>
            <Stat label="Avg evidence coverage" value={`${Math.round((analytics?.quality.avgEvidenceCoverage ?? 0) * 100)}%`} />
            <div className="muted small" style={{ marginTop: 8 }}>Human reviews: {analytics?.reviews ?? 0}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Audit log</h2>
        {audit.length === 0 ? <div className="muted small">No events.</div> : (
          <table>
            <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead>
            <tbody>
              {audit.map((e) => (
                <tr key={e.id}>
                  <td className="muted small">{new Date(e.createdAt).toLocaleString()}</td>
                  <td>{e.actorType}</td>
                  <td>{e.action}</td>
                  <td className="muted">{e.entityType}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Model executions</h2>
        {executions.length === 0 ? <div className="muted small">No executions.</div> : (
          <table>
            <thead><tr><th>Time</th><th>Function</th><th>Provider</th><th>Model</th><th>Latency</th><th>Tokens</th></tr></thead>
            <tbody>
              {executions.map((x) => (
                <tr key={x.id}>
                  <td className="muted small">{new Date(x.createdAt).toLocaleString()}</td>
                  <td>{x.function}</td>
                  <td>{x.provider}</td>
                  <td className="muted">{x.model}</td>
                  <td>{x.latencyMs} ms</td>
                  <td className="muted small">{x.inputTokens} / {x.outputTokens}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Webhooks</h2>
        {webhooks.length === 0 ? <div className="muted small">No webhooks configured.</div> : (
          <table>
            <thead><tr><th>URL</th><th>Events</th><th>Active</th></tr></thead>
            <tbody>
              {webhooks.map((w) => (
                <tr key={w.id}>
                  <td className="small">{w.url}</td>
                  <td className="muted small">{(w.events ?? []).join(', ')}</td>
                  <td>{w.active ? <Badge kind="green">Yes</Badge> : <Badge kind="gray">No</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form className="row" style={{ marginTop: 12, alignItems: 'flex-end' }} onSubmit={createWebhook}>
          <div style={{ flex: 2 }}>
            <label>URL</label>
            <input value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} placeholder="https://example.com/hook" required />
          </div>
          <div style={{ flex: 1 }}>
            <label>Events (comma-separated)</label>
            <input value={hookEvents} onChange={(e) => setHookEvents(e.target.value)} placeholder="*" />
          </div>
          <button className="btn" type="submit" disabled={creating || !hookUrl}>Add webhook</button>
        </form>
      </div>
    </div>
  );
}
