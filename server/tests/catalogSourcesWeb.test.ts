import { describe, expect, it } from 'vitest';
import { researchEmergingTitles, type ResearchOptions } from '../src/services/catalogSources/webResearch.js';
import type { SourceHttp } from '../src/services/catalogSources/http.js';

interface Annotation { type: string; url: string; start_index: number; end_index: number }
interface Item { title?: string; oneLineSummary?: string; evidenceUrls?: string[] }

function responsesBody(text: string, annotations: readonly Annotation[] = []) {
  return JSON.stringify({
    output: [
      { type: 'web_search_call', status: 'completed' },
      { type: 'message', content: [{ type: 'output_text', text, annotations }] },
    ],
  });
}

/**
 * A reply whose items are cited by the web_search tool: each url in
 * `cited[i]` becomes a url_citation annotation inside item i's part of the text.
 */
function citedReply(items: readonly Item[], cited: readonly (readonly string[])[], wrap: (text: string) => string = (t) => t) {
  const text = wrap(JSON.stringify(items));
  const annotations = items.flatMap((item, i) => {
    const at = item.title ? text.indexOf(item.title) : -1;
    return at < 0 ? [] : (cited[i] ?? []).map((url) => ({ type: 'url_citation', url, start_index: at, end_index: at + 3 }));
  });
  return responsesBody(text, annotations);
}

function fakeHttp(respond: () => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const http: SourceHttp = {
    fetch: async (url, init) => { calls.push({ url: String(url), init }); return respond(); },
    sleep: async () => undefined,
    timeoutMs: 1_000,
  };
  return { http, calls };
}

function options(overrides: Partial<ResearchOptions> = {}): ResearchOptions {
  return { apiKey: 'test-key', model: 'gpt-5.5', domainId: 'dom1', domainName: 'Software Engineering', existingTitles: ['Software Engineer', 'Developer'], timeoutMs: 5_000, demo: false, ...overrides };
}

const AGENT = { title: 'Agent Reliability Engineer', oneLineSummary: 'Keeps AI agents dependable in production.' };
const TWO_HOSTS = citedReply([AGENT], [['https://jobs.alpha.test/1', 'https://www.beta.test/2']]);

