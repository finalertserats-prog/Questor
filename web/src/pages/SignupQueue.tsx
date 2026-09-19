import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { Banner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';
import { applicantIntent, joinEmailCaution, withoutSignup, type SignupMode } from '../components/signupModel';
import { formatDate } from '../components/dateFormat';

interface PendingSignup {
  id: string;
  name: string;
  email: string;
  mode: SignupMode;
  organisation: string;
  status: string;
  createdAt: string;
}

/**
 * The requests waiting on a person.
 *
 * The same decision as the emailed link, in the console, for the operator who
 * is already signed in — and the place an expired link sends them.
 */
export function SignupQueue() {
  const [signups, setSignups] = useState<PendingSignup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // A failed read is not an empty queue: "No requests waiting" over a failed
  // load told an admin nobody was waiting when they could not know that.
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const [actingId, setActingId] = useState<string | null>(null);
  const [pendingDeclineId, setPendingDeclineId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ signups: PendingSignup[] }>('/admin/signups?status=pending');
      setSignups(data.signups ?? []);
      setError('');
      setLoadFailed(false);
    } catch (err: unknown) {
      setLoadFailed(true);
      setError(err instanceof ApiError && err.status === 403
        ? 'Your role does not include deciding account requests.'
        : err instanceof Error ? err.message : 'Could not load account requests.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const decide = async (signup: PendingSignup, decision: 'approve' | 'decline') => {
    setActingId(signup.id);
    setError('');
    try {
      await api.post(`/admin/signups/${signup.id}/${decision}`);
      setSignups((current) => withoutSignup(current, signup.id));
      setPendingDeclineId(null);
      setNotice(`${signup.name}'s request was ${decision === 'approve' ? 'approved' : 'declined'}.`);
      // Re-read rather than trust the row we just removed: the same request can
      // be decided from the emailed link, or by another admin, while this page
      // is open, and the queue is the thing that has to be right.
      await load();
    } catch (err: unknown) {
      setError(err instanceof ApiError && err.status === 409
        ? `${signup.name}'s request had already been decided. The list below is up to date.`
        : err instanceof Error ? err.message : 'Could not record that decision.');
      await load();
    } finally {
      setActingId(null);
    }
  };

  if (loading) return <PageSkeleton label="Loading account requests…" />;

  const anyCaution = signups.some((s) => joinEmailCaution(s.mode, s.email, s.organisation));

  return (
    <div>
      <PageHeader
        icon="inbox"
        title="Account requests"
        subtitle="People asking for access. Nothing is created until someone here approves it."
      />

      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="ok">{notice}</Banner>}

      <div className="card">
        {signups.length === 0 && loadFailed ? (
          <div className="row" style={{ gap: 8 }}>
            <span className="muted small">The queue could not be read, so it is not known whether anyone is waiting.</span>
            <button type="button" className="btn secondary sm" onClick={() => { setLoading(true); void load(); }}>
              <Icon name="refresh" size={14} />Try again
            </button>
          </div>
        ) : signups.length === 0 ? (
          <EmptyState
            icon="inbox"
            title="No requests waiting"
            message="When someone asks for an account, it appears here for you to approve or decline."
          />
        ) : (
          <>
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Account requests">
              <table>
                <thead>
                  <tr>
                    <th>Who</th><th>Asking for</th><th>Requested</th><th><span className="visually-hidden">Decision</span></th>
                  </tr>
                </thead>
                <tbody>
                  {signups.map((signup) => {
                    const caution = joinEmailCaution(signup.mode, signup.email, signup.organisation);
                    const busy = actingId === signup.id;
                    return (
                      <tr key={signup.id}>
                        <td>
                          <div className="signup-who">{signup.name}</div>
                          <div className="muted small">{signup.email}</div>
                          {caution && (
                            <div className="signup-flag">
                              <Icon name="alert" size={13} />
                              <span>{caution}</span>
                            </div>
                          )}
                        </td>
                        <td>{applicantIntent(signup.mode, signup.organisation)}</td>
                        <td className="muted small">{formatDate(signup.createdAt)}</td>
                        <td>
                          <span className="row" style={{ gap: 6 }}>
                            <button type="button" className="btn sm" disabled={busy} aria-label={`Approve ${signup.name}'s request`}
                              onClick={() => void decide(signup, 'approve')}>Approve</button>
                            {pendingDeclineId === signup.id ? (
                              <>
                                <button type="button" className="btn sm secondary" disabled={busy} aria-label={`Confirm declining ${signup.name}'s request`}
                                  onClick={() => void decide(signup, 'decline')}>
                                  {busy ? 'Declining…' : 'Confirm decline'}
                                </button>
                                <button type="button" className="btn sm ghost" disabled={busy}
                                  onClick={() => setPendingDeclineId(null)}>Cancel</button>
                              </>
                            ) : (
                              <button type="button" className="btn sm secondary" disabled={busy} aria-label={`Decline ${signup.name}'s request`}
                                onClick={() => setPendingDeclineId(signup.id)}>Decline</button>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Said once, under the table, rather than beside every marked row:
                the check compares an address against a display name, and an
                operator who reads it as a verdict will decline a contractor. */}
            {anyCaution && (
              <p className="muted small" style={{ marginTop: 12 }}>
                Email checks compare the address with the organisation's name. They are a reason to look,
                not a verdict.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
