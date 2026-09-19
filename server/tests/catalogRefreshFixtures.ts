import { prisma } from '../src/db.js';
import { config } from '../src/config.js';
import { normalizeTitle } from '../src/domain/catalogText.js';
import type { SourceHttp } from '../src/services/catalogSources/http.js';
import type { CatalogRefreshDeps } from '../src/services/catalogRefresh.js';

/**
 * A small catalog and scripted outside sources for the refresh tests. No test
 * reaches the network: every request is answered here, by URL.
 */

export const ONET_BASE = 'https://onet.test/db_31_0_csv';
export const ESCO_BASE = 'https://esco.test/api';

export interface SeededCatalog {
  readonly techId: string;
  readonly healthId: string;
  readonly engFamilyId: string;
  readonly careFamilyId: string;
  readonly sweId: string;
  readonly dsId: string;
  readonly nurseId: string;
}

export async function clearCatalogRefreshData(): Promise<void> {
  await prisma.catalogProposal.deleteMany();
  await prisma.catalogRefreshRun.deleteMany();
  await prisma.catalogJdDraft.deleteMany();
  await prisma.role.deleteMany();
  await prisma.catalogRoleAlias.deleteMany();
  await prisma.catalogRole.deleteMany();
  await prisma.catalogDomain.deleteMany();
  await prisma.catalogJobFamily.deleteMany();
  await prisma.jobLease.deleteMany();
  await prisma.jobRun.deleteMany();
}

async function catalogRole(domainId: string, familyId: string, title: string, aliases: readonly string[] = []) {
  return prisma.catalogRole.create({
    data: {
      domainId, familyId, title, normalizedTitle: normalizeTitle(title), source: 'seed',
      aliases: { create: aliases.map((alias) => ({ alias, normalizedAlias: normalizeTitle(alias), source: 'seed' })) },
    },
  });
}

export async function seedSmallCatalog(): Promise<SeededCatalog> {
  await clearCatalogRefreshData();
  const eng = await prisma.catalogJobFamily.create({ data: { name: 'Engineering', sortOrder: 1 } });
  const care = await prisma.catalogJobFamily.create({ data: { name: 'Care', sortOrder: 2 } });
  const tech = await prisma.catalogDomain.create({ data: { slug: 'tech', name: 'Technology', sortOrder: 1 } });
  const health = await prisma.catalogDomain.create({ data: { slug: 'health', name: 'Healthcare', sortOrder: 2 } });
  const swe = await catalogRole(tech.id, eng.id, 'Software Engineer', ['Developer']);
  const ds = await catalogRole(tech.id, eng.id, 'Data Scientist');
  const nurse = await catalogRole(health.id, care.id, 'Registered Nurse');
  return { techId: tech.id, healthId: health.id, engFamilyId: eng.id, careFamilyId: care.id, sweId: swe.id, dsId: ds.id, nurseId: nurse.id };
}

export interface OnetOccupation {
  readonly code: string;
  readonly title: string;
  readonly description?: string;
  readonly reported?: readonly string[];
  readonly lay?: readonly string[];
}

export const DEFAULT_ONET: readonly OnetOccupation[] = [
  { code: '15-1252.00', title: 'Software Developers', description: 'Design software. Test it. Ship it.', reported: ['Software Engineer', 'Application Developer'], lay: ['Code Writer'] },
  { code: '45-2092.00', title: 'Farmworkers', description: 'Plant and harvest crops.' },
  { code: '15-1253.00', title: 'Software Quality Engineer', description: 'Test software before release. Report defects.' },
];

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function onetFiles(occupations: readonly OnetOccupation[]): Record<string, string> {
  const rows = (header: string, lines: string[][]) => [header, ...lines.map((line) => line.map(csvCell).join(','))].join('\n');
  return {
    'occupation_data.csv': rows('O*NET-SOC Code,Title,Description', occupations.map((o) => [o.code, o.title, o.description ?? ''])),
    'sample_of_reported_titles.csv': rows('O*NET-SOC Code,Title,Reported Job Title,Shown in My Next Move', occupations.flatMap((o) => (o.reported ?? []).map((r) => [o.code, o.title, r, 'Y']))),
    'job_titles.csv': rows('O*NET-SOC Code,Title,Job Title,Short Title,Source(s)', occupations.flatMap((o) => (o.lay ?? []).map((l) => [o.code, o.title, l, '', '08']))),
  };
}

export interface EscoOccupation {
  readonly uri: string;
  readonly title: string;
  readonly alternatives?: readonly string[];
  readonly description?: string;
}

