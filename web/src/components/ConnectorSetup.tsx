import { Fragment, useCallback, useState } from 'react';
import { api } from '../api/client';
import { Badge, Banner } from './ui';
import {
  callbackUrlsFor, envSnippet, guideFor, RESTART_NOTE, statusLabel,
  type ConnectorGuide, type EnvPresence,
} from './connectorGuides';

export interface MeetingAdapter {
  provider: string;
  configured: boolean;
  selected?: boolean;
  env?: EnvPresence[];
  capabilities: { createSpace: boolean; liveMedia: boolean; recording: boolean; transcript: boolean; botJoin: boolean };
  fallback: string;
  reference: string;
}

interface TestResult { ok: boolean; message: string }
type TestState = TestResult | 'pending';

const ADAPTER_COLUMNS = 9;

function Check({ on }: { on: boolean }) {
  return on ? <span style={{ color: 'var(--green)' }}>✓</span> : <span className="muted">—</span>;
}

function Permission({ text }: { text: string }) {
  // Bare scope identifiers read best as code; explanatory sentences do not.
  return /\s/.test(text) ? <>{text}</> : <code>{text}</code>;
}

export function GuidePanel({ guide, env }: { guide: ConnectorGuide; env?: readonly EnvPresence[] }) {
  const presence = new Map((env ?? []).map((v) => [v.name, v.present]));
  const callbacks = callbackUrlsFor(guide, window.location.origin);

  return (
    <section data-testid={`connector-guide-${guide.id}`} style={{ padding: '6px 2px' }}>
      <p className="small"><strong>What to create:</strong> {guide.vendorAccount}</p>
      <ol className="small">
        {guide.steps.map((step, i) => <li key={`${guide.id}-step-${i}`}>{step}</li>)}
      </ol>

      {guide.envVars.length === 0 ? (
        <p className="small muted">No environment variables or credentials are needed.</p>
      ) : (
        <>
          <p className="small"><strong>Add to server/.env</strong></p>
          <pre className="small" style={{ whiteSpace: 'pre-wrap', overflowX: 'auto' }}>{envSnippet(guide)}</pre>
          <ul className="small">
            {guide.envVars.map((v) => (
              <li key={v.name}>
                <code>{v.name}</code>{' '}
                {env && (presence.get(v.name) ? <Badge kind="green">set</Badge> : <Badge kind="gray">missing</Badge>)}
                {v.note && <span className="muted"> — {v.note}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {guide.permissions.length > 0 && (
        <>
          <p className="small"><strong>Scopes / permissions</strong></p>
          <ul className="small">
            {guide.permissions.map((p) => <li key={p}><Permission text={p} /></li>)}
          </ul>
        </>
      )}

      <p className="small">
        <strong>Redirect / webhook URLs:</strong> {callbacks.length === 0 && guide.callbackNote}
      </p>
      {callbacks.length > 0 && (
        <ul className="small">
          {callbacks.map((c) => <li key={c.url}>{c.label}: <code>{c.url}</code></li>)}
        </ul>
      )}

      <p className="small">
        <a href={guide.docsUrl} target="_blank" rel="noopener noreferrer">{guide.docsLabel}</a>
      </p>
      <p className="small muted">{RESTART_NOTE}</p>
    </section>
  );
}

export function MeetingAdapterSetup({ adapters }: { adapters: readonly MeetingAdapter[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [tests, setTests] = useState<Readonly<Record<string, TestState>>>({});

  const toggleGuide = useCallback((id: string) => {
    setOpenId((current) => (current === id ? null : id));
  }, []);

  const runTest = useCallback(async (id: string) => {
    setTests((prev) => ({ ...prev, [id]: 'pending' }));
    try {
      const result = await api.post<TestResult>(`/admin/connectors/meeting/${encodeURIComponent(id)}/test`, {});
      setTests((prev) => ({ ...prev, [id]: { ok: result.ok === true, message: result.message } }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'The connection test could not be run.';
      setTests((prev) => ({ ...prev, [id]: { ok: false, message } }));
    }
  }, []);

  return (
    <table>
      <thead>
        <tr>
          <th>Provider</th><th>Status</th><th>Space</th><th>Live</th>
          <th>Recording</th><th>Transcript</th><th>Bot</th><th>Fallback</th><th scope="col" aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {adapters.map((m) => {
          const guide = guideFor(m.provider);
          const test = tests[m.provider];
          const isOpen = openId === m.provider;
          return (
            <Fragment key={m.provider}>
              <tr>
                <td>
                  {guide?.title ?? m.provider}
                  {m.selected && <> <Badge kind="green">in use</Badge></>}
                </td>
                <td>
                  <Badge kind={m.configured ? 'green' : 'gray'}>{statusLabel(m.configured)}</Badge>
                </td>
                <td><Check on={m.capabilities.createSpace} /></td>
                <td><Check on={m.capabilities.liveMedia} /></td>
                <td><Check on={m.capabilities.recording} /></td>
                <td><Check on={m.capabilities.transcript} /></td>
                <td><Check on={m.capabilities.botJoin} /></td>
                <td className="muted small">{m.fallback}</td>
                <td>
                  <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                    {guide && (
                      <button type="button" className="btn sm secondary" aria-expanded={isOpen} aria-controls={`connector-guide-${m.provider}`} onClick={() => toggleGuide(m.provider)}>
                        {isOpen ? 'Hide setup' : 'How to set up'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn sm"
                      data-testid={`test-connection-${m.provider}`}
                      disabled={!m.configured || test === 'pending'}
                      title={m.configured ? undefined : 'Set the variables in server/.env and restart the server first'}
                      onClick={() => { void runTest(m.provider); }}
                    >
                      {test === 'pending' ? 'Testing…' : 'Test connection'}
                    </button>
                  </div>
                </td>
              </tr>
              {test && test !== 'pending' && (
                <tr>
                  {/* The result arrives after an async call, so it is announced. */}
                  <td colSpan={ADAPTER_COLUMNS} role="status" aria-live="polite">
                    <Banner kind={test.ok ? 'ok' : 'error'}>{test.message}</Banner>
                  </td>
                </tr>
              )}
              {isOpen && guide && (
                <tr id={`connector-guide-${m.provider}`}>
                  <td colSpan={ADAPTER_COLUMNS}><GuidePanel guide={guide} env={m.env} /></td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

export function OtherConnectorGuides({ ids }: { ids: readonly string[] }) {
  const guides = ids.map((id) => guideFor(id)).filter((g): g is ConnectorGuide => g !== undefined);
  return (
    <div style={{ marginTop: 10 }}>
      {guides.map((g) => (
        <details key={g.id} style={{ marginTop: 6 }}>
          <summary className="small">How to set up {g.title}</summary>
          <GuidePanel guide={g} />
        </details>
      ))}
    </div>
  );
}
