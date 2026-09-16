import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { Badge, Banner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';
import { hasScore } from '../components/scoreFormat';

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
