import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { Banner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/Skeleton';
import { formatDate } from '../components/dateFormat';
import { useToast } from '../components/Toast';
import { InviteColleague } from '../components/InviteColleague';
import { roleLabel } from '../components/inviteModel';

interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
}

/**
 * The people in this organisation, how a new one is added, and the one thing an
 * admin can do for a colleague who cannot sign in: cause a reset link to be
 * mailed to them.
 *
 * Neither of those is "set their password". An admin who could choose someone
 * else's password could sign in as them, and every action that account took
 * afterwards would be unattributable. The link goes to the address on the
 * account — the admin never sees it — and who sent it is recorded.
 *
 * That is also why adding a colleague is an invitation rather than a form with
 * a password field on it (components/InviteColleague.tsx). The endpoint that
 * would have an admin choose one still exists on the server and is deliberately
 * reachable from nowhere.
 */
export function TeamUsers() {
  const [users, setUsers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // A failed read is not an empty organisation.
  const [loadFailed, setLoadFailed] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ users: TeamMember[] }>('/admin/users');
      setUsers(data.users ?? []);
      setError('');
      setLoadFailed(false);
    } catch (err: unknown) {
      setLoadFailed(true);
      setError(err instanceof ApiError && err.status === 403
        ? 'Your role does not include managing people.'
        : err instanceof Error ? err.message : 'Could not load your team.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const sendReset = async (member: TeamMember) => {
    setActingId(member.id);
    setError('');
    try {
      const res = await api.post<{ ok: boolean; message: string }>(`/admin/users/${member.id}/password-reset`);
      setPendingId(null);
      if (res.ok) {
        // Done, and nothing left for the admin to do — the person's inbox is
        // where the rest happens.
        toast.show(res.message, { testId: 'reset-sent' });
      } else {
        // Nothing was sent. Usually because the colleague already pressed
        // "Forgot password" themselves in the last minute — they have a link,
        // and a second one would only retire it. Something to act on, so a
        // banner, not a toast that says "done".
        setError(res.message);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not send a reset link.');
    } finally {
      setActingId(null);
    }
  };

  if (loading) return <PageSkeleton label="Loading your team…" />;

  return (
    <div>
      <PageHeader
        icon="team"
        title="People"
        subtitle="Everyone with a Questor account in your organisation."
      />

      {error && <Banner kind="error">{error}</Banner>}

      {/* Above the list: adding someone is the errand people arrive here to do,
          and the list is what they check afterwards. */}
      <InviteColleague onInvited={() => { void load(); }} />

      <div className="card">
        {users.length === 0 && loadFailed ? (
          <div className="row" style={{ gap: 8 }}>
            <span className="muted small">Your team could not be read, so this list is not known to be complete.</span>
            <button type="button" className="btn secondary sm" onClick={() => { setLoading(true); void load(); }}>
              <Icon name="refresh" size={14} />Try again
            </button>
          </div>
        ) : users.length === 0 ? (
          <EmptyState icon="team" title="Nobody here yet" message="People with a Questor account in your organisation appear here." />
        ) : (
          <>
            <div className="table-scroll" tabIndex={0} role="region" aria-label="People in your organisation">
              <table>
                <thead>
                  <tr>
                    <th>Who</th><th>Role</th><th>Joined</th><th><span className="visually-hidden">Password</span></th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((member) => {
                    const busy = actingId === member.id;
                    return (
                      <tr key={member.id}>
                        <td>
                          <div className="signup-who">{member.name}</div>
                          <div className="muted small">{member.email}</div>
                        </td>
                        <td>{roleLabel(member.role)}</td>
                        <td className="muted small">{formatDate(member.createdAt)}</td>
                        <td>
                          {/* Two presses. Sending a link signs the person out of
                              nothing and changes nothing on its own, but it does
                              put an unexpected email in a colleague's inbox. */}
                          <span className="row" style={{ gap: 6 }}>
                            {pendingId === member.id ? (
                              <>
                                <button
                                  type="button" className="btn sm" disabled={busy}
                                  aria-label={`Confirm sending ${member.name} a password reset link`}
                                  onClick={() => void sendReset(member)}
                                >
                                  {busy ? 'Sending…' : 'Confirm send'}
                                </button>
                                <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setPendingId(null)}>Cancel</button>
                              </>
                            ) : (
                              <button
                                type="button" className="btn sm secondary" disabled={busy}
                                aria-label={`Send ${member.name} a password reset link`}
                                onClick={() => setPendingId(member.id)}
                              >
                                Send reset link
                              </button>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <p className="muted small" style={{ marginTop: 14 }}>
              A reset link goes to the address on the account and works once, for an hour. You never
              see it and you never set anyone's password — only they can. Every link sent from here
              is recorded in the audit log against your name.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
