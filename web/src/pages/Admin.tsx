import { useEffect, useState, type KeyboardEvent } from 'react';
import { claimHealth } from '../components/healthStatusStore';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { Badge, Banner, Stat } from '../components/ui';
import { MeetingAdapterSetup, OtherConnectorGuides, type MeetingAdapter } from '../components/ConnectorSetup';
import { RoundMeetingSetting, type RoundMeetingStatus } from '../components/RoundMeetingSetting';
import { HiringPolicySettings } from '../components/HiringPolicySettings';
import { OrgTimeZoneSetting } from '../components/OrgTimeZoneSetting';
import { formatPercent, formatScore } from '../components/scoreFormat';
import { recommendationStatus } from '../components/statusModel';
import { formatDateTime } from '../components/dateFormat';
import { SystemHealthPanel } from '../components/SystemHealthPanel';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';
import { AdminTabList } from '../components/AdminTabList';
import { adminPanelId, adminTabFromParam, adminTabId, adminTabPath, nextAdminTab, type AdminTabKey } from '../components/adminTabsModel';
import {
  LEGACY_OFF_CONFIRMATION, eventsForApi, eventsLabel, signatureView,
} from '../components/webhookSignatureModel';
import { useAuth, type Tenant } from '../auth';
import { canManageAdmin } from '../components/profileMenuModel';
import { useToast } from '../components/Toast';

interface ProviderComponent { provider: string; enabled?: boolean; configured?: boolean; mode?: string; notes?: string; }
interface Providers {
  llm: ProviderComponent; stt: ProviderComponent; tts: ProviderComponent;
  email: ProviderComponent; ats: ProviderComponent; meeting: MeetingAdapter[];
  /** Only the deployment operator may test the shared meeting apps. */
  canTestMeetingConnectors?: boolean;
  /** Absent on an older server. */
  roundMeeting?: RoundMeetingStatus;
}
interface Analytics {
  funnel: { roles: number; candidates: number; interviews: number; completed: number };
  stateCounts: Record<string, number>;
  recommendations: Record<string, number>;
  reviews: number;
  // Null for a tenant with nothing to average yet, which is not the same as 0.
  quality: { avgEvidenceCoverage: number | null };
}
interface ModelExecution { id: string; provider: string; model: string; function: string; latencyMs: number; inputTokens: number; outputTokens: number; createdAt: string; }
// `events` is the comma-separated string the server stores, not an array.
interface Webhook { id: string; url: string; events: string; active: boolean; sendLegacySignature: boolean; }
interface WebhookList { webhooks: Webhook[]; legacySignatureDisabledEverywhere?: boolean; }

function activeBadge(c: ProviderComponent) {
  if (c.enabled || c.configured) return <Badge kind="green">Active</Badge>;
  return <Badge kind="gray">Built-in</Badge>;
}

