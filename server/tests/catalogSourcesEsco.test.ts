import { describe, expect, it } from 'vitest';
import { fetchEscoPage, lookupEscoOccupation } from '../src/services/catalogSources/esco.js';
import type { SourceHttp } from '../src/services/catalogSources/http.js';

const BASE = 'https://esco.example/api';
const ANIMATOR = 'http://data.europa.eu/esco/occupation/52df9d56';
const WELDER = 'http://data.europa.eu/esco/occupation/aa11';

function searchBody(uris: readonly [string, string][], total = 2942) {
  // Shape of the live search reply (2026-09-19), _links included.
  const links = { self: { href: `${BASE}/search?text=&type=occupation&limit=25&offset=0&language=en` }, next: { href: `${BASE}/search?text=&type=occupation&limit=25&offset=1&language=en` } };
  return JSON.stringify({ total, offset: 0, limit: 25, text: '', language: 'en', _links: links, _embedded: { results: uris.map(([uri, title]) => ({ uri, title, preferredLabel: { en: title, de: 'x' } })) } });
}

// Shape verified against the live API on 2026-09-19 (resource/occupation).
function detailBody(title: string, alternatives: readonly string[], description: string) {
  return JSON.stringify({
    title,
    preferredLabel: { en: title },
    alternativeLabel: { en: alternatives, de: ['Animator'] },
    description: { en: { literal: description, mimetype: 'plain/text' } },
  });
}

function fakeHttp(routes: (url: URL) => Response) {
  const requested: URL[] = [];
  const sleeps: number[] = [];
  const http: SourceHttp = {
    fetch: async (url) => {
      const parsed = new URL(String(url));
      requested.push(parsed);
      return routes(parsed);
    },
    sleep: async (ms) => { sleeps.push(ms); },
    timeoutMs: 1_000,
  };
  return { http, requested, sleeps };
}

function standardRoutes(url: URL): Response {
  if (url.pathname.endsWith('/search')) return new Response(searchBody([[ANIMATOR, '3D animator'], [WELDER, 'welder']]));
  if (url.searchParams.get('uri') === ANIMATOR) return new Response(detailBody('3D animator', ['CGI animator', '3D designer'], '3D animators animate models. They build scenes. They render.'));
  return new Response(detailBody('welder', [], 'Welders join metal.'));
}

describe('paging ESCO occupations', () => {
  it('asks the search endpoint for one page of English occupations, by page number', async () => {
    // The live API's offset is a page index: limit=2&offset=0 links next to offset=1.
    const { http, requested } = fakeHttp(standardRoutes);
    await fetchEscoPage(http, { baseUrl: BASE, page: 2, limit: 25, delayMs: 10 });
    expect(Object.fromEntries(requested[0].searchParams)).toEqual({ type: 'occupation', language: 'en', text: '', limit: '25', offset: '2' });
  });

  it('reads English alternative labels and description from each occupation resource', async () => {
    const { http } = fakeHttp(standardRoutes);
    const page = await fetchEscoPage(http, { baseUrl: BASE, page: 0, limit: 25, delayMs: 10 });
    expect(page.candidates[0]).toMatchObject({ title: '3D animator', alternateTitles: ['CGI animator', '3D designer'], description: '3D animators animate models. They build scenes. They render.', source: 'esco', ref: ANIMATOR });
  });

  it('links to the occupation over https', async () => {
    const { http } = fakeHttp(standardRoutes);
    const page = await fetchEscoPage(http, { baseUrl: BASE, page: 0, limit: 25, delayMs: 10 });
    expect(page.candidates[0].url).toBe('https://data.europa.eu/esco/occupation/52df9d56');
  });

  it('reports the total so the cursor can wrap', async () => {
    const { http } = fakeHttp(standardRoutes);
    expect((await fetchEscoPage(http, { baseUrl: BASE, page: 0, limit: 25, delayMs: 10 })).total).toBe(2942);
  });

  it('pauses between requests, one request at a time', async () => {
    const { http, sleeps } = fakeHttp(standardRoutes);
    await fetchEscoPage(http, { baseUrl: BASE, page: 0, limit: 25, delayMs: 10 });
    expect(sleeps).toEqual([10, 10]);
  });

  it('keeps an occupation whose details failed, without alternates, and records why', async () => {
    const { http } = fakeHttp((url) => (url.searchParams.get('uri') === WELDER ? new Response('', { status: 404 }) : standardRoutes(url)));
    const page = await fetchEscoPage(http, { baseUrl: BASE, page: 0, limit: 25, delayMs: 10 });
    expect({ welder: page.candidates[1].alternateTitles, errors: page.errors.length }).toEqual({ welder: [], errors: 1 });
  });

  it('fails the page when the search itself fails', async () => {
    const { http } = fakeHttp(() => new Response('', { status: 400 }));
    await expect(fetchEscoPage(http, { baseUrl: BASE, page: 0, limit: 25, delayMs: 10 })).rejects.toThrow(/400/);
  });

  it('treats an unexpected search body as an empty page', async () => {
    const { http } = fakeHttp(() => new Response(JSON.stringify({ surprise: true })));
    expect(await fetchEscoPage(http, { baseUrl: BASE, page: 0, limit: 25, delayMs: 10 })).toEqual({ candidates: [], total: 0, errors: [] });
  });

  it('ignores alternative labels that are not strings', async () => {
    const { http } = fakeHttp((url) => (url.pathname.endsWith('/search')
      ? new Response(searchBody([[ANIMATOR, '3D animator']]))
      : new Response(JSON.stringify({ alternativeLabel: { en: ['CGI animator', 7, null] } }))));
    const page = await fetchEscoPage(http, { baseUrl: BASE, page: 0, limit: 25, delayMs: 10 });
    expect(page.candidates[0].alternateTitles).toEqual(['CGI animator']);
  });
});

describe('looking up an existing catalog title in ESCO', () => {
  it('searches by the title and returns the top occupation with its labels', async () => {
    const { http, requested } = fakeHttp(standardRoutes);
    const found = await lookupEscoOccupation(http, { baseUrl: BASE, title: 'Animator & 3D', delayMs: 10 });
    expect({ text: requested[0].searchParams.get('text'), limit: requested[0].searchParams.get('limit'), title: found?.title }).toEqual({ text: 'Animator & 3D', limit: '1', title: '3D animator' });
  });

  it('returns null when ESCO has no occupation for the title', async () => {
    const { http } = fakeHttp(() => new Response(searchBody([], 0)));
    expect(await lookupEscoOccupation(http, { baseUrl: BASE, title: 'Prompt Whisperer', delayMs: 10 })).toBeNull();
  });
});
