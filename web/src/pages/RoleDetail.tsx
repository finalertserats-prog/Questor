import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { Badge, Banner } from '../components/ui';

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

  if (loading) return <div className="muted">Loading…</div>;
  if (error) return <Banner kind="error">{error}</Banner>;
  if (!data || !profile) return <Banner kind="info">No scorecard found for this role.</Banner>;

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
      <div className="topbar">
        <div className="row">
          <h1 style={{ margin: 0 }}>{role.title}</h1>
          <Badge kind={approved ? 'green' : 'amber'}>{role.status}</Badge>
        </div>
        <div className="row">
          <button className="btn secondary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button className="btn" onClick={approve} disabled={approved}>
            {approved ? 'Approved' : 'Approve scorecard'}
          </button>
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="ok">{notice}</Banner>}
      {approved && (
        <Banner kind="ok">
          Scorecard approved — ready to interview candidates. <Link to="/candidates/new">Add a candidate</Link>
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
          <h3>Outcomes</h3>
          <ul>{(profile.outcomes ?? []).map((o, i) => <li key={i}>{o}</li>)}</ul>
        </div>
        <div className="card">
          <h3>Responsibilities</h3>
          <ul>{(profile.responsibilities ?? []).map((r, i) => <li key={i}>{r}</li>)}</ul>
        </div>
      </div>

      <div className="card">
        <h3>Competencies</h3>
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
        <div className="muted small" style={{ marginTop: 8 }}>
          Pass threshold: {Math.round((profile.scoringRules?.passThreshold ?? 0) * 100)}% ·
          Must-pass competencies: {(profile.scoringRules?.mustPassCompetencyIds ?? []).length}
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Red flags</h3>
          <div>{(profile.redFlags ?? []).map((r, i) => <span key={i} className="chip">{r}</span>)}</div>
        </div>
        <div className="card">
          <h3>Prohibited topics</h3>
          <div>{(profile.policyRules?.prohibitedTopics ?? []).map((r, i) => <span key={i} className="chip">{r}</span>)}</div>
        </div>
      </div>
    </div>
  );
}
