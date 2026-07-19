import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { Banner } from '../components/ui';

interface CreateResp {
  role: { id: string; title: string; level: string; location: string; employmentType: string; status: string };
  scorecard: { id: string; version: number; status: string; profile: unknown };
  jdWarnings: { term: string; suggestion: string }[];
}

const SAMPLE_JD = `Senior Data Engineer — Platform Team
We are hiring a Senior Data Engineer to design and operate our batch and streaming data platform.
Responsibilities: build reliable ETL/ELT pipelines, own data quality and lineage, and mentor engineers.
Requirements: 5+ years building production data systems; expert SQL and Python.
Deep experience with Spark or Flink and cloud data warehouses (Snowflake/BigQuery).
Strong grasp of data modeling, orchestration (Airflow), and CI/CD for data.
Nice to have: streaming (Kafka), dbt, and infrastructure-as-code.
Location: Remote (EU). Employment: Full-time.`;

export function RoleCreate() {
  const nav = useNavigate();
  const [sourceText, setSourceText] = useState('');
  const [title, setTitle] = useState('');
  const [useLlm, setUseLlm] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<{ term: string; suggestion: string }[]>([]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const resp = await api.post<CreateResp>('/roles', {
        sourceType: 'paste',
        sourceText,
        title: title || undefined,
        useLlm,
      });
      if (resp.jdWarnings && resp.jdWarnings.length) {
        setWarnings(resp.jdWarnings);
        // brief pause so the user sees the warnings, then navigate
        setTimeout(() => nav(`/roles/${resp.role.id}`), 1200);
      } else {
        nav(`/roles/${resp.role.id}`);
      }
    } catch (err: any) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="topbar">
        <h1>New Role</h1>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {warnings.length > 0 && (
        <Banner kind="info">
          <div>Job description warnings (fixing before you interview improves fairness):</div>
          <ul style={{ margin: '6px 0 0' }}>
            {warnings.map((w, i) => (
              <li key={i} className="small"><b>{w.term}</b> — {w.suggestion}</li>
            ))}
          </ul>
        </Banner>
      )}

      <form className="card" onSubmit={submit}>
        <label>Role title (optional — inferred from the JD if left blank)</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Senior Data Engineer" />

        <label>Job description</label>
        <textarea
          value={sourceText}
          onChange={(e) => setSourceText(e.target.value)}
          placeholder="Paste the full job description here…"
          style={{ minHeight: 220 }}
          required
        />

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <input
            type="checkbox"
            checked={useLlm}
            onChange={(e) => setUseLlm(e.target.checked)}
            style={{ width: 'auto' }}
          />
          Use AI extraction (falls back to built-in extractor)
        </label>

        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn" type="submit" disabled={submitting || !sourceText.trim()}>
            {submitting ? 'Creating…' : 'Create role'}
          </button>
          <button
            className="btn secondary"
            type="button"
            onClick={() => setSourceText(SAMPLE_JD)}
          >
            Load sample JD
          </button>
        </div>
      </form>
    </div>
  );
}
