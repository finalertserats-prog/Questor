import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { Badge, Banner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';
import { hasScore } from '../components/scoreFormat';
import { weightsProblem, weightsTotal } from '../components/scorecardModel';

type Category = 'technical' | 'domain' | 'behavioral' | 'situational' | 'communication';
type Classification = 'essential' | 'preferred' | 'trainable' | 'non_scoring';

interface Competency {
  id: string; name: string; definition: string; category: Category;
  classification: Classification; weight: number; requiredLevel: number; targetLevel: number;
  indicators: string[];
}
interface Profile {
  roleContext: string; seniority: string; outcomes: string[]; responsibilities: string[];
  redFlags: string[]; competencies: Competency[];
  scoringRules: { mustPassCompetencyIds: string[]; passThreshold: number };
  policyRules: { prohibitedTopics: string[] };
}
interface Scorecard { id: string; version: number; status: string; profile: Profile; approvedAt: string | null; }
interface RoleResp {
  role: { id: string; title: string; level: string; location: string; employmentType: string; status: string; sourceType: string };
  scorecards: Scorecard[];
}

const CLASSIFICATIONS: Classification[] = ['essential', 'preferred', 'trainable', 'non_scoring'];

function catKind(c: Category): 'blue' | 'gray' {
  return c === 'technical' || c === 'domain' ? 'blue' : 'gray';
}
export function RoleDetail() {
  const { id } = useParams();
  const [data, setData] = useState<RoleResp | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  // The profile exactly as it was loaded. "Dirty" is the difference from this,
  // not a flag someone has to remember to set on every edit path.
  const [saved, setSaved] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  // Half-typed weights, by competency id. They live here rather than in the
  // profile so that "" never reaches the scorecard as 0%.
  const [weightDrafts, setWeightDrafts] = useState<Record<string, string>>({});

  // `cancelled` so a response for a role the person has already left cannot
  // overwrite what they are looking at now.
  const cancelledRef = useRef(false);

  const load = () => {
    setLoading(true);
    api.get<RoleResp>(`/roles/${id}`)
      .then((d) => {
        if (cancelledRef.current) return;
        const next = d.scorecards?.[0]?.profile ?? null;
        setData(d);
        setProfile(next);
        setSaved(JSON.stringify(next));
      })
      .catch((err: unknown) => {
        if (!cancelledRef.current) setError(err instanceof Error ? err.message : 'Could not load this role.');
      })
      .finally(() => { if (!cancelledRef.current) setLoading(false); });
  };

  useEffect(() => {
    cancelledRef.current = false;
    load();
    return () => { cancelledRef.current = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const dirty = profile !== null && JSON.stringify(profile) !== saved;

  // Closing the tab is the one departure the browser will let us question.
  // In-app navigation cannot be blocked here — this router has no data router
  // to hang a blocker on — so the unsaved marker beside Save carries that job.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (loading) return <PageSkeleton label="Loading role…" cards={3} />;
  if (error) return <Banner kind="error">{error}</Banner>;
  if (!data || !profile) {
    return (
      <EmptyState
        icon="role"
        title="No scorecard found for this role"
        message="A scorecard is drafted from the job description. Create the role again from its JD to generate one."
        action={<Link className="btn" to="/roles/new"><Icon name="plus" size={16} />New role</Link>}
      />
    );
  }

  const role = data.role;
  const scorecard = data.scorecards[0];
  const approved = scorecard?.status === 'approved';

  const clearWeightDraft = (competencyId: string) =>
    setWeightDrafts((drafts) => Object.fromEntries(Object.entries(drafts).filter(([key]) => key !== competencyId)));

  const weightsError = weightsProblem(profile.competencies ?? []);
  const total = weightsTotal(profile.competencies ?? []);

  const updateComp = (i: number, patch: Partial<Competency>) => {
    setProfile((p) => {
      if (!p) return p;
      const competencies = p.competencies.map((c, idx) => {
        if (idx !== i) return c;
        const next = { ...c, ...patch };
        // A non-scoring competency weighs nothing by definition. Leaving its old
        // weight behind would keep it in a total it no longer contributes to.
        return next.classification === 'non_scoring' ? { ...next, weight: 0 } : next;
      });
      return { ...p, competencies };
    });
  };

  const save = async () => {
    if (weightsError || !dirty) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await api.put<{ scorecard: Scorecard }>(`/roles/${id}/scorecard`, { profile });
      setNotice('Changes saved.');
      load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save the scorecard.');
    } finally {
      setSaving(false);
    }
  };

  const approve = async () => {
    setError('');
    try {
      await api.post<{ scorecard: Scorecard }>(`/roles/${id}/approve`, {});
      load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not approve the scorecard.');
    }
  };

  return (
    <div>
      <PageHeader
        icon="role"
        title={role.title}
        badge={
          <span className={`badge ${approved ? 'green' : 'amber'} status-badge`}>
            <Icon name={approved ? 'check-circle' : 'draft'} size={13} />{role.status}
          </span>
        }
        actions={
          <>
            {/* Marked with words rather than a colour: nothing to save, and a
                total the server will refuse, are different reasons for the same
                disabled button. */}
            <button
              className="btn secondary"
              onClick={save}
              disabled={saving || !dirty || weightsError !== null}
              title={weightsError ?? (dirty ? undefined : 'No changes to save')}
            >
              <Icon name={saving ? 'hourglass' : 'save'} size={16} />
              {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </button>
            {/* Approving with edits still on screen approved the version the
                server holds — the one nobody was looking at — while the page
                showed the edited values. Save first, then approve what you can
                see. */}
            <button
              className="btn"
              onClick={approve}
              disabled={approved || dirty}
              title={dirty ? 'Save your changes first — approving would approve the saved version, not these edits.' : undefined}
            >
              <Icon name="check-circle" size={16} />
              {approved ? 'Approved' : 'Approve scorecard'}
            </button>
          </>
        }
      />

      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="ok">{notice}</Banner>}
      {dirty && <p className="muted small">Unsaved changes — they are lost if you leave this page.</p>}
      {approved && (
        <Banner kind="ok">
          Scorecard approved — ready to interview candidates.{' '}
          <Link className="link-action" to="/candidates/new"><Icon name="add-candidate" size={15} />Add a candidate</Link>
        </Banner>
      )}

      <div className="card">
        <div className="muted small">
          {/* No scorecard yet means no version to name; "scorecard v" on its
              own reads as a truncated one. */}
          {role.level} · {role.location} · {role.employmentType}
          {scorecard && hasScore(scorecard.version) ? ` · scorecard v${scorecard.version}` : ''}
        </div>
        <p style={{ marginBottom: 0 }}>{profile.roleContext}</p>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3 className="card-title"><Icon name="flag" size={16} />Outcomes</h3>
          <ul>{(profile.outcomes ?? []).map((o, i) => <li key={i}>{o}</li>)}</ul>
        </div>
        <div className="card">
          <h3 className="card-title"><Icon name="list" size={16} />Responsibilities</h3>
          <ul>{(profile.responsibilities ?? []).map((r, i) => <li key={i}>{r}</li>)}</ul>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title"><Icon name="evidence" size={16} />Competencies</h3>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Competencies">
        <table>
          <thead>
            <tr>
              <th>Name</th><th>Category</th><th>Classification</th><th>Weight</th><th>Req/Target</th>
            </tr>
          </thead>
          <tbody>
            {(profile.competencies ?? []).map((c, i) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td><Badge kind={catKind(c.category)}>{c.category}</Badge></td>
                <td>
                  <select
                    value={c.classification}
                    onChange={(e) => {
                      // A non-scoring competency has its weight zeroed, so any
                      // half-typed weight beside it is no longer what it says.
                      clearWeightDraft(c.id);
                      updateComp(i, { classification: e.target.value as Classification });
                    }}
                  >
                    {CLASSIFICATIONS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </td>
                <td style={{ minWidth: 120 }}>
                  <div className="row" style={{ gap: 6 }}>
                    {/* An empty field is someone part-way through typing, not a
                        weight of nothing: Number('') is 0, and clearing the box
                        used to set the competency to 0% on the spot. The draft
                        holds the half-typed value; the stored weight only moves
                        when there is a number to move it to. */}
                    <input
                      type="number" min={0} max={100} step={5}
                      aria-label={`Weight for ${c.name}, percent`}
                      value={weightDrafts[c.id] ?? String(Math.round(c.weight * 100))}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setWeightDrafts((drafts) => ({ ...drafts, [c.id]: raw }));
                        if (!raw.trim() || !Number.isFinite(Number(raw))) return;
                        updateComp(i, { weight: Math.max(0, Math.min(100, Number(raw))) / 100 });
                      }}
                      onBlur={() => clearWeightDraft(c.id)}
                      style={{ width: 70 }}
                    />
                    <span className="muted small">%</span>
                  </div>
                </td>
                <td className="muted">{c.requiredLevel} / {c.targetLevel}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {/* The total the server checks, shown where the weights are edited —
            otherwise the first anyone hears of it is a refused save. */}
        <div className="row spread" style={{ marginTop: 8 }}>
          <span className="small">Scored weights total {total}%</span>
          {weightsError && <span className="small">[ must total 100% ]</span>}
        </div>
        {weightsError && <Banner kind="error">{weightsError}</Banner>}
        <div className="muted small" style={{ marginTop: 8 }}>
          Pass threshold: {Math.round((profile.scoringRules?.passThreshold ?? 0) * 100)}% ·
          Must-pass competencies: {(profile.scoringRules?.mustPassCompetencyIds ?? []).length}
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3 className="card-title"><Icon name="alert" size={16} />Red flags</h3>
          <div>{(profile.redFlags ?? []).map((r, i) => <span key={i} className="chip">{r}</span>)}</div>
        </div>
        <div className="card">
          <h3 className="card-title"><Icon name="stop" size={16} />Prohibited topics</h3>
          <div>{(profile.policyRules?.prohibitedTopics ?? []).map((r, i) => <span key={i} className="chip">{r}</span>)}</div>
        </div>
      </div>
    </div>
  );
}
