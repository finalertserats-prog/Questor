import { useId } from 'react';
import { Icon } from './Icon';
import { pageButtons, pageRangeLabel, PAGE_SIZES, parsePageSize, totalPages, DEFAULT_PAGE_SIZE, type PageMeta, type PageSize } from './listPagingModel';

/**
 * Page controls and the page-size choice for a server-paged list. The current
 * page is marked by a rule under it and weight, never a filled block.
 */
export function ListPager(props: {
  readonly meta: PageMeta;
  readonly pageSize: PageSize;
  /** "candidate" — the plural adds an s unless given. */
  readonly noun: string;
  readonly nounPlural?: string;
  /** Names the navigation for a screen reader: "Candidates pages". */
  readonly label: string;
  readonly onPage: (page: number) => void;
  readonly onPageSize: (size: PageSize) => void;
}) {
  const { meta, pageSize, noun, nounPlural, label, onPage, onPageSize } = props;
  const sizeId = useId();
  const pages = totalPages(meta.total, pageSize);
  const page = Math.min(meta.page, pages);

  return (
    <nav className="pager" aria-label={`${label} pages`}>
      <span className="pager-range muted small" role="status">{pageRangeLabel({ ...meta, page }, noun, nounPlural)}</span>
      {pages > 1 && (
        <div className="pager-pages">
          <button type="button" className="pager-step" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
            <Icon name="arrow-left" size={15} /><span className="pager-step-text">Previous</span>
          </button>
          {pageButtons(page, pages).map((n, index) => (n === null
            ? <span key={`gap-${index}`} className="pager-gap" aria-hidden="true">…</span>
            : (
              <button
                key={n}
                type="button"
                className="pager-page"
                aria-current={n === page ? 'page' : undefined}
                aria-label={`Page ${n}`}
                onClick={() => { if (n !== page) onPage(n); }}
              >
                {n}
              </button>
            )))}
          <button type="button" className="pager-step" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
            <span className="pager-step-text">Next</span><Icon name="arrow-right" size={15} />
          </button>
        </div>
      )}
      <span className="pager-size">
        <label htmlFor={sizeId} className="small muted">Rows per page</label>
        <select
          id={sizeId}
          value={pageSize}
          onChange={(e) => { const size = parsePageSize(e.target.value); if (size) onPageSize(size); }}
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>{size === DEFAULT_PAGE_SIZE ? `${size} (recommended)` : size}</option>
          ))}
        </select>
      </span>
    </nav>
  );
}
