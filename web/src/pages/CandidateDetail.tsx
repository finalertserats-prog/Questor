import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { recBadge, stateBadge, Banner, Meter, Stat } from '../components/ui';
import { isInFlight } from './CandidatesList';
import { PipelinePanel } from '../components/PipelinePanel';
import { CandidateJourneyBoard } from '../components/CandidateJourneyBoard';
import { buildJourney, type JourneyAssessment, type JourneyPipeline, type JourneyRole } from '../components/candidateJourney';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';

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

/**
 * /candidates/:id lists a candidate's interviews but not whether any of them
 * produced an assessment, so on its own this page can only offer "open the
 * interview and look". /interviews carries assessmentId and invited, so we join
 * the two and put the assessment — the thing the recruiter actually wants — one
 * click away instead of two.
 */
interface SessionSummary {
  id: string; recommendation: string | null; assessmentId: string | null; invited: boolean;
}

/** The role and its latest scorecard: between them, the job description. */
interface RoleResp {
  role: { id: string; title: string; level: string | null };
  scorecards: Array<{
    version: number;
    status: string;
    profile: { roleContext?: string; outcomes?: string[]; responsibilities?: string[] } | null;
  }>;
}

type PipelineResp = JourneyPipeline & { candidateId: string };

interface AssessmentResp {
  id: string;
  result: {
    recommendation?: string;
    summary?: string;
    competencies?: JourneyAssessment['competencies'];
  } | null;
}

const MODULES = ['warmup', 'technical', 'behavioral', 'wrapup'];

