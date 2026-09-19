import { useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth';
import { Banner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { PageSkeleton } from '../components/Skeleton';
import { EMPTY_RESUME, ResumeFields, uploadResume, type ResumeValue } from '../components/ResumeFields';
import { atsErrorMessage } from '../components/atsModel';
import { roleDisplayLabels } from '../components/roleLabelModel';
import {
  addCandidateBlocker,
  hasResume,
  importNotice,
  importPayload,
  resumeUploadMessage,
  type AddCandidateForm,
  type CandidateSource,
  type ImportResult,
} from '../components/candidateImportModel';

interface Role {
  id: string; title: string; level: string; status: string;
  regionCode?: string | null; experienceBand?: string | null; createdAt?: string | null;
  latestScorecard: { id: string; version: number; status: string } | null;
  candidates: number; updatedAt: string;
}

export function CandidateCreate() {
  const nav = useNavigate();
  const { user } = useAuth();
  const fieldId = useId();
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ text: string; candidateId: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [source, setSource] = useState<CandidateSource>('manual');
  const [roleId, setRoleId] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [externalCandidateId, setExternalCandidateId] = useState('');
  const [resume, setResume] = useState<ResumeValue>(EMPTY_RESUME);
  // Set once the candidate record exists, so a failed resume upload can be
  // retried against the same person rather than making a duplicate.
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);

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

  if (loading) return <PageSkeleton label="Loading roles…" cards={1} />;

  const form: AddCandidateForm = {
    source, roleId, fullName, email, externalCandidateId, hasFile: !!resume.file, resumeText: resume.text,
  };
  const blocker = addCandidateBlocker(form);
  const withResume = hasResume(form);

  const switchSource = (next: CandidateSource) => {
    setSource(next);
    setError('');
    setNotice(null);
  };

  // An ATS import answers with the person, new or already here. Only a new one
  // goes on to the resume; an existing one is pointed at, not overwritten.
  const createRecord = async (): Promise<{ id: string; name: string } | null> => {
    if (source === 'manual') {
      const { candidate } = await api.post<{ candidate: { id: string } }>('/candidates', {
        fullName, email, phone: phone || undefined, roleId,
      });
      return { id: candidate.id, name: fullName };
    }
    const result = await api.post<ImportResult>('/candidates/import-ats', importPayload(form));
    const already = importNotice(result, { withResume });
    if (already) {
      setNotice({ text: already, candidateId: result.candidate.id });
      return null;
    }
    return { id: result.candidate.id, name: result.candidate.fullName };
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice(null);
    setSubmitting(true);
    let record = created;
    try {
      // Two requests: the candidate, then their resume. When the second failed,
      // pressing the button again used to create a SECOND candidate for the
      // same person — so the record from the first success is kept and the
      // retry only re-uploads the resume.
      if (!record) {
        record = await createRecord();
        if (!record) { setSubmitting(false); return; }
        setCreated(record);
      }
    } catch (err: unknown) {
      const canManage = user?.role === 'admin';
      setError(err instanceof ApiError ? atsErrorMessage(err, canManage) : 'Could not add this candidate.');
      setSubmitting(false);
      return;
    }
    try {
      if (withResume) await uploadResume(record.id, resume);
      nav(`/candidates/${record.id}`);
    } catch (err: unknown) {
      setError(resumeUploadMessage(err));
      setSubmitting(false);
    }
  };

  const buttonLabel = source === 'ats'
    ? (submitting ? 'Importing…' : withResume ? 'Import candidate & analyse resume' : 'Import candidate')
    : (submitting ? 'Uploading & analysing…' : 'Add candidate & analyse resume');

  return (
    <div>
      <PageHeader icon="resume-upload" title="Add candidate" />

      {error && <Banner kind="error">{error}</Banner>}
      {/* Said plainly, because the form still looks unsubmitted: the person
          exists, only their resume did not arrive. */}
      {created && error && (
        <Banner kind="info">
          {created.name || 'This candidate'} was added — only the resume did not go through. Submitting
          again retries just the resume, or{' '}
          <Link className="link-action" to={`/candidates/${created.id}`}>open the candidate</Link> as they are.
        </Banner>
      )}
      {notice && (
        <Banner kind="info">
          {notice.text}{' '}
          <Link className="link-action" to={`/candidates/${notice.candidateId}`}>Open the candidate</Link>
        </Banner>
      )}
      {roles.length === 0 && (
        <Banner kind="info">
          No roles with an approved scorecard yet. Approve a role scorecard before adding candidates.{' '}
          <Link className="link-action" to="/roles/new"><Icon name="role" size={15} />Create a role</Link>
        </Banner>
      )}

      <form className="card" onSubmit={submit}>
        <fieldset className="row" style={{ border: 0, padding: 0, gap: 16 }} disabled={!!created}>
          <legend className="small muted">Start from</legend>
          <label className="check-row">
            <input type="radio" name="candidate-source" checked={source === 'manual'} onChange={() => switchSource('manual')} />
            Details I enter
          </label>
          <label className="check-row">
            <input type="radio" name="candidate-source" checked={source === 'ats'} onChange={() => switchSource('ats')} />
            A candidate in your ATS
          </label>
        </fieldset>

        <label htmlFor={`${fieldId}-role`}>Role</label>
        <select id={`${fieldId}-role`} value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={roles.length === 0 || !!created} required>
          {/* The level is part of the base label here, as it always was; two
              roles that still collide are told apart by region, band or date. */}
          {roleDisplayLabels(roles.map((r) => ({ ...r, title: r.level ? `${r.title} (${r.level})` : r.title })))
            .map((label, index) => <option key={roles[index].id} value={roles[index].id}>{label}</option>)}
        </select>

        {source === 'ats' ? (
          <>
            <label htmlFor={`${fieldId}-ats-id`}>ATS candidate id</label>
            <input
              id={`${fieldId}-ats-id`}
              value={externalCandidateId}
              onChange={(e) => setExternalCandidateId(e.target.value)}
              placeholder="e.g. CAND-1042"
              pattern="\s*[A-Za-z0-9_\-]{1,64}\s*"
              title="Letters, numbers, dashes or underscores"
              disabled={!!created}
              required
            />
            <div className="muted small">
              Name, email and phone come from your organisation&rsquo;s own ATS, and the candidate stays linked to it for
              exports. Importing the same person again opens the record already here.
            </div>
          </>
        ) : (
          <>
            <div className="grid cols-2">
              <div>
                <label htmlFor={`${fieldId}-name`}>Full name</label>
                <input id={`${fieldId}-name`} value={fullName} onChange={(e) => setFullName(e.target.value)} disabled={!!created} required />
              </div>
              <div>
                <label htmlFor={`${fieldId}-email`}>Email</label>
                <input id={`${fieldId}-email`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!!created} required />
              </div>
            </div>

            <label htmlFor={`${fieldId}-phone`}>Phone (optional)</label>
            <input id={`${fieldId}-phone`} value={phone} onChange={(e) => setPhone(e.target.value)} disabled={!!created} />
          </>
        )}

        <ResumeFields
          value={resume}
          onChange={setResume}
          optionalNote={source === 'ats' ? 'optional, you can add it later from the candidate page' : undefined}
        />

        <div className="row" style={{ marginTop: 16 }}>
          <button
            className="btn"
            type="submit"
            disabled={submitting || roles.length === 0 || blocker !== null}
            title={blocker ?? undefined}
          >
            <Icon name={submitting ? 'hourglass' : source === 'ats' ? 'link' : 'sparkle'} size={16} />
            {buttonLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
