import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Banner } from './ui';
import { Icon } from './Icon';
import { useIsPhone } from './ResponsiveList';
import { useToast } from './Toast';
import { DEFAULT_DURATION_MINUTES, INTERVIEW_MODULES } from './interviewSetupModel';
import { DEFAULT_INTERVIEWER_CHOICE } from './interviewerModel';
import { chunk, isDone, resultSummary, retryableKeys, type ConfirmedRow, type ImportRow } from './bulkImportModel';
import { invitePlan, inviteOutcomes, inviteSummary, type BulkInviteResult, type InviteOutcome } from './bulkInviteModel';

/**
 * What confirm did, row by row, and the Invite step. Inviting goes through
 * the existing bulk-invite endpoint, so its closed-role and permission checks
 * apply unchanged; anyone without an interview gets one set up first with the
 * defaults Set up interview starts from.
 */

const MAX_BULK_INVITE = 200;
const SET_UP_AT_ONCE = 4;

interface Props {
  readonly rows: readonly ImportRow[];
  readonly results: readonly ConfirmedRow[];
  readonly canInvite: boolean;
  readonly retrying: boolean;
  readonly onRetry: (rowKeys: string[]) => void;
}

interface Line {
  readonly result: ConfirmedRow;
  readonly row: ImportRow | undefined;
}

const OUTCOME_VIEW: Readonly<Record<string, { label: string; tone: string; icon: 'check-circle' | 'candidate-profile' | 'x-circle' | 'clock' }>> = {
  created: { label: 'added', tone: 'ok', icon: 'check-circle' },
  linked: { label: 'already a candidate', tone: 'info', icon: 'candidate-profile' },
  failed: { label: 'not added', tone: 'fix', icon: 'x-circle' },
};
const PENDING_VIEW = { label: 'not added', tone: 'info', icon: 'clock' as const };

function OutcomeMark({ outcome }: { readonly outcome: string }) {
  const view = OUTCOME_VIEW[outcome] ?? PENDING_VIEW;
  return <span className={`import-mark is-${view.tone}`}><Icon name={view.icon} size={14} />[ {view.label} ]</span>;
}

function InviteMark({ outcome }: { readonly outcome: InviteOutcome | undefined }) {
  if (!outcome) return null;
  const tone = outcome.kind === 'invited' ? 'ok' : outcome.kind === 'failed' ? 'fix' : 'info';
  return <div className={`import-mark is-${tone}`}><Icon name={outcome.kind === 'invited' ? 'send' : outcome.kind === 'failed' ? 'x-circle' : 'mail'} size={14} />{outcome.text}</div>;
}

async function setUpInterview(candidateId: string): Promise<void> {
  await api.post('/interviews', {
    candidateId, durationMinutes: DEFAULT_DURATION_MINUTES, language: 'en', modules: INTERVIEW_MODULES,
    interviewer: DEFAULT_INTERVIEWER_CHOICE, persona: { tone: 'warm' }, provider: 'hosted',
    recordingRequested: false, humanReviewRequired: true, approve: true,
  });
}

