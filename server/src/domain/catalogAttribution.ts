/**
 * The attributions the catalog's outside sources require wherever their data
 * is shown. The O*NET wording is prescribed by its CC BY 4.0 terms, so it is
 * kept verbatim; the web app's copy is tested against this one.
 */
export const CATALOG_ATTRIBUTIONS = [
  {
    name: 'O*NET',
    text: 'This site incorporates information from O*NET 31.0 Database by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA). Used under the CC BY 4.0 license. O*NET® is a trademark of USDOL/ETA.',
    url: 'https://creativecommons.org/licenses/by/4.0/',
  },
  {
    name: 'ESCO',
    text: 'Occupation data from ESCO, © European Union.',
    url: 'https://esco.ec.europa.eu/',
  },
] as const;
