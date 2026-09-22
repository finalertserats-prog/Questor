import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth';
import { Banner } from '../components/ui';
import { StatusBadge } from '../components/StatusBadge';
import { can, onlyWhoCan } from '../components/capabilityModel';
import { regionLabel } from '../components/roleLabelModel';
import { approvePayload, archiveAction, isCurrentResponse, isRoleOpen, type LoadTicket } from '../components/roleDetailModel';
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
import { hasScore } from '../components/scoreFormat';
import { weightsProblem } from '../components/scorecardModel';
import { CompetencyEditor } from '../components/scorecard/CompetencyEditor';
import type { EditableCompetency } from '../components/scorecard/competencyEditModel';
import { TechStackPanel } from '../components/TechStackPanel';
import { stackNames, type TechStackItem } from '../components/techStackModel';
import { useToast } from '../components/Toast';

type Competency = EditableCompetency;
interface Profile {
  roleContext: string; seniority: string; outcomes: string[]; responsibilities: string[];
  redFlags: string[]; competencies: Competency[];
  scoringRules: { mustPassCompetencyIds: string[]; passThreshold: number };
  policyRules: { prohibitedTopics: string[] };
}
interface Scorecard { id: string; version: number; status: string; profile: Profile; approvedAt: string | null; warnings?: string[] }
interface RoleResp {
  role: { id: string; title: string; level: string; location: string; employmentType: string; status: string; sourceType: string; catalogRole: { id: string; title: string; domain: { id: string; name: string } } | null; experienceBand: string | null; regionCode: string | null; techStack: readonly TechStackItem[] };
  scorecards: Scorecard[];
  /** Competency ids an interview has used; removing one of these retires it. */
  competencyHistory?: string[];
}

