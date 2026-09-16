import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { Badge, Banner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';
import {
  PASS_THRESHOLD_MAX,
  PASS_THRESHOLD_MIN,
  RED_FLAG_MAX_LENGTH,
  addRedFlag,
  clampPassThreshold,
  formatPassThreshold,
  redFlagProblem,
  removeRedFlag,
} from '../components/scorecardModel';

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
function classKind(c: Classification): 'green' | 'amber' | 'gray' {
  return c === 'essential' ? 'green' : c === 'preferred' ? 'amber' : 'gray';
}

export function RoleDetail() {
  const { id } = useParams();
  const [data, setData] = useState<RoleResp | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [newFlag, setNewFlag] = useState('');
  const [flagProblem, setFlagProblem] = useState('');

  const load = () => {
    setLoading(true);
    api.get<RoleResp>(`/roles/${id}`)
      .then((d) => { setData(d); setProfile(d.scorecards?.[0]?.profile ?? null); })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, [id]);

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

  const updateComp = (i: number, patch: Partial<Competency>) => {
    setProfile((p) => {
      if (!p) return p;
      const competencies = p.competencies.map((c, idx) => (idx === i ? { ...c, ...patch } : c));
      return { ...p, competencies };
    });
  };

  // Points out of 100, unlike the weights above, which are fractions. Mixing
  // the two up is how this page once showed "Pass threshold: 6500%".
  const updateThreshold = (raw: number) => {
    setProfile((p) => (p ? { ...p, scoringRules: { ...p.scoringRules, passThreshold: clampPassThreshold(raw) } } : p));
  };

  const submitFlag = () => {
    if (!profile) return;
    const problem = redFlagProblem(profile.redFlags ?? [], newFlag);
    if (problem) {
      setFlagProblem(problem);
      return;
    }
    setProfile((p) => (p ? { ...p, redFlags: [...addRedFlag(p.redFlags ?? [], newFlag)] } : p));
    setNewFlag('');
    setFlagProblem('');
  };

  const dropFlag = (index: number) => {
    setProfile((p) => (p ? { ...p, redFlags: [...removeRedFlag(p.redFlags ?? [], index)] } : p));
  };

  const save = async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await api.put<{ scorecard: Scorecard }>(`/roles/${id}/scorecard`, { profile });
      setNotice('Changes saved.');
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const approve = async () => {
    setError('');
    try {
      await api.post<{ scorecard: Scorecard }>(`/roles/${id}/approve`, {});
      load();
    } catch (err: any) {
      setError(err.message);
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
            <button className="btn secondary" onClick={save} disabled={saving}>
              <Icon name={saving ? 'hourglass' : 'save'} size={16} />
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            <button className="btn" onClick={approve} disabled={approved}>
              <Icon name="check-circle" size={16} />
              {approved ? 'Approved' : 'Approve scorecard'}
            </button>
          </>
        }
      />

      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="ok">{notice}</Banner>}
      {approved && (
        <Banner kind="ok">
          Scorecard approved — ready to interview candidates.{' '}
          <Link className="link-action" to="/candidates/new"><Icon name="add-candidate" size={15} />Add a candidate</Link>
        </Banner>
      )}

      <div className="card">
        <div className="muted small">
          {role.level} · {role.location} · {role.employmentType} · scorecard v{scorecard?.version}
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
                    onChange={(e) => updateComp(i, { classification: e.target.value as Classification })}
                  >
                    {CLASSIFICATIONS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </td>
                <td style={{ minWidth: 120 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <input
                      type="number" min={0} max={100} step={5}
                      value={Math.round(c.weight * 100)}
                      onChange={(e) => updateComp(i, { weight: Math.max(0, Math.min(100, Number(e.target.value))) / 100 })}
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
        <div className="row" style={{ marginTop: 10, gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor="pass-threshold" className="muted small" style={{ margin: 0 }}>Pass threshold</label>
          <input
            id="pass-threshold"
            type="number"
            min={PASS_THRESHOLD_MIN}
            max={PASS_THRESHOLD_MAX}
            step={1}
            value={profile.scoringRules?.passThreshold ?? ''}
            onChange={(e) => updateThreshold(Number(e.target.value))}
            aria-describedby="pass-threshold-hint"
            style={{ width: 80 }}
          />
          <span className="muted small">out of 100 · currently {formatPassThreshold(profile.scoringRules?.passThreshold)}</span>
          <span className="muted small">· Must-pass competencies: {(profile.scoringRules?.mustPassCompetencyIds ?? []).length}</span>
        </div>
        <p id="pass-threshold-hint" className="field-hint" style={{ marginTop: 4 }}>
          The overall score a candidate needs to be recommended to proceed. Weights are shares of that score; the
          threshold is the score itself.
        </p>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3 className="card-title"><Icon name="alert" size={16} />Red flags</h3>
          <p className="muted small">
            Things the interviewer should note if they come up. They are flagged for a person to weigh, never
            scored.
          </p>
          {(profile.redFlags ?? []).length === 0 && <p className="muted small">None yet.</p>}
          <ul className="flag-list" aria-label="Red flags">
            {(profile.redFlags ?? []).map((r, i) => (
              <li key={`${i}-${r}`} className="flag-item">
                <span>{r}</span>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => dropFlag(i)}
                  aria-label={`Remove red flag: ${r}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <form
            className="row"
            style={{ gap: 8, alignItems: 'flex-start', marginTop: 8 }}
            onSubmit={(e) => { e.preventDefault(); submitFlag(); }}
          >
            <div style={{ flex: 1 }}>
              <label htmlFor="new-red-flag" className="muted small">Add a red flag</label>
              <input
                id="new-red-flag"
                value={newFlag}
                maxLength={RED_FLAG_MAX_LENGTH}
                onChange={(e) => { setNewFlag(e.target.value); if (flagProblem) setFlagProblem(''); }}
                placeholder="e.g. Cannot describe their own contribution to a team result"
                aria-describedby={flagProblem ? 'new-red-flag-problem' : undefined}
                aria-invalid={flagProblem ? true : undefined}
              />
              {flagProblem && <p id="new-red-flag-problem" className="field-hint field-problem">{flagProblem}</p>}
            </div>
            <button type="submit" className="btn secondary" style={{ marginTop: 22 }}>Add</button>
          </form>
          <p className="muted small" style={{ marginTop: 8 }}>Changes take effect when you save.</p>
        </div>
        <div className="card">
          <h3 className="card-title"><Icon name="stop" size={16} />Prohibited topics</h3>
          <div>{(profile.policyRules?.prohibitedTopics ?? []).map((r, i) => <span key={i} className="chip">{r}</span>)}</div>
        </div>
      </div>
    </div>
  );
}
