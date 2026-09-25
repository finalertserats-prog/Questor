import { Icon } from '../Icon';
import {
  competencyKeyLabel,
  isComparisonEmpty,
  omittedBeyondCore,
  sharedSummary,
  type CatalogComparison,
} from './catalogComparisonModel';

/**
 * This advert beside the catalog's version of the same role.
 *
 * The failure nobody currently sees is an omission: a scorecard is approved
 * looking complete, and the thing it never asked about is invisible precisely
 * because it is not on the page. So what is missing is said first, and the
 * core omissions are given their own block rather than a line in a list.
 *
 * It is still only information. The catalog describes what most adverts for a
 * role ask for, and a particular job differs from that for good reasons all
 * the time — so nothing here blocks, warns or scores, and the copy is careful
 * not to sound like it does.
 */
export function CatalogComparisonPanel({ comparison }: { readonly comparison: CatalogComparison | null }) {
  // No catalog match means no comparison to draw. An empty panel under this
  // heading would read as "the catalog says you are missing nothing", which is
  // a claim nobody made.
  if (!comparison || isComparisonEmpty(comparison)) return null;
  const c = comparison;
  const alsoOmitted = omittedBeyondCore(c);

  return (
    <section className="card" data-testid="catalog-comparison" aria-labelledby="catalog-comparison-title">
      <h2 className="card-title" id="catalog-comparison-title">
        <Icon name="scale" size={16} />Compared with the catalog
      </h2>
      <p className="muted small">
        What the catalog's version of this role usually asks for, beside what this advert asks for. The catalog is a
        reference, not a rule — a job differs from the usual shape for good reasons all the time.
      </p>

      {c.missingCore.length > 0 && (
        <div className="comp-compare-block is-missing" data-testid="catalog-missing-core">
          <h3 className="comp-compare-h">Core to this role, and not on this scorecard</h3>
          <KeyList keys={c.missingCore} testId="catalog-missing-core-list" />
          <p className="comp-compare-note">
            Almost every version of this role asks for these. If this one should too, add them before approving — an
            interview cannot assess what the scorecard never asked for.
          </p>
        </div>
      )}

      {alsoOmitted.length > 0 && (
        <div className="comp-compare-block" data-testid="catalog-omitted">
          <h3 className="comp-compare-h">Usually asked for, and not here</h3>
          <KeyList keys={alsoOmitted} testId="catalog-omitted-list" />
        </div>
      )}

      {c.added.length > 0 && (
        <div className="comp-compare-block" data-testid="catalog-added">
          <h3 className="comp-compare-h">This advert asks for, and the catalog usually does not</h3>
          <KeyList keys={c.added} testId="catalog-added-list" />
          <p className="comp-compare-note">Specific to this job, as far as the catalog knows. That is normal, and worth having read once.</p>
        </div>
      )}

      <p className="comp-compare-shared" data-testid="catalog-shared">{sharedSummary(c)}</p>
    </section>
  );
}

function KeyList({ keys, testId }: { readonly keys: readonly string[]; readonly testId: string }) {
  return (
    <ul className="comp-compare-list" data-testid={testId}>
      {keys.map((key) => <li key={key}>{competencyKeyLabel(key)}</li>)}
    </ul>
  );
}
