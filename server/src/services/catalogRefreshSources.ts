import { config } from '../config.js';
import type { CatalogCandidate } from '../domain/catalogMatch.js';
import { loadOnetOccupations } from './catalogSources/onet.js';
import { fetchEscoPage, lookupEscoOccupation, type EscoPage } from './catalogSources/esco.js';
import { researchEmergingTitles } from './catalogSources/webResearch.js';
import type { SourceHttp } from './catalogSources/http.js';
import { processCandidates, type ChunkModel, type RunState } from './catalogRefreshChunk.js';
import type { RunContext } from './catalogRefreshContext.js';
import { addSourceError, setSkippedReason, type SourceKey } from './catalogRefreshState.js';

/**
 * Each source, walked in bounded chunks. After every chunk the caller's
 * `checkpoint` saves the cursor and stats, so a restart resumes at the next
 * chunk. A source that fails is recorded and marked done for this run; the
 * other sources still run.
 */

export const ESCO_LOOKUPS_PER_CHUNK = 10;

export interface SourceRunner {
  readonly ctx: RunContext;
  readonly http: SourceHttp;
  readonly model: ChunkModel;
  readonly onetChunkSize: number;
  readonly research: { readonly apiKey: string; readonly demo: boolean };
  /** Persist progress; throws if the run must stop (lease lost, test crash). */
  readonly checkpoint: (state: RunState, source: SourceKey) => Promise<void>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runOnet(runner: SourceRunner, start: RunState): Promise<RunState> {
  let state = start;
  let occupations: CatalogCandidate[];
  try {
    occupations = await loadOnetOccupations(runner.http, config.catalogRefresh.onetBaseUrl);
  } catch (err) {
    state = { ...state, stats: addSourceError(state.stats, 'onet', messageOf(err)), cursor: { ...state.cursor, onet: { ...state.cursor.onet, done: true } } };
    await runner.checkpoint(state, 'onet');
    return state;
  }
  while (state.cursor.onet.offset < occupations.length) {
    const offset = state.cursor.onet.offset;
    const chunk = occupations.slice(offset, offset + runner.onetChunkSize);
    state = await processCandidates(runner.ctx, state, 'onet', chunk, runner.model);
    state = { ...state, cursor: { ...state.cursor, onet: { offset: offset + chunk.length, done: false } } };
    await runner.checkpoint(state, 'onet');
  }
  state = { ...state, cursor: { ...state.cursor, onet: { ...state.cursor.onet, done: true } } };
  await runner.checkpoint(state, 'onet');
  return state;
}

async function applyEscoPage(runner: SourceRunner, state: RunState, page: EscoPage): Promise<RunState> {
  const { page: current, pages } = state.cursor.esco;
  const processed = await processCandidates(runner.ctx, state, 'esco', page.candidates, runner.model);
  const withErrors = page.errors.reduce((acc, message) => ({ ...acc, stats: addSourceError(acc.stats, 'esco', message) }), processed);
  const next = current + 1;
  // Past the end: start again from the top next time, and stop for this run.
  const wrapped = page.candidates.length === 0 || next * config.catalogRefresh.escoLimit >= page.total;
  const reachedCap = pages + 1 >= config.catalogRefresh.escoPagesPerRun;
  return { ...withErrors, cursor: { ...withErrors.cursor, esco: { page: wrapped ? 0 : next, pages: pages + 1, done: wrapped || reachedCap } } };
}

async function runEscoPages(runner: SourceRunner, start: RunState): Promise<RunState> {
  let state = start;
  const { escoBaseUrl, escoLimit, escoDelayMs } = config.catalogRefresh;
  while (!state.cursor.esco.done) {
    let page: EscoPage;
    try {
      page = await fetchEscoPage(runner.http, { baseUrl: escoBaseUrl, page: state.cursor.esco.page, limit: escoLimit, delayMs: escoDelayMs });
    } catch (err) {
      state = { ...state, stats: addSourceError(state.stats, 'esco', messageOf(err)), cursor: { ...state.cursor, esco: { ...state.cursor.esco, done: true } } };
      await runner.checkpoint(state, 'esco');
      return state;
    }
    state = await applyEscoPage(runner, state, page);
    await runner.checkpoint(state, 'esco');
  }
  return state;
}

async function escoLookupStep(runner: SourceRunner, state: RunState): Promise<RunState> {
  const roles = runner.ctx.rolesById;
  const { offset, lookups } = state.cursor.escoRoles;
  const room = Math.min(ESCO_LOOKUPS_PER_CHUNK, config.catalogRefresh.escoRoleLookupsPerRun - lookups);
  const batch = roles.slice(offset, offset + room);
  let current = state;
  const found: CatalogCandidate[] = [];
  for (const role of batch) {
    try {
      const hit = await lookupEscoOccupation(runner.http, { baseUrl: config.catalogRefresh.escoBaseUrl, title: role.title, delayMs: config.catalogRefresh.escoDelayMs });
      if (hit) found.push(hit);
    } catch (err) {
      current = { ...current, stats: addSourceError(current.stats, 'esco', `${role.title}: ${messageOf(err)}`) };
    }
  }
  const processed = await processCandidates(runner.ctx, current, 'esco', found, runner.model, { aliasesOnly: true });
  const next = offset + batch.length;
  const wrapped = next >= roles.length;
  const done = wrapped || lookups + batch.length >= config.catalogRefresh.escoRoleLookupsPerRun || batch.length === 0;
  return { ...processed, cursor: { ...processed.cursor, escoRoles: { offset: wrapped ? 0 : next, lookups: lookups + batch.length, done } } };
}

async function runEscoLookups(runner: SourceRunner, start: RunState): Promise<RunState> {
  let state = start;
  while (!state.cursor.escoRoles.done) {
    state = await escoLookupStep(runner, state);
    await runner.checkpoint(state, 'esco');
  }
  return state;
}

function existingTitlesFor(ctx: RunContext, domainId: string): string[] {
  return ctx.rolesById.filter((role) => role.domainId === domainId).flatMap((role) => [role.title, ...role.aliases]);
}

async function webStep(runner: SourceRunner, state: RunState): Promise<RunState> {
  const { domainIndex, calls } = state.cursor.web;
  const domain = runner.ctx.domains[domainIndex];
  // A resumed run may find fewer active domains than when it stopped, and the
  // research budget (per run and over 30 days) may already be spent.
  if (!domain || state.researchCalls >= runner.ctx.limits.researchCalls) return { ...state, cursor: { ...state.cursor, web: { ...state.cursor.web, done: true } } };
  const result = await researchEmergingTitles(runner.http, {
    apiKey: runner.research.apiKey, demo: runner.research.demo, model: config.catalogRefresh.researchModel, timeoutMs: config.catalogRefresh.researchTimeoutMs,
    domainId: domain.id, domainName: domain.name, existingTitles: existingTitlesFor(runner.ctx, domain.id),
  });
  const counted = { ...state, researchCalls: state.researchCalls + (result.called ? 1 : 0) };
  const cursorAfter = { domainIndex: domainIndex + 1, calls: calls + (result.called ? 1 : 0) };
  if (!result.called) {
    // No key or a demo: the same for every domain, so the source stops here.
    return { ...counted, stats: setSkippedReason(counted.stats, 'web', result.skipped ?? 'skipped'), cursor: { ...counted.cursor, web: { ...cursorAfter, done: true } } };
  }
  const withError = result.skipped ? { ...counted, stats: addSourceError(counted.stats, 'web', `${domain.name}: ${result.skipped}`) } : counted;
  const processed = await processCandidates(runner.ctx, withError, 'web', result.candidates, runner.model);
  const done = cursorAfter.domainIndex >= runner.ctx.domains.length || processed.researchCalls >= runner.ctx.limits.researchCalls;
  return { ...processed, cursor: { ...processed.cursor, web: { ...cursorAfter, done } } };
}

async function runWeb(runner: SourceRunner, start: RunState): Promise<RunState> {
  let state = start;
  if (runner.ctx.domains.length === 0) return { ...state, cursor: { ...state.cursor, web: { ...state.cursor.web, done: true } } };
  // researchEmergingTitles reports its own failures; anything thrown here is
  // the database, which should fail (and later resume) the run.
  while (!state.cursor.web.done) {
    state = await webStep(runner, state);
    await runner.checkpoint(state, 'web');
  }
  return state;
}

/** O*NET, then ESCO pages, then ESCO lookups of existing titles, then web research. */
export async function runAllSources(runner: SourceRunner, start: RunState): Promise<RunState> {
  let state = start;
  if (!state.cursor.onet.done) state = await runOnet(runner, state);
  if (!state.cursor.esco.done) state = await runEscoPages(runner, state);
  if (!state.cursor.escoRoles.done) state = await runEscoLookups(runner, state);
  if (!state.cursor.web.done) state = await runWeb(runner, state);
  return state;
}