export function RoleDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [data, setData] = useState<RoleResp | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  // The profile exactly as it was loaded. "Dirty" is the difference from this,
  // not a flag someone has to remember to set on every edit path.
  const [saved, setSaved] = useState('');
  const [loading, setLoading] = useState(true);
  // A failed load has nothing to show, so it replaces the page. A failed save
  // or approve must not: the editor, with the person's edits, stays put and
  // the error sits above the actions.
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  // Hidden once the server says the archive endpoint is missing or not for
  // this user, rather than offering a button that always fails.
  const [archiveUnavailable, setArchiveUnavailable] = useState(false);
  const toast = useToast();
  const [newFlag, setNewFlag] = useState('');
  const [flagProblem, setFlagProblem] = useState('');

  // Every load takes a ticket; only the newest ticket for the role still on
  // screen may write, so a slow response for the previous role (or an older
  // reload of this one) cannot overwrite what the person is looking at now.
  const latestLoad = useRef<LoadTicket>({ id: undefined, seq: 0 });
  // A ref as well as state: two clicks inside one render both see `approving` false.
  const approvingRef = useRef(false);

  const load = (showSkeleton: boolean) => {
    const ticket: LoadTicket = { id, seq: latestLoad.current.seq + 1 };
    latestLoad.current = ticket;
    if (showSkeleton) setLoading(true);
    api.get<RoleResp>(`/roles/${id}`)
      .then((d) => {
        if (!isCurrentResponse(ticket, latestLoad.current)) return;
        const next = d.scorecards?.[0]?.profile ?? null;
        setData(d);
        setProfile(next);
        setSaved(JSON.stringify(next));
        setLoadError('');
      })
      .catch((err: unknown) => {
        if (!isCurrentResponse(ticket, latestLoad.current)) return;
        const message = err instanceof Error ? err.message : 'Could not load this role.';
        // A refresh after a successful action that fails leaves the editor as it was.
        if (showSkeleton) setLoadError(message);
        else setActionError(`Done, but the page could not refresh: ${message}`);
      })
      .finally(() => { if (isCurrentResponse(ticket, latestLoad.current)) setLoading(false); });
  };

  useEffect(() => {
    // A different role: nothing of the previous one may stay on screen.
    setData(null);
    setProfile(null);
    setSaved('');
    setLoadError('');
    setActionError('');
    setNewFlag('');
    setFlagProblem('');
    setArchiveUnavailable(false);
    load(true);
    return () => { latestLoad.current = { id: undefined, seq: latestLoad.current.seq + 1 }; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const dirty = profile !== null && JSON.stringify(profile) !== saved;

  // Closing the tab is the one departure the browser will let us question.
  // In-app navigation cannot be blocked here — this router has no data router
  // to hang a blocker on — so the unsaved marker beside Save carries that job.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (loading) return <PageSkeleton label="Loading role…" cards={3} />;
  if (loadError) return <Banner kind="error">{loadError}</Banner>;
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
  const mayApprove = can(user, 'role:approve_scorecard');
  const archive = archiveAction(role.status);

  const weightsError = weightsProblem(profile.competencies ?? []);

  const updateCompetencies = (next: { competencies: Competency[]; mustPassIds: string[] }) => {
    setProfile((p) => (p ? { ...p, competencies: next.competencies, scoringRules: { ...p.scoringRules, mustPassCompetencyIds: next.mustPassIds } } : p));
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
    if (weightsError || !dirty) return;
    setSaving(true);
    setActionError('');
    try {
      await api.put<{ scorecard: Scorecard }>(`/roles/${id}/scorecard`, { profile });
      toast.show('Changes saved.');
      load(false);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Could not save the scorecard.');
    } finally {
      setSaving(false);
    }
  };

  const approve = async () => {
    if (approvingRef.current || !scorecard) return;
    approvingRef.current = true;
    setApproving(true);
    setActionError('');
    try {
      // Names the version on screen, so a colleague's newer save is not what gets approved.
      await api.post<{ scorecard: Scorecard }>(`/roles/${id}/approve`, approvePayload(scorecard));
      load(false);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Could not approve the scorecard.');
    } finally {
      approvingRef.current = false;
      setApproving(false);
    }
  };

  const changeStatus = async () => {
    if (archiving) return;
    setArchiving(true);
    setActionError('');
    try {
      await api.patch(`/roles/${id}/status`, { status: archive.next });
      toast.show(archive.next === 'archived'
        ? 'Role archived. It no longer shows in the active roles list.'
        : 'Role restored to the active roles list.');
      load(false);
    } catch (err: unknown) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        setArchiveUnavailable(true);
        setActionError('Archiving is not available for this role.');
      } else {
        setActionError(err instanceof Error ? err.message : 'Could not change the role status.');
      }
    } finally {
      setArchiving(false);
    }
  };

  return (
    <div>
      <PageHeader
        icon="role"
        title={role.title}
        badge={<StatusBadge kind="role" value={role.status} />}
        actions={
          <>
            {/* Marked with words rather than a colour: nothing to save, and a
                total the server will refuse, are different reasons for the same
                disabled button. */}
            <button
              className="btn secondary"
              onClick={save}
              disabled={saving || !dirty || weightsError !== null || !isRoleOpen(role.status)}
              title={weightsError ?? (dirty ? undefined : 'No changes to save')}
            >
              <Icon name={saving ? 'hourglass' : 'save'} size={16} />
              {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </button>
            {/* Approving with edits still on screen approved the version the
                server holds — the one nobody was looking at — while the page
                showed the edited values. Save first, then approve what you can
                see. */}
            {mayApprove ? (
              <button
                className="btn"
                onClick={approve}
                disabled={approved || dirty || approving || !isRoleOpen(role.status)}
                title={dirty ? 'Save your changes first — approving would approve the saved version, not these edits.' : undefined}
              >
                <Icon name={approving ? 'hourglass' : 'check-circle'} size={16} />
                {approved ? 'Approved' : approving ? 'Approving…' : 'Approve scorecard'}
              </button>
            ) : !approved && (
              // A recruiter drafts; someone else signs off. Said here rather
              // than as a button that can only answer "permission denied".
              <span className="muted small" data-testid="awaiting-approval">[ awaiting approval ] {onlyWhoCan('role:approve_scorecard', 'approve the scorecard')}</span>
            )}
            {mayApprove && !archiveUnavailable && (
              <button type="button" className="btn ghost" onClick={() => void changeStatus()} disabled={archiving}>
                <Icon name={archiving ? 'hourglass' : role.status === 'archived' ? 'refresh' : 'lock'} size={16} />
                {archiving ? 'Saving…' : archive.label}
              </button>
            )}
          </>
        }
      />

      {actionError && <Banner kind="error">{actionError}</Banner>}
      {dirty && <p className="muted small">Unsaved changes — they are lost if you leave this page.</p>}
      {approved && !isRoleOpen(role.status) && (
        <Banner kind="info">This role is archived. Restore it to add candidates, interview or change the scorecard.</Banner>
      )}
      {approved && isRoleOpen(role.status) && (
        <Banner kind="ok">
          Scorecard approved — ready to interview candidates.{' '}
          {can(user, 'candidate:create') && (
            <>
              <Link className="link-action" to="/candidates/new"><Icon name="add-candidate" size={15} />Add a candidate</Link>{' '}
              <Link className="link-action" to={`/candidates/import?roleId=${encodeURIComponent(role.id)}`} data-testid="bulk-import-link"><Icon name="resume-upload" size={15} />Add many from a CSV or CVs</Link>
            </>
          )}
        </Banner>
      )}

      <div className="card">
        <div className="muted small">
          {/* No scorecard yet means no version to name; "scorecard v" on its
              own reads as a truncated one. */}
          {role.level} · {role.location} · {role.employmentType}
          {scorecard && hasScore(scorecard.version) ? ` · scorecard v${scorecard.version}` : ''}
        </div>
        <div className="muted small" style={{ marginTop: 6 }}>
          {role.catalogRole ? `Domain: ${role.catalogRole.domain.name}` : 'Not linked to catalog'}
          {role.experienceBand ? ` · Experience: ${role.experienceBand}` : ''}
          {role.regionCode ? ` · Region: ${regionLabel(role.regionCode)}` : ''}
          {role.techStack.length ? ` · Tech: ${stackNames(role.techStack).join(', ')}` : ''}
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

      <TechStackPanel
        roleId={role.id}
        initial={role.techStack}
        locked={!isRoleOpen(role.status)}
        onStored={(message) => { toast.show(message); setActionError(''); load(false); }}
      />

      <CompetencyEditor
        roleId={role.id}
        competencies={profile.competencies ?? []}
        mustPassIds={profile.scoringRules?.mustPassCompetencyIds ?? []}
        historyIds={data.competencyHistory ?? []}
        warnings={scorecard?.warnings ?? []}
        dirty={dirty}
        locked={!isRoleOpen(role.status)}
        onChange={updateCompetencies}
        onStored={(message) => { toast.show(message); setActionError(''); load(false); }}
      />

      <div className="card">
        <h3 className="card-title"><Icon name="scale" size={16} />Scoring</h3>
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
