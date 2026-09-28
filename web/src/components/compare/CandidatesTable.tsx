import { Link } from 'react-router-dom';
import { Banner, stateBadge } from '../ui';
import { Icon } from '../Icon';
import { EmptyState } from '../EmptyState';
import { VerdictCell } from '../VerdictCell';
import { ListPager } from '../ListPager';
import { ResponsiveList, type ListCard } from '../ResponsiveList';
import { candidateNextAction } from '../listCardModel';
import { formatDate } from '../dateFormat';
import { formatScoreOutOf100, hasScore, NO_SCORE } from '../scoreFormat';
import { usePagedList } from '../usePagedList';
import { COLUMN_LABELS, ariaSort, sortToParams, type SortKey, type SortState } from './comparisonModel';
import type { ComparabilityNote, RoleCandidateRow, RoleCandidatesPayload } from './candidateRow';

/**
 * This role's applicants, one row each, ordered by whichever column the
 * manager clicked.
 *
 * The sort is a server query, not a browser one: the page shows 25 rows of a
 * pipeline that may hold hundreds, and ordering only what happens to be on
 * screen answers a different question from the one being asked.
 */

/**
 * The sortable columns in the order the table draws them, which is not the
 * order SORT_KEYS lists them in: the heading row and the cells below it are
 * two lists that have to agree, so there is one list and both read from it.
 */
const TABLE_COLUMNS: readonly SortKey[] = ['name', 'stage', 'verdict', 'score', 'recency'];

const SCORE_HINT = 'The AI’s overall score for the interview. A reviewer’s verdict, where there is one, is in the Verdict column.';

/**
 * One sortable heading. The active column is marked by weight, a rule under it
 * and a caret the stylesheet draws — never a filled block — and the direction
 * is also spelled out for a screen reader.
 */
function SortHeader(props: { column: SortKey; sort: SortState; onSort: (key: SortKey) => void; hint?: string }) {
  const active = props.sort.key === props.column;
  return (
    <th aria-sort={ariaSort(props.sort, props.column)} className={active ? 'cmp-th is-sorted' : 'cmp-th'}>
      <button
        type="button"
        className="link-button cmp-sort"
        data-dir={active ? props.sort.dir : undefined}
        onClick={() => props.onSort(props.column)}
        title={props.hint}
      >
        {COLUMN_LABELS[props.column]}
        <span className="visually-hidden">
          {active ? `, sorted ${props.sort.dir === 'asc' ? 'ascending' : 'descending'}; activate to reverse` : ', activate to sort'}
        </span>
      </button>
    </th>
  );
}

/** Where a candidate's figures were not produced like the others': said, never hidden. */
export function ComparabilityMark({ notes }: { notes: readonly ComparabilityNote[] }) {
  if (!notes.length) return null;
  const scorecard = notes.some((n) => n.kind === 'scorecard_version');
  return (
    <span className="cmp-caveat" title={notes.map((n) => n.text).join(' ')}>
      <Icon name="alert" size={13} />
      {scorecard ? 'different scorecard version' : 'shallower interview'}
    </span>
  );
}

/**
 * The stage, and the decision if one has been made — in the one vocabulary the
 * server already put it in, so this page never has a second name for it.
 */
function stageCell(stage: RoleCandidateRow['stage']) {
  if (!stage) return <span className="muted">Not in the pipeline</span>;
  return (
    <>
      <span className="list-tier">{stage.label}</span>
      {stage.outcome && <div className="muted small">{stage.outcome}</div>}
    </>
  );
}

function scoreCell(row: RoleCandidateRow) {
  if (row.blindReviewPending) return <span className="muted small">Your review first</span>;
  return <span className={hasScore(row.overallScore) ? undefined : 'muted'}>{formatScoreOutOf100(row.overallScore)}</span>;
}