export function ImportResults({ rows, results, canInvite, retrying, onRetry }: Props) {
  const isPhone = useIsPhone();
  const toast = useToast();
  const lines: Line[] = useMemo(() => results.map((result) => ({ result, row: rows.find((r) => r.rowKey === result.rowKey) })), [results, rows]);
  const invitable = lines.filter((l) => isDone(l.result.outcome) && l.result.candidateId);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(invitable.map((l) => l.result.candidateId!)));
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, InviteOutcome>>(new Map());
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const failed = retryableKeys(results);

  // A retry that adds more people offers them for inviting too.
  useEffect(() => {
    setSelected((prev) => new Set([...prev, ...invitable.map((l) => l.result.candidateId!).filter((id) => !outcomes.has(id))]));
    // Only when the results change; outcomes and invitable follow from them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results]);

  const toggle = (candidateId: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(candidateId); else next.delete(candidateId);
      return next;
    });
  };

  const invite = async () => {
    setInviting(true);
    setInviteError('');
    const plan = invitePlan(invitable.filter((l) => selected.has(l.result.candidateId!)).map((l) => ({ candidateId: l.result.candidateId!, interview: l.result.interview })));
    const setUpFailures: { candidateId: string; error: string }[] = [];
    try {
      for (const group of chunk(plan.setUp, SET_UP_AT_ONCE)) {
        await Promise.all(group.map((candidateId) => setUpInterview(candidateId).catch((err: unknown) => {
          setUpFailures.push({ candidateId, error: err instanceof Error ? err.message : 'Could not set up the interview.' });
        })));
      }
      const failedIds = new Set(setUpFailures.map((f) => f.candidateId));
      const toInvite = plan.invite.filter((id) => !failedIds.has(id));
      const answers: BulkInviteResult[] = [];
      for (const group of chunk(toInvite, MAX_BULK_INVITE)) {
        const res = await api.post<{ results: BulkInviteResult[] }>('/interviews/bulk-invite', group.map((candidateId) => ({ candidateId })));
        answers.push(...res.results);
      }
      const next = inviteOutcomes(answers, plan.skipped, setUpFailures);
      setOutcomes(next);
      setSelected(new Set());
      toast.show(inviteSummary(next));
    } catch (err: unknown) {
      setInviteError(err instanceof Error ? err.message : 'The invitations could not be sent.');
    } finally {
      setInviting(false);
    }
  };

  const personCell = (line: Line) => (
    <>
      {line.result.candidateId && isDone(line.result.outcome)
        ? <Link to={`/candidates/${line.result.candidateId}`}>{line.row?.fullName || 'Candidate'}</Link>
        : <span>{line.row?.fullName || line.row?.filename || 'Row'}</span>}
      <div className="muted small">{line.row?.email}</div>
    </>
  );

  const pickBox = (line: Line) => {
    const id = line.result.candidateId;
    if (!canInvite || !id || !isDone(line.result.outcome) || outcomes.has(id)) return null;
    const boxId = `import-invite-${line.result.rowKey}`;
    return (
      <>
        <input id={boxId} type="checkbox" checked={selected.has(id)} disabled={inviting} onChange={(e) => toggle(id, e.target.checked)} />
        <label htmlFor={boxId} className="visually-hidden">Invite {line.row?.fullName ?? 'this person'}</label>
      </>
    );
  };

  const detail = (line: Line) => (
    <>
      <OutcomeMark outcome={line.result.outcome} />
      {line.result.error && <div className="import-note small">{line.result.error}</div>}
      {line.result.candidateId && <InviteMark outcome={outcomes.get(line.result.candidateId)} />}
    </>
  );

  return (
    <section className="card" aria-label="Import result">
      <p className="import-summary" data-testid="import-result-summary">{resultSummary(results)}</p>

      {failed.length > 0 && (
        <Banner kind="error">
          {failed.length === 1 ? 'One person was not added.' : `${failed.length} people were not added.`} Each row says why; trying again adds only those.{' '}
          <button type="button" className="btn secondary sm" disabled={retrying} onClick={() => onRetry(failed)}>
            <Icon name={retrying ? 'hourglass' : 'refresh'} size={14} />{retrying ? 'Trying again…' : 'Try again'}
          </button>
        </Banner>
      )}
      {inviteError && <Banner kind="error">{inviteError}</Banner>}

      {isPhone ? (
        <ul className="import-cards">
          {lines.map((line) => (
            <li key={line.result.rowKey} className="import-row" data-testid="import-result-row">
              <div className="import-card-top">{pickBox(line)}<div className="import-card-person">{personCell(line)}</div></div>
              {detail(line)}
            </li>
          ))}
        </ul>
      ) : (
        <table className="import-table">
          <thead>
            <tr>
              {canInvite && <th scope="col"><span className="visually-hidden">Invite</span></th>}
              <th scope="col">Person</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.result.rowKey} className="import-row" data-testid="import-result-row">
                {canInvite && <td>{pickBox(line)}</td>}
                <td>{personCell(line)}</td>
                <td>{detail(line)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canInvite && invitable.some((l) => !outcomes.has(l.result.candidateId!)) && (
        <div className="import-actions">
          <button type="button" className="btn" disabled={inviting || selected.size === 0} onClick={() => void invite()}>
            <Icon name={inviting ? 'hourglass' : 'send'} size={16} />
            {inviting ? 'Inviting…' : `Invite ${selected.size} selected`}
          </button>
          <span className="muted small">
            Anyone without an interview gets a {DEFAULT_DURATION_MINUTES}-minute AI interview set up first, with a random interviewer.
          </span>
        </div>
      )}
    </section>
  );
}
