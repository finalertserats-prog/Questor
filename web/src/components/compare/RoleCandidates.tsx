import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { Banner } from '../ui';
import { Icon } from '../Icon';
import { useToast } from '../Toast';
import { CandidatesTable } from './CandidatesTable';
import { SkillsGrid } from './SkillsGrid';
import { SideBySide } from './SideBySide';
import {
  MIN_COMPARISON,
  nextSort,
  shortlistHint,
  shortlistPath,
  sortFromParams,
  type SortKey,
} from './comparisonModel';
import type { ShortlistPayload } from './candidateRow';

/**
 * The role page's comparison: the candidates table, the skills grid across
 * them, and the side-by-side of the two to four a reviewer has shortlisted.
 *
 * The role page used to list no candidates at all, so comparing three people
 * meant three separate pages. The sort, the page and the view all live in the
 * address, which is what makes "here are the three I am looking at" something
 * a person can send to a colleague.
 *
 * The shortlist is this reviewer's own, not the team's: see the model comment
 * on CandidateShortlist for why that is deliberate rather than a shortcut.
 */

type View = 'table' | 'grid';

function viewFromParams(params: URLSearchParams): View {
  return params.get('view') === 'grid' ? 'grid' : 'table';
}

export function RoleCandidates({ roleId }: { roleId: string }) {
  const [params, setParams] = useSearchParams();
  const sort = sortFromParams(params);
  const view = viewFromParams(params);
  const toast = useToast();

  const [shortlist, setShortlist] = useState<readonly string[]>([]);
  const [max, setMax] = useState(4);
  const [error, setError] = useState('');
  const [comparing, setComparing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get<ShortlistPayload>(shortlistPath(roleId))
      .then((d) => { if (!cancelled) { setShortlist(d.candidateIds); setMax(d.max); } })
      // A shortlist that will not load is not a reason to hide the candidates.
      .catch(() => { if (!cancelled) setShortlist([]); });
    return () => { cancelled = true; };
  }, [roleId]);

  const setSort = useCallback((key: SortKey) => {
    const next = nextSort(sort, key);
    setParams((current) => {
      const updated = new URLSearchParams(current);
      updated.set('sort', next.key);
      updated.set('dir', next.dir);
      // A new order starts at the first page; page 4 of the old order is not
      // page 4 of the new one.
      updated.delete('page');
      return updated;
    });
  }, [sort, setParams]);

  const setView = (next: View) => {
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next === 'grid') updated.set('view', 'grid'); else updated.delete('view');
      return updated;
    });
  };

  const onShortlist = async (candidateId: string, next: boolean) => {
    setError('');
    try {
      const result = next
        ? await api.post<ShortlistPayload>(shortlistPath(roleId), { candidateId })
        : await api.del<ShortlistPayload>(`${shortlistPath(roleId)}/${encodeURIComponent(candidateId)}`);
      setShortlist(result.candidateIds);
      setMax(result.max);
      toast.show(next ? 'Added to your shortlist.' : 'Removed from your shortlist.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not change your shortlist.');
    }
  };

  const canCompare = shortlist.length >= MIN_COMPARISON;

  return (
    <section className="card cmp" aria-label="Candidates on this role">
      <div className="row spread cmp-head">
        <h2 className="card-title"><Icon name="candidates" size={16} />Candidates on this role</h2>
        <div className="cmp-views" role="group" aria-label="How to compare">
          <button
            type="button"
            className="cmp-view"
            aria-pressed={view === 'table'}
            onClick={() => setView('table')}
          >
            <Icon name="list" size={15} />Table
          </button>
          <button
            type="button"
            className="cmp-view"
            aria-pressed={view === 'grid'}
            onClick={() => setView('grid')}
          >
            <Icon name="skills-assessment" size={15} />Skills grid
          </button>
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      <div className="cmp-bar">
        <span className="muted small">{shortlistHint(shortlist.length, max)}</span>
        <button
          type="button"
          className="btn secondary sm"
          disabled={!canCompare}
          onClick={() => setComparing(true)}
          title={canCompare ? undefined : `Tick at least ${MIN_COMPARISON} candidates to compare them.`}
          data-testid="compare-button"
        >
          <Icon name="shortlist" size={15} />
          Compare {shortlist.length > 0 ? shortlist.length : ''} side by side
        </button>
      </div>

      {comparing && canCompare && (
        <SideBySide roleId={roleId} candidateIds={shortlist} onClose={() => setComparing(false)} />
      )}

      {view === 'grid'
        ? <SkillsGrid roleId={roleId} sort={sort} />
        : (
          <CandidatesTable
            roleId={roleId}
            sort={sort}
            onSort={setSort}
            shortlist={new Set(shortlist)}
            shortlistFull={shortlist.length >= max}
            onShortlist={(id, next) => void onShortlist(id, next)}
          />
        )}
    </section>
  );
}
