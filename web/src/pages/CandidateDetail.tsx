import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { stateBadge, Banner, Meter, Stat } from '../components/ui';

interface Employment { title: string; company: string; start?: string; end?: string; bullets: string[]; }
interface Education { degree: string; institution: string; year?: string; }
interface Project { name: string; summary: string; }
interface Profile {
  employment: Employment[]; education: Education[]; projects: Project[];
  certifications: string[]; skills: string[]; totalYears?: number;
}
interface FitComponent { key: string; label: string; weight: number; score: number; evidence: string[]; rule: string; }
interface Fit {
  overall: number; confidence: number; components: FitComponent[];
  missing: string[]; probes: string[]; excludedSignals: string[];
}
interface Interview { id: string; state: string; scheduledAt: string | null; createdAt: string; }
interface CandidateResp {
  candidate: { id: string; fullName: string; email: string; phone: string; roleId: string };
  profile: Profile | null; fit: Fit | null; rawText: string; interviews: Interview[];
}

const MODULES = ['warmup', 'technical', 'behavioral', 'wrapup'];

export function CandidateDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState<CandidateResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // interview setup form
  const [durationMinutes, setDurationMinutes] = useState(45);
  const [personaName, setPersonaName] = useState('Schranders');
  const [tone, setTone] = useState<'warm' | 'neutral' | 'formal'>('warm');
  const [provider, setProvider] = useState<'hosted' | 'teams' | 'zoom' | 'meet'>('hosted');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  useEffect(() => {
    api.get<CandidateResp>(`/candidates/${id}`)
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="muted">Loading…</div>;
  if (error) return <Banner kind="error">{error}</Banner>;
  if (!data) return <Banner kind="info">Candidate not found.</Banner>;

  const { candidate, profile, fit, interviews } = data;

  const createInterview = async () => {
    setCreating(true);
    setCreateError('');
    try {
      const resp = await api.post<{ session: { id: string; state: string; provider: string } }>('/interviews', {
        candidateId: candidate.id,
        durationMinutes,
        language: 'en',
        modules: MODULES,
        persona: { name: personaName, tone },
        provider,
        // Always false: no audio artefact is produced, so requesting one would
        // only set a flag that misleads whoever reads it back.
        recordingRequested: false,
        humanReviewRequired: true,
        approve: true,
      });
      nav(`/interviews/${resp.session.id}`);
    } catch (err: any) {
      setCreateError(err.message);
      setCreating(false);
    }
  };

  return (
    <div>
      <div className="topbar">
        <div>
          <h1 style={{ margin: 0 }}>{candidate.fullName}</h1>
          <div className="muted small">{candidate.email}{candidate.phone ? ` · ${candidate.phone}` : ''}</div>
        </div>
        <Link className="btn secondary" to={`/roles/${candidate.roleId}`}>View role</Link>
      </div>

      {fit && (
        <div className="card">
          <h2>Resume fit</h2>
          <div className="grid cols-2">
            <div>
              <div className="row spread">
                <span className="muted small">Overall fit</span>
                <b>{Math.round(fit.overall)}/100</b>
              </div>
              <Meter value={fit.overall} />
            </div>
            <Stat label="Confidence" value={`${Math.round(fit.confidence * 100)}%`} />
          </div>

          <table style={{ marginTop: 14 }}>
            <thead>
              <tr><th>Component</th><th>Weight</th><th>Score</th><th>Rule</th></tr>
            </thead>
            <tbody>
              {(fit.components ?? []).map((c) => (
                <tr key={c.key}>
                  <td>{c.label}</td>
                  <td>{Math.round(c.weight * 100)}%</td>
                  <td style={{ minWidth: 140 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <span style={{ width: 34 }}>{Math.round(c.score)}</span>
                      <div style={{ flex: 1 }}><Meter value={c.score} /></div>
                    </div>
                  </td>
                  <td className="muted small">{c.rule}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="grid cols-2" style={{ marginTop: 14 }}>
            <div>
              <h3>Missing signals</h3>
              {(fit.missing ?? []).length === 0
                ? <div className="muted small">None flagged.</div>
                : <ul>{fit.missing.map((m, i) => <li key={i}>{m}</li>)}</ul>}
            </div>
            <div>
              <h3>Suggested probes</h3>
              {(fit.probes ?? []).length === 0
                ? <div className="muted small">None.</div>
                : <ul>{fit.probes.map((p, i) => <li key={i}>{p}</li>)}</ul>}
            </div>
          </div>

          {(fit.excludedSignals ?? []).length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="muted small" style={{ marginBottom: 4 }}>
                Deliberately ignored (fairness):
              </div>
              <div>{fit.excludedSignals.map((s, i) => <span key={i} className="chip muted">{s}</span>)}</div>
            </div>
          )}
        </div>
      )}

      {profile && (
        <div className="card">
          <h2>Parsed profile{profile.totalYears != null ? ` · ${profile.totalYears} yrs experience` : ''}</h2>
          {(profile.skills ?? []).length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <h3>Skills</h3>
              <div>{profile.skills.map((s, i) => <span key={i} className="chip">{s}</span>)}</div>
            </div>
          )}
          {(profile.employment ?? []).length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <h3>Employment</h3>
              {profile.employment.map((e, i) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <div><b>{e.title}</b> — {e.company} <span className="muted small">{e.start ?? ''}{e.end ? ` – ${e.end}` : ''}</span></div>
                  <ul style={{ margin: '4px 0 0' }}>{(e.bullets ?? []).map((b, j) => <li key={j} className="small">{b}</li>)}</ul>
                </div>
              ))}
            </div>
          )}
          {(profile.education ?? []).length > 0 && (
            <div>
              <h3>Education</h3>
              <ul>{profile.education.map((e, i) => <li key={i}>{e.degree} — {e.institution}{e.year ? ` (${e.year})` : ''}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>Set up interview</h2>
        {createError && <Banner kind="error">{createError}</Banner>}
        <div className="grid cols-3">
          <div>
            <label>Duration (minutes)</label>
            <input type="number" min={15} max={120} value={durationMinutes}
              onChange={(e) => setDurationMinutes(Number(e.target.value))} />
          </div>
          <div>
            <label>Persona name</label>
            <input value={personaName} onChange={(e) => setPersonaName(e.target.value)} />
          </div>
          <div>
            <label>Tone</label>
            <select value={tone} onChange={(e) => setTone(e.target.value as typeof tone)}>
              <option value="warm">warm</option>
              <option value="neutral">neutral</option>
              <option value="formal">formal</option>
            </select>
          </div>
          <div>
            <label>Provider</label>
            <select value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
              <option value="hosted">hosted</option>
              <option value="teams">teams</option>
              <option value="zoom">zoom</option>
              <option value="meet">meet</option>
            </select>
          </div>
          {/* The "Request recording" checkbox is gone. It set a flag that
              produced no audio anywhere in the system, so a recruiter ticking it
              believed they were commissioning a recording they would never
              receive — and the candidate was shown a consent notice implying the
              same. Stating what the product actually does is the honest control
              here; a toggle for a capability that does not exist is not. */}
          <div>
            <label>Record of the interview</label>
            <div className="muted small" style={{ marginTop: 5 }}>
              A written transcript, kept and reviewed by a person. No audio is stored.
            </div>
          </div>
        </div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn" onClick={createInterview} disabled={creating}>
            {creating ? 'Creating…' : 'Approve & create interview'}
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Interviews</h2>
        {(interviews ?? []).length === 0 ? (
          <div className="muted small">No interviews yet.</div>
        ) : (
          <table>
            <thead><tr><th>State</th><th>Scheduled</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {interviews.map((iv) => (
                <tr key={iv.id}>
                  <td>{stateBadge(iv.state)}</td>
                  <td>{iv.scheduledAt ? new Date(iv.scheduledAt).toLocaleString() : <span className="muted">—</span>}</td>
                  <td>{new Date(iv.createdAt).toLocaleString()}</td>
                  <td><Link to={`/interviews/${iv.id}`}>Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
