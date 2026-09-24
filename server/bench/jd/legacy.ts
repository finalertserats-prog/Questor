import type { Competency } from '../../src/domain/types.js';

/**
 * The extractor as it stood before this work, frozen.
 *
 * It is kept — and only kept — so that the "before" number in the report can
 * be re-run by anyone later rather than taken on trust. Nothing in `src`
 * imports it and nothing should.
 *
 * Copied verbatim from `engines/roleIntelligence.ts` at commit 1f41c29: a
 * twelve-entry keyword table matched against the WHOLE advert at once, with no
 * notion of sections, no exclusions and no source span. That last property is
 * why it could read the word "product" inside "partner with analytics and
 * product teams" — a sentence about somebody else's job — and put Product
 * Management on a data engineer's scorecard, where it became something every
 * candidate for the role was measured and scored against.
 */

const LEGACY_TAXONOMY: Array<{ kw: RegExp; name: string; category: Competency['category'] }> = [
  { kw: /\b(sql|postgres|mysql|snowflake|bigquery|redshift)\b/i, name: 'SQL & Data Warehousing', category: 'technical' },
  { kw: /\b(python|pandas|numpy|airflow|dbt|spark|scala|etl|elt|pipeline)\b/i, name: 'Data Engineering & Pipelines', category: 'technical' },
  { kw: /\b(aws|azure|gcp|cloud|kubernetes|docker|terraform)\b/i, name: 'Cloud & Platform Architecture', category: 'technical' },
  { kw: /\b(java|typescript|javascript|node|react|golang|go |c\+\+|api|microservice)\b/i, name: 'Software Engineering', category: 'technical' },
  { kw: /\b(machine learning|ml|ai|model|tensorflow|pytorch|llm|nlp)\b/i, name: 'ML / AI Engineering', category: 'technical' },
  { kw: /\b(product|roadmap|backlog|user stor|prioriti|stakeholder)\b/i, name: 'Product Management', category: 'domain' },
  { kw: /\b(sales|pipeline|quota|crm|salesforce|prospect|closing deals)\b/i, name: 'Sales Execution', category: 'domain' },
  { kw: /\b(marketing|campaign|seo|content|brand|demand gen)\b/i, name: 'Marketing', category: 'domain' },
  { kw: /\b(finance|accounting|budget|forecast|p&l|gaap|financial model)\b/i, name: 'Finance & Analysis', category: 'domain' },
  { kw: /\b(security|compliance|governance|risk|audit|soc 2|iso 27001)\b/i, name: 'Security & Compliance', category: 'domain' },
  { kw: /\b(data model|dimensional|star schema|slowly changing|warehouse design)\b/i, name: 'Data Modeling', category: 'technical' },
  { kw: /\b(observability|monitoring|reliability|sla|slo|incident|on-call)\b/i, name: 'Reliability & Operations', category: 'technical' },
];

/**
 * The names it produced. The four behavioural competencies it also always
 * added are left out, exactly as the baseline competencies are left out of the
 * current measurement, so the two numbers are comparable.
 */
export function legacyPropose(sourceText: string): string[] {
  const text = sourceText.replace(/\r/g, '');
  const found: string[] = [];
  for (const entry of LEGACY_TAXONOMY) {
    if (entry.kw.test(text) && !found.includes(entry.name)) found.push(entry.name);
  }
  // The role-specific fallback for an advert with no technical or domain hit.
  if (found.length === 0) found.push('Role-Specific Expertise');
  return found;
}

/**
 * The legacy classifier: a +/- 60-character window around the first occurrence
 * of the competency's first word. It returned 'essential' both when it matched
 * and when it found nothing, so essentially everything was essential.
 */
export function legacyClassification(name: string, sourceText: string): Competency['classification'] {
  const idx = sourceText.toLowerCase().indexOf(name.toLowerCase().split(' ')[0]);
  const window = idx >= 0 ? sourceText.slice(Math.max(0, idx - 60), idx + 60).toLowerCase() : '';
  if (/\b(preferred|nice to have|bonus|plus|desirable)\b/.test(window)) return 'preferred';
  return 'essential';
}