export function CandidatesTable(props: {
  readonly roleId: string;
  readonly sort: SortState;
  readonly onSort: (key: SortKey) => void;
  readonly shortlist: ReadonlySet<string>;
  readonly shortlistFull: boolean;
  readonly onShortlist: (candidateId: string, next: boolean) => void;
}) {
  const paged = usePagedList<RoleCandidatesPayload>({
    list: 'roleCandidates',
    base: `/roles/${encodeURIComponent(props.roleId)}/candidates`,
    extra: sortToParams(props.sort),
    failureMessage: 'Could not load this role’s candidates.',
  });
  const rows = paged.data?.candidates ?? [];
  const { meta, query } = paged;

  // On a card the box needs a word beside it: a lone checkbox in a column of
  // one says nothing about what ticking it does. In the table the column has a
  // heading of its own, so the word would be said twice on every row.
  const tick = (row: RoleCandidateRow, withWord = false) => {
    const on = props.shortlist.has(row.id);
    return (
      <label className="cmp-tick" title={!on && props.shortlistFull ? 'Your shortlist is full — untick someone first.' : undefined}>
        <input
          type="checkbox"
          checked={on}
          disabled={!on && props.shortlistFull}
          onChange={(e) => props.onShortlist(row.id, e.target.checked)}
        />
        {withWord && <span className="cmp-tick-word" aria-hidden="true">Shortlist</span>}
        <span className="visually-hidden">Shortlist {row.fullName}</span>
      </label>
    );
  };

  const cards: ListCard[] = rows.map((row) => ({
    key: row.id,
    testId: 'role-candidate-card',
    title: <Link to={`/candidates/${row.id}`}>{row.fullName}</Link>,
    badge: row.stage ? <span className="list-tier">{row.stage.label}</span> : undefined,
    lines: [
      <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <VerdictCell row={row} />
        {scoreCell(row)}
      </span>,
      ...(row.latestInterview ? [stateBadge(row.latestInterview.state)] : []),
      <span className="muted small">Last moved {formatDate(row.lastMovedAt)}</span>,
      ...(row.comparability.length ? [<ComparabilityMark notes={row.comparability} />] : []),
    ],
    next: candidateNextAction(row),
    extra: tick(row, true),
  }));

  const table = (
    <table className="cmp-table">
      <thead>
        <tr>
          <th className="cmp-pick"><span className="visually-hidden">Shortlist</span></th>
          {TABLE_COLUMNS.map((key) => (
            <SortHeader
              key={key}
              column={key}
              sort={props.sort}
              onSort={props.onSort}
              hint={key === 'score' ? SCORE_HINT : undefined}
            />
          ))}
          <th>Interview</th>
          <th>Next step</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const next = candidateNextAction(row);
          return (
            <tr key={row.id} data-testid="role-candidate-row" className={props.shortlist.has(row.id) ? 'is-shortlisted' : undefined}>
              <td className="cmp-pick">{tick(row)}</td>
              <td>
                <Link to={`/candidates/${row.id}`}>{row.fullName}</Link>
                <div className="muted small">{row.email}</div>
                <ComparabilityMark notes={row.comparability} />
              </td>
              <td>{stageCell(row.stage)}</td>
              <td><VerdictCell row={row} /></td>
              <td>{scoreCell(row)}</td>
              <td className="muted small">{formatDate(row.lastMovedAt)}</td>
              <td>{row.latestInterview ? stateBadge(row.latestInterview.state) : <span className="muted">{NO_SCORE}</span>}</td>
              <td><Link className="link-action" to={next.to}>{next.label}<Icon name="arrow-right" size={15} /></Link></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <div>
      {paged.error && <Banner kind="error">{paged.error}</Banner>}
      <div className="row spread list-toolbar">
        <input
          className="filter-input"
          type="search"
          placeholder="Search these candidates by name or email…"
          value={paged.draft}
          maxLength={200}
          onChange={(e) => paged.setDraft(e.target.value)}
          aria-label="Search this role's candidates"
        />
        {paged.refreshing && <span className="muted small">Loading…</span>}
      </div>

      {paged.loading ? <p className="muted small">Loading candidates…</p>
        : meta.total === 0 && !query ? (
          <EmptyState
            compact
            icon="candidates"
            title="No candidates on this role yet"
            message="Add a candidate, or import several from a CSV, and they will line up here to compare."
          />
        ) : meta.total === 0 ? (
          <EmptyState
            compact
            icon="search"
            title="No matches"
            message={`No candidate on this role matches “${query}”.`}
            action={<button type="button" className="btn secondary sm" onClick={paged.clearSearch}><Icon name="close" size={14} />Clear search</button>}
          />
        ) : (
          <>
            <ResponsiveList label="Role candidates" table={table} cards={cards} />
            <ListPager
              meta={meta}
              pageSize={paged.pageSize}
              noun="candidate"
              label="Role candidates"
              onPage={paged.setPage}
              onPageSize={paged.setPageSize}
            />
          </>
        )}
    </div>
  );
}
