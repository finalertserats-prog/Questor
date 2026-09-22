import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Banner } from './ui';
import { Icon } from './Icon';
import { useToast } from './Toast';
import { roleDisplayLabels } from './roleLabelModel';
import {
  COPIED_DETAILS_NOTE,
  applyFailureMessage,
  existingApplicationId,
  initialRoleId,
  roleEntryLabel,
  rolesOpenToPerson,
  type CandidatePerson,
  type ReuseRole,
} from './candidateReuseModel';

interface Role extends ReuseRole {
  readonly level: string;
  readonly regionCode?: string | null;
  readonly experienceBand?: string | null;
  readonly createdAt?: string | null;
}

// Only the refusal stays in the panel; a new application is confirmed in a
// toast and the panel closes, since the list behind it now shows the row.
type Outcome = { readonly kind: 'exists'; readonly candidateId: string | null };

/**
 * "Set up for another role", from the candidates list or a candidate's page:
 * choose a role and the person is added to it as a new application, their
 * details and latest resume copied and scored for that role.
 */
export function SetUpForAnotherRole(props: {
  readonly candidateId: string;
  readonly fullName: string;
  readonly email: string;
  readonly onClose: () => void;
  /** Called once the new application exists, e.g. to re-read a list. */
  readonly onApplied?: () => void;
}) {
  const fieldId = useId();
  const [roles, setRoles] = useState<Role[]>([]);
  const [person, setPerson] = useState<CandidatePerson | null>(null);
  const [roleId, setRoleId] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({ q: props.email });
    Promise.all([
      api.get<{ roles: Role[] }>('/roles'),
      api.get<{ people: CandidatePerson[] }>(`/candidates/search?${qs.toString()}`),
    ])
      .then(([r, s]) => {
        if (cancelled) return;
        // The search names every role the viewer can see this person in, which
        // is what keeps those roles out of the choice below.
        const found = existingPerson(s.people ?? [], props);
        const open = rolesOpenToPerson(r.roles ?? [], found);
        setRoles(open);
        setPerson(found);
        setRoleId(initialRoleId(open, null));
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load roles.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [props.candidateId, props.email, props.fullName]);

  const labels = roleDisplayLabels(roles.map((r) => ({ ...r, title: r.level ? `${r.title} (${r.level})` : r.title })));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!person || !roleId || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const { candidate } = await api.post<{ candidate: { id: string } }>(`/candidates/${person.candidateId}/apply`, { roleId });
      const roleLabel = labels[roles.findIndex((r) => r.id === roleId)] ?? 'the role';
      toast.show(`${props.fullName} is now a candidate for ${roleLabel}.`, {
        action: <Link className="link-action" to={`/candidates/${candidate.id}?tab=journey`}>Set up interview</Link>,
      });
      props.onApplied?.();
      props.onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'candidate_exists') {
        setOutcome({ kind: 'exists', candidateId: existingApplicationId(err) });
      } else {
        setError(applyFailureMessage(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="card">
      <div className="row spread">
        <h2 className="card-title" style={{ margin: 0 }}><Icon name="role" />Set up {props.fullName} for another role</h2>
        <button type="button" className="btn secondary sm" onClick={props.onClose}><Icon name="close" size={14} />Close</button>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      {outcome?.kind === 'exists' && (
        <Banner kind="info">
          {props.fullName} is already a candidate for that role.{' '}
          {outcome.candidateId && <Link className="link-action" to={`/candidates/${outcome.candidateId}`}>Open that application</Link>}
        </Banner>
      )}
      {loading ? (
        <p className="muted">Loading roles…</p>
      ) : person && !outcome && (
        <form onSubmit={submit}>
          {person.roles.length > 0 && (
            <p className="small">Already in: {person.roles.map(roleEntryLabel).join(', ')}</p>
          )}
          {roles.length === 0 ? (
            <p className="muted">No other open role with an approved scorecard to add them to.</p>
          ) : (
            <>
              <label htmlFor={`${fieldId}-role`}>Role</label>
              <select id={`${fieldId}-role`} value={roleId} onChange={(e) => setRoleId(e.target.value)} required>
                {labels.map((label, index) => <option key={roles[index].id} value={roles[index].id}>{label}</option>)}
              </select>
              <p className="muted small">
                {person.hasResume ? 'Their latest resume is carried over and scored for this role. ' : 'No resume on file yet; add one from the new application. '}
                {COPIED_DETAILS_NOTE}
              </p>
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn" type="submit" disabled={submitting || !roleId}>
                  <Icon name={submitting ? 'hourglass' : 'add-candidate'} size={16} />
                  {submitting ? 'Setting up…' : 'Set up for this role'}
                </button>
              </div>
            </>
          )}
        </form>
      )}
    </div>
  );
}

/** The person the search found for this address, or this application alone when it found nothing. */
function existingPerson(people: readonly CandidatePerson[], fallback: { readonly candidateId: string; readonly fullName: string; readonly email: string }): CandidatePerson {
  const wanted = fallback.email.trim().toLowerCase();
  return people.find((p) => p.email.trim().toLowerCase() === wanted)
    ?? { candidateId: fallback.candidateId, fullName: fallback.fullName, email: fallback.email, phone: '', hasResume: false, roles: [] };
}