export function CandidateDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [data, setData] = useState<CandidateResp | null>(null);
  const [sessions, setSessions] = useState<Record<string, SessionSummary>>({});
  const [role, setRole] = useState<JourneyRole | null>(null);
  const [pipeline, setPipeline] = useState<PipelineResp | null>(null);
  const [missingEvidence, setMissingEvidence] = useState<string[]>([]);
  const [assessment, setAssessment] = useState<JourneyAssessment | null>(null);
  const [assessmentBlockedReason, setAssessmentBlockedReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Bumped by the pipeline panel after any action it completes, so the journey
  // board beside it re-reads rather than showing the state before the click.
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  // interview setup form
  const [durationMinutes, setDurationMinutes] = useState(45);
  const [personaName, setPersonaName] = useState('Schranders');
  const [tone, setTone] = useState<'warm' | 'neutral' | 'formal'>('warm');
  const [provider, setProvider] = useState<'hosted' | 'teams' | 'zoom' | 'meet'>('hosted');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    api.get<CandidateResp>(`/candidates/${id}`)
      .then((candidateResp) => {
        if (cancelled) return;
        setData(candidateResp);

        // Everything below only enriches the journey. Each failure is swallowed
        // on its own: losing the role, the pipeline or the assessment must not
        // cost the operator the candidate's profile, and a column that says
        // "not available" is better than a page that says nothing.
        if (candidateResp.candidate.roleId) {
          api.get<RoleResp>(`/roles/${candidateResp.candidate.roleId}`)
            .then((r) => {
              if (cancelled) return;
              const scorecard = r.scorecards?.[0];
              setRole({
                title: r.role.title,
                level: r.role.level,
                context: scorecard?.profile?.roleContext ?? '',
                outcomes: scorecard?.profile?.outcomes ?? [],
                responsibilities: scorecard?.profile?.responsibilities ?? [],
                scorecardVersion: scorecard?.version ?? null,
                scorecardStatus: scorecard?.status ?? null,
              });
            })
            .catch(() => undefined);
        }
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load this candidate.'); })
      .finally(() => { if (!cancelled) setLoading(false); });

    api.get<{ sessions: SessionSummary[] }>('/interviews')
      .then((d) => { if (!cancelled) setSessions(Object.fromEntries((d.sessions ?? []).map((s) => [s.id, s]))); })
      .catch(() => undefined);

    // The pipeline panel below loads this too. Two reads of the same scoped
    // endpoint is the cost of leaving that panel — which owns every action —
    // exactly as it was rather than rewiring it around this page's state.
    api.get<{ pipelines: PipelineResp[] }>(`/pipelines?candidateId=${encodeURIComponent(id ?? '')}`)
      .then(async (d) => {
        const current = d.pipelines?.[0] ?? null;
        if (cancelled) return;
        setPipeline(current);
        if (!current) { setMissingEvidence([]); return; }
        const { summary } = await api.get<{ summary: { missingEvidence: string[] } }>(`/pipelines/${current.id}/summary`);
        if (!cancelled) setMissingEvidence(summary?.missingEvidence ?? []);
      })
      .catch(() => undefined);

    return () => { cancelled = true; };
  }, [id, version]);

  // The assessment the decision column reads: the newest interview that produced
  // one. Its id only becomes known once /interviews has landed, so it is fetched
  // separately rather than folded into the load above.
  const assessmentId = useMemo(() => {
    for (const interview of data?.interviews ?? []) {
      const meta = sessions[interview.id];
      if (meta?.assessmentId) return meta.assessmentId;
    }
    return null;
  }, [data, sessions]);

  useEffect(() => {
    if (!assessmentId) {
      setAssessment(null);
      setAssessmentBlockedReason(null);
      return;
    }
    let cancelled = false;
    api.get<AssessmentResp>(`/assessments/${assessmentId}`)
      .then((resp) => {
        if (cancelled) return;
        setAssessment({
          id: resp.id,
          recommendation: resp.result?.recommendation ?? null,
          summary: resp.result?.summary ?? '',
          competencies: resp.result?.competencies ?? [],
        });
        setAssessmentBlockedReason(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setAssessment(null);
        // 409 is the blind-review gate: this reviewer has not recorded their own
        // verdict yet. The server's sentence is carried through verbatim, so the
        // board cannot describe that gate more softly than the gate does.
        setAssessmentBlockedReason(err instanceof ApiError && err.status === 409 ? err.message : null);
      });
    return () => { cancelled = true; };
  }, [assessmentId, version]);

  const journey = useMemo(() => {
    if (!data) return null;
    return buildJourney({
      candidate: data.candidate,
      role,
      profile: data.profile,
      fit: data.fit,
      resumeText: data.rawText ?? '',
      sessions: data.interviews ?? [],
      sessionMeta: sessions,
      // A pipeline for a different candidate can only be a stale response; it
      // must never be drawn against this person.
      pipeline: pipeline && pipeline.candidateId === data.candidate.id ? pipeline : null,
      assessment,
      assessmentBlockedReason,
      missingEvidence,
    });
  }, [data, role, sessions, pipeline, assessment, assessmentBlockedReason, missingEvidence]);

  if (loading) return <PageSkeleton label="Loading candidate…" cards={3} />;
  if (error) return <Banner kind="error">{error}</Banner>;
  if (!data) {
    return (
      <EmptyState
        icon="user-x"
        title="Candidate not found"
        message="They may have been removed, or the link is out of date."
        action={<Link className="btn secondary" to="/candidates"><Icon name="arrow-left" size={16} />All candidates</Link>}
      />
    );
  }

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
      <PageHeader
        icon="candidates"
        title={candidate.fullName}
        subtitle={`${candidate.email}${candidate.phone ? ` · ${candidate.phone}` : ''}`}
        actions={
          <>
            <Link className="btn secondary" to="/candidates"><Icon name="arrow-left" size={16} />All candidates</Link>
            <Link className="btn secondary" to={`/roles/${candidate.roleId}`}><Icon name="role" size={16} />View role</Link>
          </>
        }
      />

      {/* The journey is the page. Everything below it is the detail behind a
          column, or the controls that change what a column says. */}
      {journey && <CandidateJourneyBoard journey={journey} />}

      <PipelinePanel candidateId={candidate.id} interviews={interviews ?? []} onChanged={refresh} />

      {fit && (
        <div className="card">
          <h2 className="card-title"><Icon name="sparkle" />Resume fit</h2>
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

          <div className="table-scroll" style={{ marginTop: 14 }} tabIndex={0} role="region" aria-label="Resume fit components">
          <table>
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
          </div>

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
          <h2 className="card-title"><Icon name="job" />Parsed profile{profile.totalYears != null ? ` · ${profile.totalYears} yrs experience` : ''}</h2>
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
        <h2 className="card-title"><Icon name="schedule" />Set up interview</h2>
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
            <Icon name={creating ? 'hourglass' : 'check-circle'} size={16} />
            {creating ? 'Creating…' : 'Approve & create interview'}
          </button>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title"><Icon name="interviews" />Interviews</h2>
        {(interviews ?? []).length === 0 ? (
          <EmptyState
            compact
            icon="interviews"
            illustration="/brand/empty-interviews.webp"
            illustrationWidth={360}
            illustrationHeight={331}
            title="No interviews yet"
            message="Use “Set up interview” above to create one for this candidate."
          />
        ) : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Interviews for this candidate">
          <table>
            <thead>
              <tr>
                <th>State</th><th>Recommendation</th><th>Scheduled</th><th>Created</th><th>Open</th>
              </tr>
            </thead>
            <tbody>
              {interviews.map((iv) => {
                const s = sessions[iv.id];
                return (
                  <tr key={iv.id} className={isInFlight(iv.state) ? 'in-flight' : undefined}>
                    <td>
                      <span className="row" style={{ gap: 6 }}>
                        {stateBadge(iv.state)}
                        {isInFlight(iv.state) && <span className="inflight-note">in progress</span>}
                      </span>
                    </td>
                    <td>{recBadge(s?.recommendation)}</td>
                    <td>{iv.scheduledAt ? new Date(iv.scheduledAt).toLocaleString() : <span className="muted">—</span>}</td>
                    <td>{new Date(iv.createdAt).toLocaleString()}</td>
                    <td>
                      {/* Both routes are always offered. The assessment is what the
                          recruiter came for when it exists; the interview page is
                          where the invitation lives — resend, portal link, schedule —
                          and that is the only thing that helps when it does not. */}
                      <span className="row" style={{ gap: 10 }}>
                        <Link to={`/interviews/${iv.id}`}><Icon name="interviews" size={15} />Interview</Link>
                        {s?.assessmentId
                          ? <Link to={`/assessments/${s.assessmentId}`}><Icon name="evidence" size={15} />Assessment</Link>
                          : <Link
                              className="muted"
                              to={`/interviews/${iv.id}`}
                              title={s && !s.invited
                                ? 'No invitation has been sent yet — send one from the interview page.'
                                : 'Resend the invitation email or copy the portal link from the interview page.'}
                            >
                              {s && !s.invited ? 'Invitation (not sent)' : 'Invitation'}
                            </Link>}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
