import { useId } from 'react';
import type { CatalogReviewFilters, NamedRef } from './catalogReviewModel';

interface Props {
  readonly filters: CatalogReviewFilters;
  /** The search box's text as typed; applied to `filters.q` after a pause. */
  readonly searchDraft: string;
  readonly domains: readonly NamedRef[];
  readonly onChange: (change: Partial<CatalogReviewFilters>) => void;
  readonly onSearchDraft: (value: string) => void;
}

/** One row of filters on a wide screen; the fields wrap one by one on a phone. */
export function CatalogReviewFilterBar({ filters, searchDraft, domains, onChange, onSearchDraft }: Props) {
  const id = useId();
  return (
    <div className="filter-bar" role="search" aria-label="Filter proposals">
      <div className="filter-field">
        <label htmlFor={`${id}-status`}>Status</label>
        <select id={`${id}-status`} value={filters.status} onChange={(e) => onChange({ status: e.target.value as CatalogReviewFilters['status'] })}>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="superseded">Already in catalog</option>
          <option value="">Any status</option>
        </select>
      </div>
      <div className="filter-field">
        <label htmlFor={`${id}-kind`}>Kind</label>
        <select id={`${id}-kind`} value={filters.kind} onChange={(e) => onChange({ kind: e.target.value as CatalogReviewFilters['kind'] })}>
          <option value="">All kinds</option>
          <option value="new_role">New roles</option>
          <option value="new_alias">Alternative titles</option>
        </select>
      </div>
      <div className="filter-field">
        <label htmlFor={`${id}-domain`}>Domain</label>
        <select id={`${id}-domain`} value={filters.domainId} onChange={(e) => onChange({ domainId: e.target.value })}>
          <option value="">All domains</option>
          {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>
      <div className="filter-field">
        <label htmlFor={`${id}-source`}>Source</label>
        <select id={`${id}-source`} value={filters.source} onChange={(e) => onChange({ source: e.target.value as CatalogReviewFilters['source'] })}>
          <option value="">All sources</option>
          <option value="onet">O*NET</option>
          <option value="esco">ESCO</option>
          <option value="web">Web research</option>
        </select>
      </div>
      <div className="filter-field filter-field-search">
        <label htmlFor={`${id}-q`}>Search</label>
        <input id={`${id}-q`} type="search" placeholder="Title or summary…" maxLength={120} value={searchDraft} onChange={(e) => onSearchDraft(e.target.value)} />
      </div>
    </div>
  );
}