describe('web research for emerging titles', () => {
  it('skips without an OpenAI key and makes no call', async () => {
    const { http, calls } = fakeHttp(() => new Response(''));
    const result = await researchEmergingTitles(http, options({ apiKey: '' }));
    expect({ skipped: result.skipped, called: result.called, requests: calls.length }).toEqual({ skipped: 'no_openai_key', called: false, requests: 0 });
  });

  it('skips in a demo and makes no call', async () => {
    const { http, calls } = fakeHttp(() => new Response(''));
    const result = await researchEmergingTitles(http, options({ demo: true }));
    expect({ skipped: result.skipped, requests: calls.length }).toEqual({ skipped: 'demo', requests: 0 });
  });

  it('asks the Responses API with web search, the configured model and the key', async () => {
    const { http, calls } = fakeHttp(() => new Response(TWO_HOSTS));
    await researchEmergingTitles(http, options());
    const body = JSON.parse(String(calls[0].init?.body)) as { model: string; tools: unknown[]; input: string };
    expect({
      url: calls[0].url,
      auth: new Headers(calls[0].init?.headers).get('authorization'),
      model: body.model,
      tools: body.tools,
      mentionsDomain: body.input.includes('Software Engineering'),
      excludesKnown: body.input.includes('Developer'),
    }).toEqual({ url: 'https://api.openai.com/v1/responses', auth: 'Bearer test-key', model: 'gpt-5.5', tools: [{ type: 'web_search' }], mentionsDomain: true, excludesKnown: true });
  });

  it('keeps a title the search cited from two distinct hosts', async () => {
    const { http } = fakeHttp(() => new Response(TWO_HOSTS));
    const result = await researchEmergingTitles(http, options());
    expect(result.candidates.map((c) => ({ title: c.title, domainId: c.domainId, source: c.source }))).toEqual([{ title: 'Agent Reliability Engineer', domainId: 'dom1', source: 'web' }]);
  });

  it('drops a title whose citations are all from one host', async () => {
    const { http } = fakeHttp(() => new Response(citedReply([AGENT], [['https://alpha.test/1', 'https://www.alpha.test/2']])));
    expect((await researchEmergingTitles(http, options())).candidates).toEqual([]);
  });

  it('ignores the model\'s own evidence links: only the search tool\'s citations count', async () => {
    const claimed = { ...AGENT, evidenceUrls: ['https://alpha.test/1', 'https://beta.test/2'] };
    const { http } = fakeHttp(() => new Response(citedReply([claimed], [['https://alpha.test/1']])));
    expect((await researchEmergingTitles(http, options())).candidates).toEqual([]);
  });

  it('gives each title only the citations inside its own entry', async () => {
    const items = [{ title: 'Prompt Librarian', oneLineSummary: 'Curates prompts.' }, { title: 'Eval Engineer', oneLineSummary: 'Builds evals.' }];
    const { http } = fakeHttp(() => new Response(citedReply(items, [['https://a.test/1', 'https://b.test/1'], ['https://c.test/1']])));
    expect((await researchEmergingTitles(http, options())).candidates.map((c) => c.title)).toEqual(['Prompt Librarian']);
  });

  it('keeps every cited link for the reviewer', async () => {
    const { http } = fakeHttp(() => new Response(TWO_HOSTS));
    const [candidate] = (await researchEmergingTitles(http, options())).candidates;
    expect(candidate.evidence).toEqual(['https://jobs.alpha.test/1', 'https://www.beta.test/2']);
  });

  it('reads a reply wrapped in a json code fence', async () => {
    const reply = citedReply([AGENT], [['https://a.test/1', 'https://b.test/1']], (t) => ['```json', t, '```'].join('\n'));
    const { http } = fakeHttp(() => new Response(reply));
    expect((await researchEmergingTitles(http, options())).candidates).toHaveLength(1);
  });

  it('drops entries that fail validation and keeps the rest', async () => {
    const items = [{ oneLineSummary: 'no title' }, AGENT];
    const { http } = fakeHttp(() => new Response(citedReply(items, [[], ['https://a.test/1', 'https://b.test/1']])));
    expect((await researchEmergingTitles(http, options())).candidates.map((c) => c.title)).toEqual(['Agent Reliability Engineer']);
  });

  it('ignores a citation that is not a web link', async () => {
    const { http } = fakeHttp(() => new Response(citedReply([AGENT], [['javascript:alert(1)', 'https://a.test/1']])));
    expect((await researchEmergingTitles(http, options())).candidates).toEqual([]);
  });

  it('records an unreadable reply as the skip reason, counting the call', async () => {
    const { http } = fakeHttp(() => new Response(responsesBody('I could not find anything.')));
    const result = await researchEmergingTitles(http, options());
    expect({ skipped: result.skipped, called: result.called }).toEqual({ skipped: 'invalid_reply', called: true });
  });

  it('records a failed request as the skip reason, counting the call', async () => {
    const { http } = fakeHttp(() => new Response('', { status: 401 }));
    const result = await researchEmergingTitles(http, options());
    expect({ skipped: result.skipped?.startsWith('request_failed'), called: result.called }).toEqual({ skipped: true, called: true });
  });

  it('makes exactly one attempt, so every paid call is counted', async () => {
    const { http, calls } = fakeHttp(() => new Response('', { status: 503 }));
    await researchEmergingTitles(http, options());
    expect(calls).toHaveLength(1);
  });

  it('bounds the request with a timeout', async () => {
    const { http, calls } = fakeHttp(() => new Response(TWO_HOSTS));
    await researchEmergingTitles(http, options());
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });
});
