import { useEffect, useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth';
import { Banner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import { can, onlyWhoCan } from '../components/capabilityModel';
import { roleDisplayLabels } from '../components/roleLabelModel';
import { initialRoleId, rolesAcceptingCandidates } from '../components/candidateReuseModel';
import { ImportPreviewList, type RowEdit } from '../components/ImportPreviewList';
import { ImportResults } from '../components/ImportResults';
import {
  CONFIRM_CHUNK, CSV_ACCEPT, CV_ACCEPT, CV_CHUNK, chunk, confirmableKeys, csvTemplate, previewSummary, resultSummary, screenCvFiles,
  type ConfirmedRow, type ImportPreview, type ImportSource,
} from '../components/bulkImportModel';

/**
 * Add many candidates to one role at once, from a CSV or a set of CVs:
 * choose → preview and fix → confirm → invite. Nothing is saved until
 * confirm; the preview lives on the server for a day so a large set of CVs is
 * read once.
 */

interface Role {
  id: string; title: string; level: string; status: string;
  regionCode?: string | null; experienceBand?: string | null; createdAt?: string | null;
  latestScorecard: { id: string; version: number; status: string } | null;
}

type Step = 'choose' | 'preview' | 'result';

function readLabel(source: ImportSource, count: number): string {
  if (source === 'csv') return 'Read the file';
  return count ? `Read ${count} CV${count === 1 ? '' : 's'}` : 'Read CVs';
}

const TEMPLATE_HREF = `data:text/csv;charset=utf-8,${encodeURIComponent(csvTemplate())}`;

export function CandidateImport() {
  const [searchParams] = useSearchParams();
  const requestedRoleId = searchParams.get('roleId');
  const { user } = useAuth();
  const toast = useToast();
  const fieldId = useId();
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [roleId, setRoleId] = useState('');
  const [source, setSource] = useState<ImportSource>('csv');
  const [files, setFiles] = useState<File[]>([]);
  const [step, setStep] = useState<Step>('choose');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [skipped, setSkipped] = useState<{ name: string; reason: string }[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [results, setResults] = useState<ConfirmedRow[]>([]);
  const busy = progress !== '';
  const mayImport = can(user, 'candidate:create');

  useEffect(() => {
    if (!mayImport) { setLoading(false); return; }
    api.get<{ roles: Role[] }>('/roles')
      .then((d) => {
        const open = rolesAcceptingCandidates(d.roles ?? []);
        setRoles(open);
        setRoleId(initialRoleId(open, requestedRoleId));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load roles.'))
      .finally(() => setLoading(false));
  }, [requestedRoleId, mayImport]);

  if (!mayImport) {
    return <EmptyState heading="page" icon="add-candidate" title="Add candidates" message={onlyWhoCan('candidate:create', 'add candidates')} />;
  }
  if (loading) return <PageSkeleton label="Loading roles…" cards={1} />;

  const screened = source === 'cv' ? screenCvFiles(files) : { accepted: files.slice(0, 1), skipped: [] };
  const batchPath = (suffix = '') => `/candidate-imports/${preview?.batch.id ?? ''}${suffix}`;

  const read = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || screened.accepted.length === 0) return;
    setError('');
    setSkipped(screened.skipped);
    setProgress('Starting…');
    let latest: ImportPreview | null = null;
    try {
      const { batch } = await api.post<{ batch: { id: string } }>('/candidate-imports', { roleId });
      if (source === 'csv') {
        setProgress('Reading the file…');
        const form = new FormData();
        form.append('file', screened.accepted[0]);
        latest = await api.postForm<ImportPreview>(`/candidate-imports/${batch.id}/csv`, form);
      } else {
        const groups = chunk(screened.accepted, CV_CHUNK);
        for (const [index, group] of groups.entries()) {
          setProgress(`Reading CVs: ${Math.min((index + 1) * CV_CHUNK, screened.accepted.length)} of ${screened.accepted.length}`);
          const form = new FormData();
          group.forEach((f) => form.append('files', f));
          latest = await api.postForm<ImportPreview>(`/candidate-imports/${batch.id}/cvs`, form);
        }
      }
    } catch (err: unknown) {
      // CVs read before the failure stay in the preview; the rest can be added on their own.
      setError(`${err instanceof Error ? err.message : 'The files could not be read.'}${latest ? ' The people read so far are below.' : ''}`);
    } finally {
      setProgress('');
    }
    if (latest) {
      setPreview(latest);
      setStep('preview');
    }
  };

  const edit = async (rowKey: string, change: RowEdit) => {
    if (!preview) return;
    setError('');
    try {
      setPreview(await api.patch<ImportPreview>(batchPath(`/rows/${rowKey}`), change));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'That change was not saved.');
    }
  };

  const confirm = async (keys: string[]) => {
    if (!preview || keys.length === 0) return;
    setError('');
    const done = new Map(results.map((r) => [r.rowKey, r]));
    let stopped = false;
    try {
      for (const [index, group] of chunk(keys, CONFIRM_CHUNK).entries()) {
        setProgress(`Adding ${Math.min((index + 1) * CONFIRM_CHUNK, keys.length)} of ${keys.length}…`);
        const res = await api.post<{ results: ConfirmedRow[] }>(batchPath('/confirm'), { rowKeys: group });
        res.results.forEach((r) => done.set(r.rowKey, r));
      }
    } catch (err: unknown) {
      // Safe to repeat: rows already added answer with what was done.
      stopped = true;
      setError(`${err instanceof Error ? err.message : 'Adding stopped part-way.'} Press the button again to carry on; nobody is added twice.`);
    } finally {
      setProgress('');
    }
    const ordered = preview.rows.map((r) => done.get(r.rowKey)).filter((r): r is ConfirmedRow => r !== undefined);
    setResults(ordered);
    if (stopped && step === 'preview') {
      // Stay on the preview, with the rows already added locked, so the button carries on from there.
      api.get<ImportPreview>(batchPath()).then(setPreview).catch(() => undefined);
      return;
    }
    if (ordered.length === 0) return;
    setStep('result');
    toast.show(resultSummary(ordered));
  };

  const discard = async () => {
    if (preview) await api.del(batchPath()).catch(() => undefined);
    setPreview(null);
    setFiles([]);
    setSkipped([]);
    setStep('choose');
    toast.show('Import discarded. Nothing was added.');
  };

  const toAdd = preview ? confirmableKeys(preview.rows) : [];

  return (
    <div>
      <PageHeader
        icon="add-candidate"
        title="Add candidates"
        subtitle={preview ? `To ${preview.batch.roleTitle}` : 'From a CSV file or a set of CVs'}
        actions={<Link className="btn ghost" to="/candidates/new"><Icon name="candidate-profile" size={16} />Add one person</Link>}
      />

      {error && <Banner kind="error">{error}</Banner>}
      {progress && <p className="import-progress" role="status"><Icon name="hourglass" size={15} />{progress}</p>}
      {skipped.length > 0 && step !== 'result' && (
        <div className="import-skipped small">
          <b>Not uploaded:</b> {skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}
        </div>
      )}

      {step === 'choose' && (
        roles.length === 0 ? (
          <Banner kind="info">
            No roles with an approved scorecard yet. Approve a role scorecard before adding candidates.{' '}
            <Link className="link-action" to="/roles"><Icon name="role" size={15} />Roles</Link>
          </Banner>
        ) : (
          <form className="card" onSubmit={read}>
            <label htmlFor={`${fieldId}-role`}>Role</label>
            <select id={`${fieldId}-role`} value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={busy} required>
              {roleDisplayLabels(roles.map((r) => ({ ...r, title: r.level ? `${r.title} (${r.level})` : r.title })))
                .map((label, index) => <option key={roles[index].id} value={roles[index].id}>{label}</option>)}
            </select>

            <fieldset className="row import-source" disabled={busy}>
              <legend className="small muted">Start from</legend>
              <label className="check-row">
                <input type="radio" name="import-source" checked={source === 'csv'} onChange={() => { setSource('csv'); setFiles([]); }} />
                A CSV file
              </label>
              <label className="check-row">
                <input type="radio" name="import-source" checked={source === 'cv'} onChange={() => { setSource('cv'); setFiles([]); }} />
                CV files
              </label>
            </fieldset>

            <label htmlFor={`${fieldId}-files`}>{source === 'csv' ? 'CSV file' : 'CVs (PDF, DOCX or TXT)'}</label>
            <input
              key={source}
              id={`${fieldId}-files`}
              type="file"
              accept={source === 'csv' ? CSV_ACCEPT : CV_ACCEPT}
              multiple={source === 'cv'}
              disabled={busy}
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            <p className="muted small">
              {source === 'csv'
                ? <>Columns: name and email, and optionally phone and LinkedIn. Up to 200 people. <a className="link-action" href={TEMPLATE_HREF} download="candidates-template.csv">Download a template</a></>
                : 'Up to 200 CVs, 5 MB each. Each person’s name and email are read from their CV; you can correct them before anything is saved.'}
            </p>

            <div className="import-actions">
              <button className="btn" type="submit" disabled={busy || screened.accepted.length === 0 || !roleId}>
                <Icon name={busy ? 'hourglass' : 'resume-upload'} size={16} />
                {readLabel(source, screened.accepted.length)}
              </button>
            </div>
          </form>
        )
      )}

      {step === 'preview' && preview && (
        <section className="card" aria-label="Preview">
          <p className="import-summary" data-testid="import-preview-summary">{previewSummary(preview.rows)}</p>
          <p className="muted small">Nothing is saved yet. Fix a name or email in place, or untick anyone you do not want to add.</p>
          <ImportPreviewList rows={preview.rows} busy={busy} onEdit={(key, change) => void edit(key, change)} />
          <div className="import-actions">
            <button type="button" className="btn" disabled={busy || toAdd.length === 0} onClick={() => void confirm(toAdd)}>
              <Icon name={busy ? 'hourglass' : 'add-candidate'} size={16} />
              {`Add ${toAdd.length} ${toAdd.length === 1 ? 'person' : 'people'}`}
            </button>
            <button type="button" className="btn secondary" disabled={busy} onClick={() => void discard()}>
              <Icon name="close" size={16} />Discard
            </button>
          </div>
        </section>
      )}

      {step === 'result' && preview && (
        <>
          <ImportResults
            rows={preview.rows}
            results={results}
            canInvite={can(user, 'interview:invite') && can(user, 'interview:create')}
            retrying={busy}
            onRetry={(keys) => void confirm(keys)}
          />
          <div className="import-actions">
            <Link className="btn secondary" to={`/roles/${preview.batch.roleId}`}><Icon name="role" size={16} />Back to the role</Link>
            <Link className="btn ghost" to="/candidates"><Icon name="candidates" size={16} />All candidates</Link>
          </div>
        </>
      )}
    </div>
  );
}
