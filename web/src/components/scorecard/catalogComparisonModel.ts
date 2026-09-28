/**
 * This advert beside the catalog's version of the same role.
 *
 * The server answers GET /roles/:id/validate with competency *keys* —
 * lower-cased names like "sql & data warehousing" — because that is what it
 * compares on. Read out loud to a person they look like a bug, so they are
 * put back into title case here, with the handful of acronyms that would
 * otherwise read as words ("Sql", "Etl") kept upper.
 *
 * Kept free of React so it can be unit tested (web/tests/catalogComparison.test.ts).
 */

export interface CatalogComparison {
  readonly roleProfileId: string;
  /** What the catalog's version of this role usually asks for. */
  readonly usual: readonly string[];
  /** Asked for here and usual for the role. */
  readonly shared: readonly string[];
  /** Asked for here and not usual — often right, always worth seeing. */
  readonly added: readonly string[];
  /** Usual for the role and absent here. */
  readonly omitted: readonly string[];
  /** Of those, the ones whose absence is worth interrupting someone about. */
  readonly missingCore: readonly string[];
}

/**
 * Words a title-caser would otherwise ruin. Deliberately short: a name this
 * list does not know is merely capitalised, which is never wrong, only plain.
 */
const ACRONYMS: ReadonlySet<string> = new Set([
  'ai', 'api', 'apis', 'aws', 'bi', 'ci', 'cd', 'crm', 'css', 'dba', 'elt', 'erp', 'etl',
  'gcp', 'hr', 'html', 'kpi', 'kpis', 'llm', 'ml', 'nlp', 'olap', 'oltp', 'qa', 'saas',
  'seo', 'sql', 'sre', 'ui', 'ux',
]);

// A word, with dotted names ("node.js") held together so only their first
// letter is touched.
const WORD = /[A-Za-z][A-Za-z0-9+#]*(?:\.[A-Za-z0-9+#]+)*/g;

/** A competency key as a person should read it: "sql & data warehousing" -> "SQL & Data Warehousing". */
export function competencyKeyLabel(key: string): string {
  const clean = key.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.replace(WORD, (word) => (
    ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)
  ));
}

/** The keys that are missing but not core, so the core ones can be said once and given the room. */
export function omittedBeyondCore(comparison: CatalogComparison): string[] {
  const core = new Set(comparison.missingCore);
  return comparison.omitted.filter((key) => !core.has(key));
}

/**
 * True when the comparison has nothing a reader could act on. A role the
 * catalog does not recognise comes back with empty lists, and an empty panel
 * headed "compared with the catalog" says only that something failed.
 */
export function isComparisonEmpty(comparison: CatalogComparison | null | undefined): boolean {
  if (!comparison) return true;
  return comparison.usual.length === 0 && comparison.added.length === 0 && comparison.omitted.length === 0;
}

/**
 * The one-line reading, stated as a count rather than a verdict: the catalog
 * is a reference and this panel is not allowed to sound like a grade.
 */
export function sharedSummary(comparison: CatalogComparison): string {
  const usual = comparison.usual.length;
  if (usual === 0) return 'The catalog does not list a usual set of competencies for this role.';
  const shared = comparison.shared.length;
  const one = usual === 1;
  return `This scorecard has ${shared} of the ${usual} ${one ? 'competency' : 'competencies'} the catalog usually lists for this role.`;
}
