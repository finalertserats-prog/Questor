/**
 * The catalog's source attributions, shown on the Roles page, the About page
 * and the review page. Kept as data so a test holds it to the server's copy:
 * the O*NET wording is required by its licence and must not drift.
 */
export interface CatalogAttribution {
  readonly name: string;
  readonly text: string;
  readonly url: string;
  readonly linkText: string;
}

export const CATALOG_ATTRIBUTIONS: readonly CatalogAttribution[] = [
  {
    name: 'O*NET',
    text: 'This site incorporates information from O*NET 31.0 Database by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA). Used under the CC BY 4.0 license. O*NET® is a trademark of USDOL/ETA.',
    url: 'https://creativecommons.org/licenses/by/4.0/',
    linkText: 'CC BY 4.0 license',
  },
  {
    name: 'ESCO',
    text: 'Occupation data from ESCO, © European Union.',
    url: 'https://esco.ec.europa.eu/',
    linkText: 'esco.ec.europa.eu',
  },
];
