import { Link } from 'react-router-dom';
import { Banner } from '../ui';
import { Icon } from '../Icon';
import { EmptyState } from '../EmptyState';
import { ListPager } from '../ListPager';
import { usePagedList } from '../usePagedList';
import { useIsPhone } from '../ResponsiveList';
import { ComparabilityMark } from './CandidatesTable';
import {
  LEVEL_MAX,
  cellLabel,
  cellStanding,
  cellTitle,
  levelTicks,
  sortToParams,
  type GridCell,
  type SortState,
} from './comparisonModel';
import type { GridCompetency, GridPayload, GridRow } from './candidateRow';

const WITHHELD_TEXT = 'Record your own verdict first — this candidate’s levels stay hidden until then.';

/**
 * The role's competencies across every candidate: people down, competencies
 * across, one level per cell.
 *
 * Read at a glance, without colour doing the work. A level is a numeral with
 * as many small marks as the level, and how it stands against what the role
 * asks for is carried by weight and a rule — so "three of them are strong on
 * delivery and only one on stakeholder handling" is visible in the shape of
 * the column, not in a wash of green.
 *
 * A competency with nothing behind it says so in words. A zero in a column of
 * levels reads as "scored badly", which is a statement the data does not make.
 */

function Cell({ cell, competency }: { cell: GridCell; competency: GridCompetency }) {
  const title = cellTitle(cell, competency.name, competency.requiredLevel);
  if (cell.kind !== 'level') {
    return (
      <td className={`cmp-cell is-${cell.kind === 'no_evidence' ? 'none' : 'absent'}`} title={title}>
        <span className="cmp-cell-word">{cellLabel(cell)}</span>
      </td>
    );
  }
  const standing = cellStanding(cell.level, competency.requiredLevel);
  return (
    <td className={standing ? `cmp-cell is-${standing}` : 'cmp-cell'} title={title}>
      <span className="cmp-level">{cell.level}</span>
      <span className="cmp-ticks" aria-hidden="true">
        {levelTicks(cell.level).map((on, i) => <i key={i} className={on ? 'is-on' : undefined} />)}
      </span>
      <span className="visually-hidden">{title}</span>
    </td>
  );
}

function RowHead({ row }: { row: GridRow }) {
  return (
    <th scope="row" className="cmp-rowhead">
      <Link to={`/candidates/${row.candidateId}`}>{row.fullName}</Link>
      {row.levelSource && (
        <span className="muted small cmp-source">[ {row.levelSource === 'human' ? 'reviewer’s levels' : 'AI levels'} ]</span>
      )}
      <ComparabilityMark notes={row.comparability} />
    </th>
  );
}

/** A withheld row keeps its name and says why it is empty, rather than showing dashes. */
function WithheldRow({ row, span }: { row: GridRow; span: number }) {
  return (
    <tr data-testid="skills-grid-row">
      <RowHead row={row} />
      <td className="cmp-withheld" colSpan={span}>
        <span className="muted small">{WITHHELD_TEXT}</span>
        {row.assessmentId && (
          <Link className="link-action" to={`/assessments/${row.assessmentId}/review`}>
            <Icon name="human-review" size={15} />Give your review
          </Link>
        )}
      </td>
    </tr>
  );
}

/** On a phone the grid becomes one block per candidate: a column of competency rows. */
function PhoneGrid({ rows, competencies }: { rows: readonly GridRow[]; competencies: readonly GridCompetency[] }) {
  return (
    <ul className="cmp-phone" aria-label="Skills across candidates">
      {rows.map((row) => (
        <li key={row.candidateId} className="cmp-phone-card" data-testid="skills-grid-card">
          <div className="cmp-phone-top">
            <Link to={`/candidates/${row.candidateId}`}>{row.fullName}</Link>
            <ComparabilityMark notes={row.comparability} />
          </div>
          {row.blindReviewPending ? (
            <p className="muted small">{WITHHELD_TEXT}</p>
          ) : (
            <dl className="cmp-phone-list">
              {competencies.map((c) => {
                const cell = row.cells[c.id] ?? { kind: 'not_assessed' as const };
                return (
                  <div key={c.id} className="cmp-phone-line">
                    <dt>{c.name}</dt>
                    <dd className={cell.kind === 'level' ? `is-${cellStanding(cell.level, c.requiredLevel) ?? 'plain'}` : 'is-word'}>
                      {cellLabel(cell)}
                      {cell.kind === 'level' && <span className="muted small"> of {LEVEL_MAX}</span>}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
        </li>
      ))}
    </ul>
  );
}

export function SkillsGrid(props: { readonly roleId: string; readonly sort: SortState }) {
  const isPhone = useIsPhone();
  const paged = usePagedList<GridPayload>({
    list: 'roleCandidates',
    base: `/roles/${encodeURIComponent(props.roleId)}/candidates/grid`,
    extra: sortToParams(props.sort),
    failureMessage: 'Could not load the skills grid.',
  });
  const competencies = paged.data?.competencies ?? [];
  const rows = paged.data?.rows ?? [];

  if (paged.loading) return <p className="muted small">Loading the skills grid…</p>;
  if (paged.error) return <Banner kind="error">{paged.error}</Banner>;
  if (!competencies.length) {
    return (
      <EmptyState
        compact
        icon="scorecard"
        title="This role has no scored competencies"
        message="Add competencies to the scorecard and the grid will compare candidates against them."
      />
    );
  }
  if (!rows.length) {
    return (
      <EmptyState
        compact
        icon="candidates"
        title="No candidates on this role yet"
        message="The grid fills in as candidates are interviewed and assessed."
      />
    );
  }

  return (
    <div>
      <p className="muted small cmp-legend">
        Levels run 1 to {LEVEL_MAX}. A bolder numeral with a rule under it is at or above what this role asks for;
        a lighter one is below it. A competency the interview produced nothing for says so in words, never as a zero.
      </p>

      {isPhone ? <PhoneGrid rows={rows} competencies={competencies} /> : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Skills across candidates">
          <table className="cmp-grid">
            <thead>
              <tr>
                <th className="cmp-rowhead">Candidate</th>
                {competencies.map((c) => (
                  <th key={c.id} scope="col" title={`${c.name} — level ${c.requiredLevel} asked for`}>
                    <span className="cmp-col-name">{c.name}</span>
                    <span className="muted small cmp-col-need">needs {c.requiredLevel}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (row.blindReviewPending
                ? <WithheldRow key={row.candidateId} row={row} span={competencies.length} />
                : (
                  <tr key={row.candidateId} data-testid="skills-grid-row">
                    <RowHead row={row} />
                    {competencies.map((c) => (
                      <Cell key={c.id} cell={row.cells[c.id] ?? { kind: 'not_assessed' }} competency={c} />
                    ))}
                  </tr>
                )))}
            </tbody>
          </table>
        </div>
      )}

      {paged.data?.meta && (
        <ListPager
          meta={paged.data.meta}
          pageSize={paged.pageSize}
          noun="candidate"
          label="Skills grid"
          onPage={paged.setPage}
          onPageSize={paged.setPageSize}
        />
      )}
    </div>
  );
}
