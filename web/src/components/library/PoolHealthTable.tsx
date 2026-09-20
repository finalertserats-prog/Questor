import { EmptyState } from '../EmptyState';
import { depthLabel, formMixLabel, healthLabel, healthTone, humanSlug, sortPools, type PoolRow } from './libraryAdminModel';

/** Depth against target, form mix and status counts per pool; the worst pools first. */
export function PoolHealthTable({ pools }: { pools: readonly PoolRow[] }) {
  if (pools.length === 0) {
    return <EmptyState compact icon="list" title="No pools yet" message="Pools appear once a role with an approved scorecard exists and the worker has computed targets." />;
  }
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Pool health">
      <table className="library-pools" data-testid="library-pools">
        <thead>
          <tr><th>Role</th><th>Competency</th><th>Band</th><th>Depth</th><th>Forms</th><th>Queue</th><th>Health</th></tr>
        </thead>
        <tbody>
          {sortPools(pools).map((p) => (
            <tr key={`${p.roleSlug}|${p.competencyKey}|${p.band}`} data-testid="library-pool-row" className={`is-${healthTone(p.health)}`}>
              <td className="library-pool-role">{humanSlug(p.roleSlug)}</td>
              <td>{humanSlug(p.competencyKey)}</td>
              <td>{p.band}</td>
              <td>{depthLabel(p)}</td>
              <td className="small">{formMixLabel(p.formMix)}{!p.formMixOk && p.live + p.probational > 0 ? ' · mix off' : ''}</td>
              <td>{p.queued}</td>
              <td><span className={`library-health is-${healthTone(p.health)}`}>{healthLabel(p.health)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
