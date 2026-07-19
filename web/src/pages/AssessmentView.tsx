import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { Badge, recBadge, Banner, Stat, Markdown } from '../components/ui';

interface Evidence { turnId: string; startMs: number; endMs: number; quote: string; }
interface Competency {
  id: string; name: string; level: number | null; requiredLevel: number; confidence: number;
  notEnoughEvidence: boolean; evidence: Evidence[]; rationale: string;
}
interface AssessmentResult {
  recommendation: string; confidence: number; evidenceCoverage: number; overallScore: number;
  summary: string; competencies: Competency[];
  strengths: string[]; concerns: string[]; contradictions: string[];
  openQuestions: string[]; limitations: string[];
}
interface Review { id: string; status: string; disposition: string; reason: string; overrides: unknown[]; completedAt: string | null; }
interface AssessmentResp {
  id: string; sessionId: string;
  candidate: { id: string; name: string }; role: { id: string; title: string };
  result: AssessmentResult; reviews: Review[];
}

type Disposition = 'PROCEED' | 'CONSIDER' | 'DO_NOT_PROGRESS';

function StringCard({ title, items }: { title: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="card">
      <h3>{title}</h3>
      <ul style={{ margin: 0 }}>{items.map((s, i) => <li key={i}>{s}</li>)}</ul>
    </div>
  );
}

export function AssessmentView() {
  const { id } = useParams();
  const [data, setData] = useState<AssessmentResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [disposition, setDisposition] = useState<Disposition>('CONSIDER');
  const [reason, setReason] = useState('');
  const [comments, setComments] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [exportStatus, setExportStatus] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [report, setReport] = useState('');
  const [reportLoading, setReportLoading] = useState(false);

  const load = () => {
    api.get<AssessmentResp>(`/assessments/${id}`)
      .then((d) => { setData(d); setDisposition((d.result?.recommendation as Disposition) ?? 'CONSIDER'); })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { setLoading(true); load(); }, [id]);

  if (loading) return <div className="muted">Loading…</div>;
  if (error && !data) return <Banner kind="error">{error}</Banner>;
  if (!data) return <Banner kind="info">Assessment not found.</Banner>;

  const { candidate, role, result, reviews } = data;

  const submitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setSubmitting(true);
    try {
      await api.post(`/assessments/${id}/review`, {
        disposition, reason, comments: comments || undefined, overrides: [],
      });
      setNotice('Review submitted.');
      setReason('');
      setComments('');
      load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const doExport = async () => {
    setExportStatus('');
    try {
      const r = await api.post<{ status: string }>(`/assessments/${id}/export`, {});
      setExportStatus(r.status);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const toggleReport = async () => {
    if (showReport) { setShowReport(false); return; }
    if (!report) {
      setReportLoading(true);
      try {
        const r = await api.get<{ report: string; result: AssessmentResult }>(`/assessments/${id}/report?format=json`);
        setReport(r.report);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setReportLoading(false);
      }
    }
    setShowReport(true);
  };

  return (
    <div>
      <div className="topbar">
        <div className="row">
          <h1 style={{ margin: 0 }}>Assessment</h1>
          {recBadge(result.recommendation)}
        </div>
        <div className="row">
          <button className="btn secondary" onClick={doExport}>Export to ATS</button>
          <button className="btn ghost" onClick={toggleReport}>
            {showReport ? 'Hide full report' : 'View full report'}
          </button>
        </div>
      </div>

      <div className="muted small" style={{ marginBottom: 12 }}>
        <Link to={`/candidates/${candidate.id}`}>{candidate.name}</Link> · {role.title}
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="ok">{notice}</Banner>}
      {exportStatus && <Banner kind="info">Export status: {exportStatus}</Banner>}

      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        <Stat label="Overall score" value={`${Math.round(result.overallScore)}/100`} />
        <Stat label="Confidence" value={`${Math.round(result.confidence * 100)}%`} />
        <Stat label="Evidence coverage" value={`${Math.round(result.evidenceCoverage * 100)}%`} />
      </div>

      <div className="card">
        <h2>Summary</h2>
        <p style={{ marginBottom: 0 }}>{result.summary}</p>
      </div>

      {showReport && (
        <div className="card">
          <h2>Full report</h2>
          {reportLoading ? <div className="muted">Loading…</div> : <Markdown text={report} />}
        </div>
      )}

      <div className="card">
        <h2>Competency scorecard</h2>
        <table>
          <thead>
            <tr><th>Competency</th><th>Level</th><th>Required</th><th>Confidence</th><th>Evidence</th></tr>
          </thead>
          <tbody>
            {(result.competencies ?? []).map((c) => (
              <tr key={c.id}>
                <td>
                  {c.name}
                  {c.rationale && <div className="muted small" style={{ marginTop: 4 }}>{c.rationale}</div>}
                  {(c.evidence ?? []).length > 0 && (
                    <div style={{ marginTop: 6 }}>
                      {c.evidence.map((e, i) => (
                        <div key={i} className="muted small" style={{ borderLeft: '3px solid var(--border)', paddingLeft: 8, margin: '4px 0' }}>
                          “{e.quote}”
                        </div>
                      ))}
                    </div>
                  )}
                </td>
                <td>
                  {c.notEnoughEvidence
                    ? <Badge kind="amber">Not Enough Evidence</Badge>
                    : <b>{c.level ?? '—'}/5</b>}
                </td>
                <td className="muted">{c.requiredLevel}/5</td>
                <td>{Math.round(c.confidence * 100)}%</td>
                <td>{(c.evidence ?? []).length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid cols-2">
        <StringCard title="Strengths" items={result.strengths} />
        <StringCard title="Concerns" items={result.concerns} />
        <StringCard title="Contradictions" items={result.contradictions} />
        <StringCard title="Open questions" items={result.openQuestions} />
        <StringCard title="Limitations" items={result.limitations} />
      </div>

      <div className="card">
        <h2>Human review</h2>
        <form onSubmit={submitReview}>
          <div className="grid cols-2">
            <div>
              <label>Disposition</label>
              <select value={disposition} onChange={(e) => setDisposition(e.target.value as Disposition)}>
                <option value="PROCEED">PROCEED</option>
                <option value="CONSIDER">CONSIDER</option>
                <option value="DO_NOT_PROGRESS">DO_NOT_PROGRESS</option>
              </select>
            </div>
          </div>
          <label>Reason (required)</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3}
            placeholder="Explain your decision…" style={{ minHeight: 90 }} />
          <label>Comments (optional)</label>
          <textarea value={comments} onChange={(e) => setComments(e.target.value)} style={{ minHeight: 60 }} />
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" type="submit" disabled={submitting || reason.trim().length < 3}>
              {submitting ? 'Submitting…' : 'Submit review'}
            </button>
          </div>
        </form>

        {(reviews ?? []).length > 0 && (
          <div style={{ marginTop: 16 }}>
            <h3>Previous reviews</h3>
            <table>
              <thead><tr><th>Disposition</th><th>Reason</th><th>Status</th><th>Completed</th></tr></thead>
              <tbody>
                {reviews.map((r) => (
                  <tr key={r.id}>
                    <td>{recBadge(r.disposition)}</td>
                    <td className="muted small">{r.reason}</td>
                    <td>{r.status}</td>
                    <td className="muted small">{r.completedAt ? new Date(r.completedAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
