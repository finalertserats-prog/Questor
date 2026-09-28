import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Banner } from './ui';
import { Icon } from './Icon';
import { useToast } from './Toast';
import { INVITABLE_ROLES, inviteExpiryLabel, inviteFormProblem, roleBlurb, roleLabel } from './inviteModel';

interface PendingInvite {
  id: string;
  name: string;
  email: string;
  role: string;
  expiresAt: string;
  createdAt: string;
  expired: boolean;
}

/**
 * Adding a colleague.
 *
 * The admin names the person and what they will be able to do. The person names
 * their own password, from a link that goes to their mailbox and never appears
 * on this screen.
 *
 * `POST /api/admin/users` — which would have the admin type a colleague's
 * password here — exists on the server and is deliberately not reachable from
 * anywhere in the product. Someone who can set another person's password can
 * sign in as them, and everything that account then does is unattributable.
 * That is not a theoretical loss: the expert review this product is built
 * around is nothing but attribution — "this named person recommended this".
 */
export function InviteColleague({ onInvited }: { onInvited: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('recruiter');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [revoking, setRevoking] = useState<string | null>(null);

  const loadInvites = useCallback(async () => {
    try {
      const data = await api.get<{ invites: PendingInvite[] }>('/admin/invites');
      setInvites(data.invites ?? []);
    } catch {
      // The list is context for the form above it. Failing to read it is not a
      // reason to stop somebody sending an invitation.
      setInvites([]);
    }
  }, []);

  useEffect(() => { void loadInvites(); }, [loadInvites]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const bad = inviteFormProblem(name, email, role);
    if (bad) { setProblem(bad); return; }
    setProblem('');
    setBusy(true);
    try {
      const res = await api.post<{ message: string }>('/admin/invites', { name: name.trim(), email: email.trim(), role });
      setName('');
      setEmail('');
      // Done, and nothing left for the admin to do — the colleague's inbox is
      // where the rest happens.
      toast.show(res.message, { testId: 'invite-sent' });
      await loadInvites();
      onInvited();
    } catch (err: unknown) {
      setProblem(err instanceof Error ? err.message : 'Could not send the invitation.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (invite: PendingInvite) => {
    setRevoking(invite.id);
    try {
      await api.del(`/admin/invites/${invite.id}`);
      await loadInvites();
      toast.show(`${invite.name}'s invitation no longer works.`, { testId: 'invite-revoked' });
    } catch (err: unknown) {
      setProblem(err instanceof Error ? err.message : 'Could not withdraw the invitation.');
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div className="card">
      <h2 className="card-title"><Icon name="add-candidate" />Invite a colleague</h2>

      {problem && <Banner kind="error">{problem}</Banner>}

      <form onSubmit={submit} noValidate>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 200px' }}>
            <label htmlFor="invite-name">Their name</label>
            <input id="invite-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </div>
          <div style={{ flex: '1 1 240px' }}>
            <label htmlFor="invite-email">Their email</label>
            <input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
          </div>
          <div style={{ flex: '1 1 200px' }}>
            <label htmlFor="invite-role">What they can do</label>
            <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value)} aria-describedby="invite-role-hint">
              {INVITABLE_ROLES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {/* The role is the one thing on this form that cannot be undone by
                asking again, so what it means is said where it is chosen. */}
            <p className="field-hint" id="invite-role-hint">{roleBlurb(role)}</p>
          </div>
        </div>

        <button className="btn" style={{ marginTop: 6 }} disabled={busy} data-testid="invite-submit">
          {busy ? 'Sending…' : 'Send invitation'}
        </button>
      </form>

      <p className="muted small" style={{ marginTop: 14 }}>
        They set their own password from a link that goes to that address and works once, for seven days.
        You never see it and you never set anyone's password — only they can.
      </p>

      {invites.length > 0 && (
        <>
          <h3>Waiting to join</h3>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Colleagues who have been invited and have not joined">
            <table>
              <thead>
                <tr><th>Who</th><th>Role</th><th>Invitation</th><th><span className="visually-hidden">Withdraw</span></th></tr>
              </thead>
              <tbody>
                {invites.map((invite) => (
                  <tr key={invite.id}>
                    <td>
                      <div className="signup-who">{invite.name}</div>
                      <div className="muted small">{invite.email}</div>
                    </td>
                    <td>{roleLabel(invite.role)}</td>
                    <td className="muted small">{inviteExpiryLabel(invite.expiresAt)}</td>
                    <td>
                      <button
                        type="button" className="btn sm ghost" disabled={revoking === invite.id}
                        aria-label={`Withdraw ${invite.name}'s invitation`}
                        onClick={() => void revoke(invite)}
                      >
                        {revoking === invite.id ? 'Withdrawing…' : 'Withdraw'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
