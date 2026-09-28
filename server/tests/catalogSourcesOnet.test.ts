import { describe, expect, it } from 'vitest';
import { loadOnetOccupations } from '../src/services/catalogSources/onet.js';
import type { SourceHttp } from '../src/services/catalogSources/http.js';

const BASE = 'https://onet.example/db_31_0_csv';

const FILES: Record<string, string> = {
  'occupation_data.csv': [
    'O*NET-SOC Code,Title,Description',
    '15-1252.00,Software Developers,"Research, design, and develop computer software. Apply principles of computer science."',
    ',Missing Code,No code',
    '',
  ].join('\n'),
  'job_titles.csv': [
    'O*NET-SOC Code,Title,Job Title,Short Title,Source(s)',
    '15-1252.00,Software Developers,Application Developer,,08',
    '15-1252.00,Software Developers,Software Developers,,08',
    '15-1252.00,Software Developers,Computer Programmer (Apps),App Dev,10',
  ].join('\n'),
  'sample_of_reported_titles.csv': [
    'O*NET-SOC Code,Title,Reported Job Title,Shown in My Next Move',
    '15-1252.00,Software Developers,Application Developer,N',
    '15-1252.00,Software Developers,Software Engineer,Y',
  ].join('\n'),
};

function fakeHttp(overrides: Record<string, Response> = {}) {
  const requested: string[] = [];
  const http: SourceHttp = {
    fetch: async (url) => {
      const href = String(url);
      requested.push(href);
      const name = href.slice(BASE.length + 1);
      return overrides[name] ?? new Response(FILES[name] ?? '', { status: FILES[name] ? 200 : 404 });
    },
    sleep: async () => undefined,
    timeoutMs: 1_000,
  };
  return { http, requested };
}

describe('reading O*NET occupations', () => {
  it('reads the three published tables from the configured base URL', async () => {
    const { http, requested } = fakeHttp();
    await loadOnetOccupations(http, `${BASE}/`);
    expect([...requested].sort()).toEqual([`${BASE}/job_titles.csv`, `${BASE}/occupation_data.csv`, `${BASE}/sample_of_reported_titles.csv`]);
  });

  it('returns one candidate per occupation with a code and a title', async () => {
    const { http } = fakeHttp();
    expect((await loadOnetOccupations(http, BASE)).map((c) => c.title)).toEqual(['Software Developers']);
  });

  it('orders alternates: titles shown to job seekers, other reported titles, then lay titles', async () => {
    const { http } = fakeHttp();
    const [occupation] = await loadOnetOccupations(http, BASE);
    expect(occupation.alternateTitles).toEqual(['Software Engineer', 'Application Developer', 'Computer Programmer (Apps)']);
  });

  it('keeps the description, the code as reference and a public link', async () => {
    const { http } = fakeHttp();
    const [occupation] = await loadOnetOccupations(http, BASE);
    expect(occupation).toMatchObject({
      source: 'onet',
      ref: '15-1252.00',
      url: 'https://www.onetonline.org/link/summary/15-1252.00',
      description: 'Research, design, and develop computer software. Apply principles of computer science.',
    });
  });

  it('fails the source when a table cannot be fetched', async () => {
    const { http } = fakeHttp({ 'job_titles.csv': new Response('', { status: 404 }) });
    await expect(loadOnetOccupations(http, BASE)).rejects.toThrow(/404/);
  });
});
