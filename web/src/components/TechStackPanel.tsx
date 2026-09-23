import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Banner } from './ui';
import { Icon } from './Icon';
import { TechStackEditor } from './TechStackEditor';
import {
  confirmQuestion, jdDiffLines, proposalPayload, withoutProposal,
  type KnownTechnology, type StackProposal, type TechStackItem,
} from './techStackModel';

interface JdChange {
  readonly changed: boolean;
  readonly kind: 'inserted' | 'replaced' | 'removed' | 'unchanged';
  readonly before: string[];
  readonly after: string[];
  readonly lint: { term: string; suggestion: string }[];
  readonly updated?: boolean;
}
interface StackResponse { readonly techStack: TechStackItem[]; readonly jd: JdChange; readonly proposals: StackProposal[] }

interface Props {
  readonly roleId: string;
  readonly initial: readonly TechStackItem[];
  readonly locked: boolean;
  /** A change was written; the parent reloads the role and shows the notice. */
  readonly onStored: (notice: string) => void;
}

/**
 * The role's tech stack on the role page. Saving previews what the job
 * description would gain or lose and asks before touching it; the reply's
 * proposed competencies wait here for HR to add one at a time through the
 * same add flow the competency editor uses.
 */
export function TechStackPanel({ roleId, initial, locked, onStored }: Props) {
  const [stack, setStack] = useState<readonly TechStackItem[]>(initial);
  const [catalog, setCatalog] = useState<readonly KnownTechnology[]>([]);
  const [preview, setPreview] = useState<JdChange | null>(null);
  const [updateJd, setUpdateJd] = useState(true);
  const [proposals, setProposals] = useState<readonly StackProposal[]>([]);
  const [lint, setLint] = useState<JdChange['lint']>([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState('');
  const [error, setError] = useState('');

  const saved = JSON.stringify(initial);
  // A reload after a save brings the stored stack back; the editor follows it.
  useEffect(() => { setStack(JSON.parse(saved) as TechStackItem[]); }, [saved]);

  useEffect(() => {
    let live = true;
    api.get<{ technologies: KnownTechnology[] }>('/roles/tech-stack/catalog')
      .then((d) => { if (live) setCatalog(d.technologies); })
      // Suggestions are a convenience; typing works without them.
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  const dirty = JSON.stringify(stack) !== saved;

  const write = async (withJd: boolean) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.patch<StackResponse>(`/roles/${roleId}/tech-stack`, { techStack: stack, updateJd: withJd });
      setPreview(null);
      setProposals(res.proposals);
      setLint(res.jd.updated ? res.jd.lint : []);
      onStored(res.jd.updated ? 'Tech stack saved and the job description updated.' : 'Tech stack saved.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the tech stack.');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (busy || !dirty) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.post<StackResponse>(`/roles/${roleId}/tech-stack/preview`, { techStack: stack });
      if (!res.jd.changed) { await write(false); return; }
      setPreview(res.jd);
      setUpdateJd(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not check the job description.');
    } finally {
      setBusy(false);
    }
  };

  const addProposal = async (p: StackProposal) => {
    if (adding) return;
    setAdding(p.name);
    setError('');
    try {
      await api.post(`/roles/${roleId}/scorecard/competencies`, proposalPayload(p));
      setProposals((list) => withoutProposal(list, p.name));
      onStored(`${p.name} added to the scorecard.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not add the competency.');
    } finally {
      setAdding('');
    }
  };

  return (
    <div className="card" data-testid="tech-stack-panel">
      <h2 className="card-title"><Icon name="list" size={16} />Tech stack</h2>
      <p className="muted small">
        The technologies this role works with, and how deep the hire needs to be in each. The job description,
        the competencies and the interview follow what is set here.
      </p>
      <TechStackEditor idPrefix="role-stack" value={stack} onChange={setStack} catalog={catalog} disabled={locked || busy} />
      {error && <Banner kind="error">{error}</Banner>}
      {preview && (
        <div className="stack-confirm" role="group" aria-label="Job description change" data-testid="tech-stack-confirm">
          <p><strong>{confirmQuestion(preview.kind, stack.length)}</strong></p>
          <pre className="stack-diff">
            {jdDiffLines(preview.before, preview.after).map((line, i) => (
              <span key={i} className={`stack-diff-${line.kind}`}>{line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}{line.text}{'\n'}</span>
            ))}
          </pre>
          <p className="muted small">Only this section changes; the rest of the job description is left as written.</p>
          <label className="check-label">
            <input type="checkbox" checked={updateJd} onChange={(e) => setUpdateJd(e.target.checked)} /> Update the job description
          </label>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button type="button" className="btn" disabled={busy} onClick={() => void write(updateJd)} data-testid="tech-stack-confirm-yes">
              <Icon name={busy ? 'hourglass' : 'save'} size={16} />{busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn secondary" disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
          </div>
        </div>
      )}
      {!preview && (
        <div className="row" style={{ gap: 10, alignItems: 'center', marginTop: 8 }}>
          <button type="button" className="btn secondary" onClick={() => void save()} disabled={busy || !dirty || locked} data-testid="tech-stack-save">
            <Icon name={busy ? 'hourglass' : 'save'} size={16} />{busy ? 'Checking…' : 'Save tech stack'}
          </button>
          {dirty && <span className="muted small">Unsaved tech stack changes.</span>}
        </div>
      )}
      {lint.length > 0 && (
        <p className="small" style={{ marginTop: 8 }}>
          The job description still has wording to reconsider: {lint.map((l) => `${l.term} (${l.suggestion})`).join('; ')}
        </p>
      )}
      {proposals.length > 0 && (
        <div className="stack-proposals" data-testid="tech-stack-proposals">
          <p><strong>Competencies this stack suggests</strong> — add the ones you want assessed; nothing is added until you do.</p>
          <ul className="stack-proposal-list">
            {proposals.map((p) => (
              <li key={p.name} className="stack-proposal" data-testid="tech-stack-proposal">
                <div>
                  <strong>{p.name}</strong> <span className="muted small">· required level {p.requiredLevel}/5</span>
                  <p className="small" style={{ margin: '4px 0' }}>{p.definition}</p>
                  <ul className="small" style={{ margin: 0 }}>{p.indicators.map((ind) => <li key={ind}>{ind}</li>)}</ul>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button type="button" className="btn secondary sm" disabled={Boolean(adding) || locked} onClick={() => void addProposal(p)} data-testid="tech-stack-proposal-add">
                    <Icon name={adding === p.name ? 'hourglass' : 'plus'} size={14} />{adding === p.name ? 'Adding…' : 'Add to scorecard'}
                  </button>
                  <button type="button" className="link-button" onClick={() => setProposals((list) => withoutProposal(list, p.name))}>Dismiss</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