export function Admin() {
  const { tab } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const activeTab = adminTabFromParam(tab);
  const { user } = useAuth();
  // The health verdict on the tab strip belongs to this user's session only.
  useEffect(() => { claimHealth(user?.id ?? null); }, [user?.id]);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [executions, setExecutions] = useState<ModelExecution[]>([]);
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [v1OffEverywhere, setV1OffEverywhere] = useState(false);
  // The webhook whose v1 switch-off is waiting for the admin to confirm it.
  const [confirmV1Off, setConfirmV1Off] = useState<string | null>(null);
  const [savingHook, setSavingHook] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Keyed by panel, so each section can say whether ITS data arrived.
  const [panelErrors, setPanelErrors] = useState<Record<string, string>>({});

  const [hookUrl, setHookUrl] = useState('');
  const [hookEvents, setHookEvents] = useState('*');
  const [creating, setCreating] = useState(false);
  // The clipboard has its own outcome, and needs its own line to say it in.
  const [copyNotice, setCopyNotice] = useState('');
  const toast = useToast();

  const [orgName, setOrgName] = useState('');
  const [slug, setSlug] = useState('');
  const [savedSlug, setSavedSlug] = useState<string | null>(null);
  const [savingSlug, setSavingSlug] = useState(false);

  const applyWebhooks = (d: WebhookList) => {
    setWebhooks(d.webhooks ?? []);
    setV1OffEverywhere(Boolean(d.legacySignatureDisabledEverywhere));
  };
  const loadWebhooks = () => api.get<WebhookList>('/admin/webhooks').then(applyWebhooks);

  // Four independent panels, four independent loads. One Promise.all meant a
  // single failing endpoint — analytics on a permission this account lacks, say
  // — blanked the connector table, the executions and the webhooks with it, and
  // the page never said which of them had actually failed.
  useEffect(() => {
    let cancelled = false;
    const note = (panel: string) => (err: unknown) => {
      if (cancelled) return;
      setPanelErrors((prev) => ({ ...prev, [panel]: err instanceof Error ? err.message : 'Could not load.' }));
    };
    const set = <T,>(apply: (value: T) => void) => (value: T) => { if (!cancelled) apply(value); };

    void Promise.allSettled([
      api.get<Providers>('/admin/providers').then(set(setProviders), note('connectors')),
      api.get<Analytics>('/admin/analytics').then(set(setAnalytics), note('analytics')),
      api.get<{ executions: ModelExecution[] }>('/admin/model-executions')
        .then(set((ex: { executions: ModelExecution[] }) => setExecutions(ex.executions ?? [])), note('executions')),
      api.get<WebhookList>('/admin/webhooks').then(set(applyWebhooks), note('webhooks')),
    ]).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Unread, the saved link is unknown: offering "Create link" then would let
  // an admin overwrite a link their team already uses without seeing it.
  const [orgLoadError, setOrgLoadError] = useState('');
  const [orgAttempt, setOrgAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    api.get<{ tenant: Tenant | null }>('/auth/me')
      .then((d) => {
        if (cancelled) return;
        setOrgName(d.tenant?.name ?? '');
        setSlug(d.tenant?.slug ?? '');
        setSavedSlug(d.tenant?.slug ?? null);
        setOrgLoadError('');
      })
      .catch((err: unknown) => {
        if (!cancelled) setOrgLoadError(err instanceof Error ? err.message : 'Could not read your organisation.');
      });
    return () => { cancelled = true; };
  }, [orgAttempt]);

  // After every hook. The server refuses every request here without
  // admin:manage; the page does not render an empty console for it either.
  if (!user || !canManageAdmin(user.role)) return <Navigate to="/" replace />;
  // An address naming no tab goes back to the console itself.
  if (activeTab === null) return <Navigate to="/admin" replace />;

  const createWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setCreating(true);
    try {
      await api.post('/admin/webhooks', {
        url: hookUrl,
        events: eventsForApi(hookEvents),
      });
      setHookUrl('');
      setHookEvents('*');
      await loadWebhooks();
      toast.show('Webhook added.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not add the webhook.');
    } finally {
      setCreating(false);
    }
  };

  const setLegacySignature = async (hook: Webhook, sendLegacySignature: boolean) => {
    setError('');
    setConfirmV1Off(null);
    setSavingHook(hook.id);
    try {
      await api.patch(`/admin/webhooks/${hook.id}`, { sendLegacySignature });
      await loadWebhooks();
      toast.show(sendLegacySignature
        ? 'The legacy v1 signature is back on for that webhook.'
        : 'That webhook now receives the v2 signature only.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not change the webhook signature setting.');
    } finally {
      setSavingHook(null);
    }
  };

  const saveSlug = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSavingSlug(true);
    try {
      const { org } = await api.patch<{ org: { name: string; slug: string } }>('/admin/org', { slug: slug.trim().toLowerCase() });
      setSavedSlug(org.slug);
      setSlug(org.slug);
      toast.show('Sign-in link saved.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the sign-in link.');
    } finally {
      setSavingSlug(false);
    }
  };

  const orgLink = savedSlug ? `${window.location.origin}/o/${savedSlug}` : '';

  // Awaited: "Link copied." over a clipboard that refused — no permission, an
  // insecure context — is a plain untruth, and the person walks away with an
  // empty clipboard and a link they think they have.
  const copyOrgLink = async () => {
    setCopyNotice('');
    try {
      await navigator.clipboard.writeText(orgLink);
      toast.show('Link copied.');
    } catch {
      setCopyNotice('We could not reach your clipboard — select the link above and copy it yourself.');
    }
  };

  const connectorRows: { label: string; c?: ProviderComponent }[] = [
    { label: 'LLM', c: providers?.llm },
    { label: 'Speech-to-text', c: providers?.stt },
    { label: 'Text-to-speech', c: providers?.tts },
    { label: 'Email', c: providers?.email },
    // This organisation's own ATS; it is connected in Settings.
    { label: 'ATS', c: providers?.ats ? { ...providers.ats, notes: 'Your organisation’s own connection. Manage it in Settings.' } : undefined },
  ];

  const selectTab = (key: AdminTabKey) => navigate(adminTabPath(key));

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: AdminTabKey) => {
    const next = nextAdminTab(current, event.key);
    if (next === current) return;
    event.preventDefault();
    selectTab(next);
    window.requestAnimationFrame(() => document.getElementById(adminTabId(next))?.focus());
  };

  // Only the open tab is rendered: a hidden System health panel would go on
  // polling a report nobody is looking at.
  const panel = (key: AdminTabKey, content: React.ReactNode) => activeTab === key && (
    <section id={adminPanelId(key)} role="tabpanel" aria-labelledby={adminTabId(key)} tabIndex={0} className="admin-panel">
      {content}
    </section>
  );

  // System health never waits for the other sections' requests; they each
  // say they are loading instead of holding the whole console back.
  const loaded = (content: React.ReactNode) => (loading ? <div className="card muted">Loading…</div> : content);

  return (
    <div>
      <PageHeader
        icon="admin"
        title="Admin console"
        // The platform owner reviews the shared catalog from here as well as the profile menu.
        actions={user?.platformOperator ? <Link className="btn secondary" to="/catalog-review"><Icon name="list" size={16} />Catalog review</Link> : undefined}
      />

      <AdminTabList active={activeTab} onSelect={selectTab} onKeyDown={handleTabKeyDown} />

      {error && <Banner kind="error">{error}</Banner>}

      {panel('health', <SystemHealthPanel />)}

      {panel('organisation', loaded(
      <>
      <div className="card">
        <h2>Organisation sign-in link</h2>
        <p className="muted small">
          Share this link with your HR team so they sign in to {orgName || 'your organisation'} directly. Anyone who guesses the link can see your organisation's name, so avoid putting anything sensitive in it.
        </p>
        {orgLoadError && (
          <Banner kind="error">
            Your organisation&rsquo;s current sign-in link could not be read. {orgLoadError}{' '}
            <button type="button" className="btn secondary sm" onClick={() => setOrgAttempt((n) => n + 1)}>Try again</button>
          </Banner>
        )}
        {copyNotice && <Banner kind="info">{copyNotice}</Banner>}
        {orgLink && (
          <div className="row" style={{ gap: 10, marginBottom: 12 }}>
            <code className="break-anywhere">{orgLink}</code>
            <button type="button" className="btn sm secondary" onClick={() => void copyOrgLink()}>Copy link</button>
          </div>
        )}
        <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={saveSlug} hidden={orgLoadError !== ''}>
          <div style={{ flex: 1 }}>
            <label htmlFor="org-slug">Link name</label>
            <input
              id="org-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="acme-hiring"
              pattern="[a-z0-9][a-z0-9\-]{0,38}[a-z0-9]"
              title="2–40 lowercase letters, numbers or hyphens, starting and ending with a letter or number"
              required
            />
          </div>
          <button className="btn" type="submit" disabled={savingSlug || !slug.trim()}>
            {savingSlug ? 'Saving…' : savedSlug ? 'Update link' : 'Create link'}
          </button>
        </form>
      </div>
      <OrgTimeZoneSetting />
      <HiringPolicySettings />
      </>
      ))}

      {panel('connectors', loaded(
      <div className="card">
        <h2>Connectors</h2>
        {panelErrors.connectors && <Banner kind="error">Connector status did not load. {panelErrors.connectors}</Banner>}
        <div className="muted small" style={{ marginBottom: 10 }}>
          Open-source defaults are active. Paid connectors activate automatically when their API keys are set in the server .env.
        </div>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Connectors">
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
        </div>

        <OtherConnectorGuides ids={['email-sendgrid', 'email-smtp']} />
      </div>
      ))}

      {panel('meetings', loaded(
      <div className="card">
        <h2>Meetings</h2>
        {panelErrors.connectors && <Banner kind="error">Meeting status did not load. {panelErrors.connectors}</Banner>}
        <h3>Meeting adapters</h3>
        <div className="muted small" style={{ marginBottom: 10 }}>
          Open "How to set up" for what to create at each vendor and which variables to add to server/.env. Keys are set on the server and take effect after a restart; they are never stored or shown here.
        </div>
        {providers && !providers.canTestMeetingConnectors && (
          <div className="muted small" style={{ marginBottom: 10 }}>
            Meeting connectors belong to the whole deployment, so only its operator can test them.
          </div>
        )}
        <MeetingAdapterSetup
          adapters={providers?.meeting ?? []}
          canTest={providers?.canTestMeetingConnectors === true}
          extraEnv={providers?.roundMeeting?.options}
        />

        <h3 style={{ marginTop: 18 }}>Meeting links for human rounds</h3>
        <div className="muted small">
          When a recruiter schedules a human interview round, the provider chosen here creates the meeting and its join link.
          With "Manual link", recruiters paste a link themselves. AI interviews always use the hosted Questor room.
        </div>
        <RoundMeetingSetting
          status={providers?.roundMeeting}
          // The save itself already reported its outcome; a failed refresh only
          // leaves the "Now:" line stale until the next page load.
          onSaved={() => { void api.get<Providers>('/admin/providers').then(setProviders).catch(() => undefined); }}
        />
      </div>
      ))}

      {panel('analytics', loaded(
      <div className="card">
        <h2>Analytics</h2>
        {panelErrors.analytics && <Banner kind="error">Analytics did not load. {panelErrors.analytics}</Banner>}
        {/* A zero here is a statement about the tenant. Analytics that never
            arrived is not, so it says so instead of reporting an empty company. */}
        <div className="grid cols-4" style={{ marginBottom: 12 }}>
          <Stat label="Roles" value={formatScore(analytics?.funnel.roles)} />
          <Stat label="Candidates" value={formatScore(analytics?.funnel.candidates)} />
          <Stat label="Interviews" value={formatScore(analytics?.funnel.interviews)} />
          <Stat label="Completed" value={formatScore(analytics?.funnel.completed)} />
        </div>
        <div className="grid cols-2">
          <div>
            <h3>Recommendations</h3>
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Recommendations">
            <table>
              <tbody>
                {/* Through the same table the badges use, so a recommendation
                    the server adds — SCORING_UNAVAILABLE, say — is named here
                    the way it is named everywhere else. */}
                {Object.entries(analytics?.recommendations ?? {}).map(([k, v]) => (
                  <tr key={k}><td>{recommendationStatus(k).label}</td><td>{v}</td></tr>
                ))}
                {Object.keys(analytics?.recommendations ?? {}).length === 0 && (
                  <tr><td className="muted small">No data yet.</td></tr>
                )}
              </tbody>
            </table>
            </div>
          </div>
          <div>
            <h3>Quality</h3>
            {/* "0%" is a finding — no answer had evidence behind it. While the
                figure is still loading, or when the server has none to give for
                an empty tenant, saying it states something the data does not. */}
            <Stat label="Avg evidence coverage" value={formatPercent(analytics?.quality.avgEvidenceCoverage)} />
            <div className="muted small" style={{ marginTop: 8 }}>Human reviews: {formatScore(analytics?.reviews)}</div>
          </div>
        </div>
      </div>
      ))}

      {panel('executions', loaded(
      <div className="card">
        <h2>Model executions</h2>
        {panelErrors.executions && <Banner kind="error">Model executions did not load. {panelErrors.executions}</Banner>}
        {executions.length === 0 ? <div className="muted small">No executions.</div> : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Model executions">
          <table>
            <thead><tr><th>Time</th><th>Function</th><th>Provider</th><th>Model</th><th>Latency</th><th>Tokens</th></tr></thead>
            <tbody>
              {executions.map((x) => (
                <tr key={x.id}>
                  <td className="muted small">{formatDateTime(x.createdAt)}</td>
                  <td>{x.function}</td>
                  <td>{x.provider}</td>
                  <td className="muted">{x.model}</td>
                  <td>{x.latencyMs} ms</td>
                  <td className="muted small">{x.inputTokens} / {x.outputTokens}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
      ))}

      {panel('webhooks', loaded(
      <div className="card">
        <h2>Webhooks</h2>
        {panelErrors.webhooks && <Banner kind="error">Webhooks did not load. {panelErrors.webhooks}</Banner>}
        {webhooks.length === 0 ? <div className="muted small">No webhooks configured.</div> : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Webhooks">
          <table>
            <thead><tr><th>URL</th><th>Events</th><th>Active</th><th>Signature</th></tr></thead>
            <tbody>
              {webhooks.map((w) => {
                const sig = signatureView(w, v1OffEverywhere);
                return (
                  <tr key={w.id}>
                    <td className="small break-anywhere">{w.url}</td>
                    <td className="muted small">{eventsLabel(w.events ?? '')}</td>
                    <td>{w.active ? <Badge kind="green">Yes</Badge> : <Badge kind="gray">No</Badge>}</td>
                    <td className="small">
                      <div>{sig.label}</div>
                      {sig.canSwitchOff && (
                        <button
                          type="button"
                          className="btn secondary sm"
                          disabled={savingHook === w.id}
                          onClick={() => setConfirmV1Off(w.id)}
                        >
                          Stop sending v1
                        </button>
                      )}
                      {sig.canSwitchOn && (
                        <button
                          type="button"
                          className="btn ghost sm"
                          disabled={savingHook === w.id}
                          onClick={() => void setLegacySignature(w, true)}
                        >
                          Send v1 again
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
        {confirmV1Off && (
          <Banner kind="info">
            <p>{LEGACY_OFF_CONFIRMATION}</p>
            <button
              type="button"
              className="btn sm"
              disabled={savingHook !== null}
              onClick={() => {
                const hook = webhooks.find((w) => w.id === confirmV1Off);
                if (hook) void setLegacySignature(hook, false);
              }}
            >
              Confirm: stop sending v1
            </button>{' '}
            <button type="button" className="btn ghost sm" onClick={() => setConfirmV1Off(null)}>Keep v1 for now</button>
          </Banner>
        )}
        <form className="row" style={{ marginTop: 12, alignItems: 'flex-end' }} onSubmit={createWebhook}>
          <div style={{ flex: 2 }}>
            <label htmlFor="hook-url">URL</label>
            {/* type="url" so the browser refuses "example.com/hook" here rather
                than the server refusing it after the press. */}
            <input
              id="hook-url"
              type="url"
              value={hookUrl}
              onChange={(e) => { setHookUrl(e.target.value); }}
              placeholder="https://example.com/hook"
              required
            />
          </div>
          <div style={{ flex: 1 }}>
            <label htmlFor="hook-events">Events (comma-separated)</label>
            <input id="hook-events" value={hookEvents} onChange={(e) => setHookEvents(e.target.value)} placeholder="*" />
          </div>
          <button className="btn" type="submit" disabled={creating || !hookUrl}>Add webhook</button>
        </form>
      </div>
      ))}
    </div>
  );
}
