import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api/client';
import { Banner } from './ui';
import { useToast } from './Toast';
import { businessAreaCountLabel, canAddBusinessArea, filterBusinessAreas, toggleBusinessArea } from './onboardModel';
import '../styles/onboard.css';

interface Area { readonly slug: string; readonly name: string }
interface AvailableArea extends Area { readonly summary: string }
interface BusinessAreasResponse {
  readonly limit: number;
  readonly chosen: readonly Area[];
  readonly available: readonly AvailableArea[];
}

/**
 * The business areas this organisation hires for, changed by its own admin.
 *
 * Choosing areas narrows the shared role catalog to the part this organisation
 * works in. The wording below has to keep saying that it is a view: nobody
 * should read "we removed Finance" as "Finance is now hidden from us", because
 * the catalog is shared and one click still shows all of it.
 *
 * Going past the limit is the platform owner's to allow, so the form stops at
 * it rather than pretending and being refused by the server.
 */
export function BusinessAreasPanel() {
  const [data, setData] = useState<BusinessAreasResponse | null>(null);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const res = await api.get<BusinessAreasResponse>('/admin/business-areas');
      setData(res);
      setChosen(res.chosen.map((a) => a.slug));
      setError('');
      setLoadFailed(false);
    } catch (err: unknown) {
      // A failed read is not "no areas chosen": showing an empty list over a
      // failure invites someone to "fix" it by saving that empty list.
      setLoadFailed(true);
      setError(err instanceof Error ? err.message : 'Could not load your business areas.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const limit = data?.limit ?? 5;
  const visible = useMemo(() => filterBusinessAreas(data?.available ?? [], query), [data, query]);
  const saved = useMemo(() => (data?.chosen ?? []).map((a) => a.slug).join('|'), [data]);
  const dirty = chosen.join('|') !== saved;

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await api.put<{ limit: number; chosen: readonly Area[] }>('/admin/business-areas', { areas: [...chosen] });
      setData((current) => (current ? { ...current, limit: res.limit, chosen: res.chosen } : current));
      toast.show(res.chosen.length === 0
        ? 'Your catalog now shows every business area.'
        : `Your catalog now shows ${res.chosen.length} business ${res.chosen.length === 1 ? 'area' : 'areas'}.`);
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : 'Could not save your business areas.');
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loadFailed) {
    return (
      <div className="card">
        <h2 className="card-title">Business areas</h2>
        <Banner kind="error">{error}</Banner>
        <button type="button" className="btn secondary sm" onClick={() => void load()}>Try again</button>
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="card">
      <h2 className="card-title">Business areas</h2>
      <p className="muted small">
        The role catalog is shared by every organisation on Questor. Choosing your areas narrows
        what you search by default, so finding a role takes seconds. It is a view, not a wall —
        you can always search the whole catalog from the role form.
      </p>
      <p className="muted small">
        You can hold up to {limit}. Ask the Questor team if you need more.
      </p>

      {error && <Banner kind="error">{error}</Banner>}

      <label htmlFor="areas-search" className="visually-hidden">Search business areas</label>
      <input
        id="areas-search" type="search" value={query} placeholder="Search business areas…"
        onChange={(e) => setQuery(e.target.value)}
      />

      <p className="onboard-count" aria-live="polite">{businessAreaCountLabel(chosen, limit)}</p>

      <ul className="onboard-areas">
        {visible.map((area) => {
          const isChosen = chosen.includes(area.slug);
          const open = canAddBusinessArea(chosen, area.slug, limit);
          return (
            <li key={area.slug}>
              <label className={`onboard-area${isChosen ? ' is-chosen' : ''}${open ? '' : ' is-full'}`}>
                <input
                  type="checkbox" checked={isChosen} disabled={!open || busy}
                  onChange={() => setChosen((c) => toggleBusinessArea(c, area.slug, limit))}
                />
                <span className="onboard-area-name">{area.name}</span>
                {area.summary && <span className="onboard-area-detail">{area.summary}</span>}
              </label>
            </li>
          );
        })}
      </ul>
      {visible.length === 0 && <p className="muted small">No business area matches that. Try a shorter word.</p>}

      <div className="row" style={{ gap: 8, marginTop: 14 }}>
        <button type="button" className="btn" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save business areas'}
        </button>
        {dirty && (
          <button type="button" className="btn secondary" disabled={busy}
            onClick={() => setChosen((data.chosen ?? []).map((a) => a.slug))}>
            Discard changes
          </button>
        )}
      </div>
      {chosen.length === 0 && (
        <p className="muted small" style={{ marginTop: 8 }}>
          With none chosen you see the whole catalog, which is how every organisation started.
        </p>
      )}
    </div>
  );
}