export interface FakeSources {
  onet?: readonly OnetOccupation[];
  onetStatus?: number;
  esco?: readonly EscoOccupation[];
  escoStatus?: number;
  /** Text of the OpenAI Responses reply, or a status to fail with. */
  research?: string | number;
}

function escoResponse(url: URL, sources: FakeSources): Response {
  if (sources.escoStatus) return new Response('', { status: sources.escoStatus });
  const all = sources.esco ?? [];
  if (url.pathname.endsWith('/search')) {
    const text = (url.searchParams.get('text') ?? '').toLowerCase();
    // As the live API does (checked 2026-09-19): offset is a PAGE index, and
    // _links.next points at offset + 1 whatever the page size.
    const page = Number(url.searchParams.get('offset'));
    const limit = Number(url.searchParams.get('limit'));
    const hits = text ? all.filter((o) => o.title.toLowerCase() === text || (o.alternatives ?? []).some((a) => a.toLowerCase() === text)) : all;
    const next = new URL(url.toString());
    next.searchParams.set('offset', String(page + 1));
    return Response.json({
      total: hits.length, offset: page, limit,
      _links: { self: { href: url.toString() }, next: { href: next.toString() } },
      _embedded: { results: hits.slice(page * limit, page * limit + limit).map((o) => ({ uri: o.uri, title: o.title })) },
    });
  }
  const found = all.find((o) => o.uri === url.searchParams.get('uri'));
  if (!found) return new Response('', { status: 404 });
  return Response.json({ title: found.title, alternativeLabel: { en: found.alternatives ?? [] }, description: { en: { literal: found.description ?? '' } } });
}

/**
 * The web_search tool's url_citation annotations for a scripted reply: each
 * item's evidenceUrls, cited at the item's title, as the tool would.
 */
function citationsFor(text: string) {
  let items: unknown;
  try { items = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(items)) return [];
  return items.flatMap((item: { title?: string; evidenceUrls?: string[] }) => {
    const at = item.title ? text.indexOf(item.title) : -1;
    return at < 0 ? [] : (item.evidenceUrls ?? []).map((url) => ({ type: 'url_citation', url, start_index: at, end_index: at + 3 }));
  });
}

export function fakeSourceHttp(sources: FakeSources) {
  const requests: string[] = [];
  const files = onetFiles(sources.onet ?? DEFAULT_ONET);
  const http: SourceHttp = {
    fetch: async (input) => {
      const url = new URL(String(input));
      requests.push(url.toString());
      if (url.toString().startsWith(ONET_BASE)) {
        if (sources.onetStatus) return new Response('', { status: sources.onetStatus });
        return new Response(files[url.pathname.split('/').pop() ?? ''] ?? '', { status: 200 });
      }
      if (url.toString().startsWith(ESCO_BASE)) return escoResponse(url, sources);
      if (url.hostname === 'api.openai.com') {
        if (typeof sources.research === 'number') return new Response('', { status: sources.research });
        const text = sources.research ?? '[]';
        return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text, annotations: citationsFor(text) }] }] });
      }
      throw new Error(`unexpected request in test: ${url.toString()}`);
    },
    sleep: async () => undefined,
    timeoutMs: 1_000,
  };
  return { http, requests };
}

/** Test settings: small caps, local base URLs, no key unless a test sets one. */
export function configureCatalogRefresh(overrides: Partial<typeof config.catalogRefresh> = {}): void {
  Object.assign(config.catalogRefresh, {
    onetBaseUrl: ONET_BASE,
    escoBaseUrl: ESCO_BASE,
    maxLlmCalls: 10,
    maxProposals: 200,
    maxAliasShare: 0.6,
    llmCallsPer30Days: 1000,
    researchCallsPer30Days: 1000,
    manualRunGapMs: 0,
    minConfidence: 0.5,
    researchMaxCalls: 5,
    escoLimit: 25,
    escoPagesPerRun: 2,
    escoRoleLookupsPerRun: 10,
    escoDelayMs: 0,
    ...overrides,
  });
  config.llm.openaiKey = '';
}

export function testDeps(sources: FakeSources, overrides: Partial<CatalogRefreshDeps> = {}) {
  const fake = fakeSourceHttp(sources);
  const deps: Partial<CatalogRefreshDeps> = { http: fake.http, model: async () => null, modelAvailable: false, demo: false, ...overrides };
  return { deps, requests: fake.requests };
}

export async function proposalTitles(): Promise<string[]> {
  const rows = await prisma.catalogProposal.findMany({ orderBy: { title: 'asc' }, select: { title: true } });
  return rows.map((row) => row.title);
}
