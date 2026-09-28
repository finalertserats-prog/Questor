import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { Banner } from './ui';
import { useToast } from './Toast';
import { DEFAULT_BUSINESS_AREA_LIMIT } from './onboardModel';

interface Organisation {
  readonly id: string;
  readonly name: string;
  readonly slug: string | null;
  readonly region: string;
  readonly businessAreaLimit: number;
  readonly businessAreaCount: number;
}

const MAX_LIMIT = 35;

/**
 * Raising how many business areas an organisation may hold.
 *
 * Only the platform owner sees this, and only the platform owner can do it —
 * an organisation raising its own ceiling would make the ceiling a suggestion.
 * Every change is audited with what it was and what it became.
 *
 * It sits on the owner's requests page because that is the owner's page: the
 * two things asked here are "should this organisation exist" and "should this
 * one have more of the catalog", and both are the same person's to answer.
 */
export function OrganisationLimits() {
  const [orgs, setOrgs] = useState<readonly Organisation[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  // Only the owner may read this; anyone else is simply not shown the panel
  // rather than shown a 403 they can do nothing about.
  const [allowed, setAllowed] = useState(true);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ organisations: readonly Organisation[] }>('/admin/organisations');
      // A server that answers without the list must not blank the whole page:
      // this panel sits beside the account-requests queue an operator is working.
      setOrgs(Array.isArray(data?.organisations) ? data.organisations : []);
      setError('');
    } catch (err: unknown) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 503)) {
        setAllowed(false);
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not load organisations.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async (org: Organisation) => {
    const value = Number(draft[org.id] ?? org.businessAreaLimit);
    setSavingId(org.id);
    setError('');
    try {
      await api.put(`/admin/organisations/${org.id}/business-area-limit`, { limit: value });
      toast.show(`${org.name} can now hold ${value} business ${value === 1 ? 'area' : 'areas'}.`);
      setDraft((d) => { const next = { ...d }; delete next[org.id]; return next; });
      await load();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Could not change that limit.');
    } finally {
      setSavingId(null);
    }
  };

  if (!allowed || !orgs || orgs.length === 0) return null;

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <h2 className="card-title">Business-area limits</h2>
      <p className="muted small">
        Every organisation may hold {DEFAULT_BUSINESS_AREA_LIMIT} business areas of the shared role
        catalog. Raise it here when one hires across more than that. Narrowing the catalog is only
        a default view — it never hides a role from anyone.
      </p>

      {error && <Banner kind="error">{error}</Banner>}

      <div className="table-scroll" tabIndex={0} role="region" aria-label="Business-area limits">
        <table>
          <thead>
            <tr>
              <th>Organisation</th><th>Holding</th><th>Limit</th>
              <th><span className="visually-hidden">Save</span></th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((org) => {
              const value = draft[org.id] ?? String(org.businessAreaLimit);
              const changed = Number(value) !== org.businessAreaLimit;
              const busy = savingId === org.id;
              return (
                <tr key={org.id}>
                  <td>
                    <div className="signup-who">{org.name}</div>
                    {org.slug && <div className="muted small">/o/{org.slug}</div>}
                  </td>
                  <td className="muted small">
                    {org.businessAreaCount === 0 ? 'the whole catalog' : `${org.businessAreaCount} chosen`}
                  </td>
                  <td>
                    <label htmlFor={`limit-${org.id}`} className="visually-hidden">
                      Business-area limit for {org.name}
                    </label>
                    <input
                      id={`limit-${org.id}`} type="number" min={1} max={MAX_LIMIT} value={value}
                      style={{ width: 84 }} disabled={busy}
                      onChange={(e) => setDraft((d) => ({ ...d, [org.id]: e.target.value }))}
                    />
                  </td>
                  <td>
                    <button
                      type="button" className="btn sm" disabled={!changed || busy}
                      onClick={() => void save(org)}
                    >
                      {busy ? 'Saving…' : 'Save'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
