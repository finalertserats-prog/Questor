import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Banner } from '../components/ui';

interface Role {
  id: string; title: string; level: string; status: string;
  latestScorecard: { id: string; version: number; status: string } | null;
  candidates: number; updatedAt: string;
}

export function CandidateCreate() {
  const nav = useNavigate();
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [roleId, setRoleId] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [resumeText, setResumeText] = useState('');

  useEffect(() => {
    api.get<{ roles: Role[] }>('/roles')
      .then((d) => {
        const approved = (d.roles ?? []).filter((r) => r.latestScorecard?.status === 'approved');
        setRoles(approved);
        if (approved[0]) setRoleId(approved[0].id);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="muted">Loading…</div>;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const { candidate } = await api.post<{ candidate: { id: string } }>('/candidates', {
        fullName, email, phone: phone || undefined, roleId,
      });
      const form = new FormData();
      if (file) form.append('file', file);
      else form.append('text', resumeText);
      await api.postForm(`/candidates/${candidate.id}/resume`, form);
      nav(`/candidates/${candidate.id}`);
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 422) {
        setError(`We could not read that resume file. Please upload a text-based PDF/DOCX or paste the resume text instead. (${err.message})`);
      } else {
        setError(err.message);
      }
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="topbar">
        <h1>Add Candidate</h1>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {roles.length === 0 && (
        <Banner kind="info">
          No roles with an approved scorecard yet. Approve a role scorecard before adding candidates.
        </Banner>
      )}

      <form className="card" onSubmit={submit}>
        <label>Role</label>
        <select value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={roles.length === 0} required>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.title} ({r.level})</option>)}
        </select>

        <div className="grid cols-2">
          <div>
            <label>Full name</label>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
          </div>
          <div>
            <label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
        </div>

        <label>Phone (optional)</label>
        <input value={phone} onChange={(e) => setPhone(e.target.value)} />

        <label>Resume file (PDF, DOCX, or TXT)</label>
        <input
          type="file"
          accept=".pdf,.docx,.txt"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <div className="muted small" style={{ marginTop: 6 }}>
          If a file is selected it takes precedence over the pasted text below.
        </div>

        <label>Or paste resume text</label>
        <textarea
          value={resumeText}
          onChange={(e) => setResumeText(e.target.value)}
          placeholder="Paste the candidate's resume text here…"
          disabled={!!file}
        />

        <div className="row" style={{ marginTop: 16 }}>
          <button
            className="btn"
            type="submit"
            disabled={submitting || roles.length === 0 || !fullName || !email || (!file && !resumeText.trim())}
          >
            {submitting ? 'Uploading & analysing…' : 'Add candidate & analyse resume'}
          </button>
        </div>
      </form>
    </div>
  );
}
