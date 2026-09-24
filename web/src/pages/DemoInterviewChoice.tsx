import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { PageHeader } from '../components/PageHeader';
import { Icon } from '../components/Icon';
import { Banner } from '../components/ui';
import { failureCopy, failureFor, type DemoFailure, type DemoMode } from '../components/demoInterviewModel';

interface Choice {
  mode: DemoMode;
  label: string;
  timing: string;
  detail: string;
  simulated: boolean;
}

interface Choices {
  roleTitle: string | null;
  open: { runId: string; mode: DemoMode } | null;
  choices: Choice[];
}

/**
 * The one screen where the demo's bounds are stated as facts about the demo.
 *
 * Everything the visitor needs to know before agreeing to fifteen minutes is
 * here: how long it runs, that extra time is available for the asking, and —
 * for the watched mode — that the candidate is written rather than real.
 * Saying all of it HERE is what buys the right to say none of it during the
 * interview, which is the rule the interviewer is held to.
 */
export function DemoInterviewChoice() {
  const navigate = useNavigate();
  const [data, setData] = useState<Choices | null>(null);
  const [failure, setFailure] = useState<DemoFailure | null>(null);
  const [extraTime, setExtraTime] = useState(false);
  const [starting, setStarting] = useState<DemoMode | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Choices>('/demo/interview/choices'));
      setFailure(null);
    } catch (err: unknown) {
      setFailure(failureFor(err instanceof ApiError ? err.status : undefined, err instanceof ApiError ? err.code : undefined));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const start = async (mode: DemoMode) => {
    if (starting) return;
    setStarting(mode);
    try {
      const res = await api.post<{ runId: string; portalUrl: string | null }>('/demo/interview/start', { mode, extraTime });
      if (mode === 'observer') navigate(`/demo/watch/${res.runId}`);
      else if (res.portalUrl) window.location.assign(new URL(res.portalUrl).pathname);
      else setFailure('engine_unavailable');
    } catch (err: unknown) {
      // The candidate side stopped being deliverable between this page loading
      // and the press. Re-read what IS on offer rather than explaining what is
      // not: the visitor sees one option instead of two, which is the whole of
      // the design.
      if (err instanceof ApiError && err.code === 'offer_observer') { await load(); return; }
      setFailure(failureFor(err instanceof ApiError ? err.status : undefined, err instanceof ApiError ? err.code : undefined));
    } finally {
      setStarting(null);
    }
  };

  if (failure) {
    const copy = failureCopy(failure);
    return (
      <div className="demo-choice">
        <PageHeader icon="ai-interview" title={copy.title} />
        <div className="card">
          <p>{copy.message}</p>
          {failure !== 'sandbox_gone' && <button className="btn" onClick={() => void load()}>{copy.action}</button>}
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="card" role="status" aria-busy="true">Loading the demo interview…</div>;
  }

  return (
    <div className="demo-choice">
      <PageHeader
        icon="ai-interview"
        title="Try the interview"
        subtitle={data.roleTitle ? `Both run against your sandbox's ${data.roleTitle} role.` : undefined}
      />

      {data.open && (
        <Banner kind="info">
          You have a demo interview open.{' '}
          <button className="link-action" onClick={() => navigate(data.open!.mode === 'observer' ? `/demo/watch/${data.open!.runId}` : '/demo')}>
            Go back to it
          </button>
        </Banner>
      )}

      {/* Offered BEFORE the choice, to everybody, with no reason asked — so
          that taking it is not a declaration about how anyone works. */}
      <div className="card demo-choice-time">
        <label className="demo-choice-check">
          <input type="checkbox" checked={extraTime} onChange={(e) => setExtraTime(e.target.checked)} />
          <span>
            <strong>Give me longer than 15 minutes.</strong>
            <span className="small muted"> Adds ten minutes. No reason needed, and nothing about you is recorded by asking.</span>
          </span>
        </label>
      </div>

      <ul className="demo-choice-list">
        {data.choices.map((choice) => (
          <li key={choice.mode} className="card demo-choice-card">
            <h2 className="demo-choice-title">
              <Icon name={choice.mode === 'candidate' ? 'mic' : 'eye'} size={18} />
              {choice.label}
            </h2>
            <p>{choice.detail}</p>
            {choice.simulated && (
              <p className="demo-choice-note">
                <Icon name="flag" size={14} /> The candidate is written, not real. Nobody is being interviewed.
              </p>
            )}
            <p className="small muted">{choice.timing}</p>
            <button
              className="btn"
              disabled={starting !== null}
              onClick={() => void start(choice.mode)}
              aria-label={`${choice.label} — start`}
            >
              {starting === choice.mode ? 'Starting…' : choice.mode === 'candidate' ? 'Start the interview' : 'Watch it'}
            </button>
          </li>
        ))}
      </ul>

    </div>
  );
}
