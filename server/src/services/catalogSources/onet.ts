import type { CatalogCandidate } from '../../domain/catalogMatch.js';
import { csvObjects } from './csv.js';
import { fetchWithRetry, type SourceHttp } from './http.js';

/**
 * O*NET 31.0 (CC BY 4.0), read from the published CSV tables at run time:
 * occupation_data.csv for titles and descriptions, sample_of_reported_titles.csv
 * for titles real workers reported, job_titles.csv for the long list of lay
 * titles. The whole database is a few megabytes, so it is read once per run
 * and processed in chunks by the caller.
 */

const CODE = 'O*NET-SOC Code';

async function fetchTable(http: SourceHttp, baseUrl: string, file: string): Promise<Array<Record<string, string>>> {
  const response = await fetchWithRetry(`${baseUrl.replace(/\/+$/, '')}/${file}`, http);
  return csvObjects(await response.text());
}

function appendTitle(map: Map<string, string[]>, code: string, title: string): void {
  const clean = title.replace(/\s+/g, ' ').trim();
  if (!code || !clean) return;
  map.set(code, [...(map.get(code) ?? []), clean]);
}

/**
 * Alternates in order of trust: reported titles O*NET shows job seekers
 * ("Shown in My Next Move" = Y), other reported titles, then lay titles. The
 * alias cap per occupation keeps the most trusted ones.
 */
function alternatesByCode(reported: Array<Record<string, string>>, layTitles: Array<Record<string, string>>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of reported.filter((r) => r['Shown in My Next Move']?.trim() === 'Y')) appendTitle(out, row[CODE] ?? '', row['Reported Job Title'] ?? '');
  for (const row of reported.filter((r) => r['Shown in My Next Move']?.trim() !== 'Y')) appendTitle(out, row[CODE] ?? '', row['Reported Job Title'] ?? '');
  for (const row of layTitles) appendTitle(out, row[CODE] ?? '', row['Job Title'] ?? '');
  return out;
}

function distinctExcept(titles: readonly string[], exclude: string): string[] {
  const seen = new Set([exclude.toLowerCase()]);
  return titles.filter((title) => {
    const key = title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function loadOnetOccupations(http: SourceHttp, baseUrl: string): Promise<CatalogCandidate[]> {
  // One file at a time: the source is a public service, not ours to hammer.
  const occupations = await fetchTable(http, baseUrl, 'occupation_data.csv');
  const reported = await fetchTable(http, baseUrl, 'sample_of_reported_titles.csv');
  const layTitles = await fetchTable(http, baseUrl, 'job_titles.csv');
  const alternates = alternatesByCode(reported, layTitles);
  return occupations
    .map((row) => ({ code: (row[CODE] ?? '').trim(), title: (row.Title ?? '').trim(), description: (row.Description ?? '').trim() }))
    .filter((row) => row.code && row.title)
    .map((row) => ({
      title: row.title,
      description: row.description || undefined,
      alternateTitles: distinctExcept(alternates.get(row.code) ?? [], row.title),
      ref: row.code,
      url: `https://www.onetonline.org/link/summary/${encodeURIComponent(row.code)}`,
      source: 'onet' as const,
    }));
}
