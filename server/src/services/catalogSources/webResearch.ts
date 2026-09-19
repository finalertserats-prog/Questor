import { z } from 'zod';
import type { CatalogCandidate } from '../../domain/catalogMatch.js';
import { parseJsonLoose } from '../../providers/llm/index.js';
import { fetchWithRetry, type SourceHttp } from './http.js';

/**
 * Emerging titles, found by asking a model with web search for titles seen in
 * real job postings. A model can invent a title, so a title is kept only with
 * evidence from at least two different websites, and every link goes to the
 * owner with the proposal.
 */

const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const MIN_DISTINCT_HOSTS = 2;
const MAX_EXCLUDED_TITLES = 300;
// A paid call: one retry for a blip, not a loop.
const RESEARCH_ATTEMPTS = 2;

export interface ResearchOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly domainId: string;
  readonly domainName: string;
  readonly existingTitles: readonly string[];
  readonly timeoutMs: number;
  readonly demo: boolean;
}

export interface ResearchResult {
  readonly candidates: CatalogCandidate[];
  /** Why this domain produced nothing: no key, demo, a failed or unreadable reply. */
  readonly skipped?: string;
  /** Whether a request was sent (and so counts against the research cap). */
  readonly called: boolean;
}

const itemSchema = z.object({
  title: z.string().trim().min(2).max(120),
  oneLineSummary: z.string().trim().max(400).catch(''),
  evidenceUrls: z.array(z.string()).max(20).catch([]),
});

const annotationSchema = z.object({ type: z.string(), url: z.string().optional(), start_index: z.number().optional() }).passthrough();
const contentSchema = z.object({ text: z.string().optional(), annotations: z.array(annotationSchema).catch([]) }).passthrough();
const responseSchema = z.object({
  output: z.array(z.object({ content: z.array(contentSchema).catch([]) }).passthrough()).catch([]),
}).passthrough();

interface Citation {
  readonly url: string;
  readonly at: number;
}

function prompt(opts: ResearchOptions): string {
  const known = opts.existingTitles.slice(0, MAX_EXCLUDED_TITLES).join('; ');
  return [
    `Find job titles in the "${opts.domainName}" field that appeared in real job postings in the last 6 months.`,
    `Leave out these titles we already have: ${known}.`,
    'Only include a title if you found at least two postings or articles on different websites using it.',
    'Reply with only a JSON array: [{"title":"...","oneLineSummary":"one plain sentence a candidate would understand","evidenceUrls":["https://..."]}].',
  ].join(' ');
}

function webUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch { return null; }
}

function hostKey(value: string): string {
  return new URL(value).hostname.replace(/^www\./, '');
}

function readReply(raw: unknown): { text: string; citations: Citation[] } {
  const parsed = responseSchema.safeParse(raw);
  const contents = parsed.success ? parsed.data.output.flatMap((out) => out.content) : [];
  let text = '';
  const citations: Citation[] = [];
  for (const content of contents) {
    for (const note of content.annotations) {
      if (note.type === 'url_citation' && note.url) citations.push({ url: note.url, at: text.length + (note.start_index ?? 0) });
    }
    text += content.text ?? '';
  }
  return { text, citations };
}

/** Citations whose position falls inside this item's part of the reply. */
function citationsFor(text: string, titles: readonly string[], index: number, citations: readonly Citation[]): string[] {
  const start = text.indexOf(titles[index]);
  if (start < 0) return [];
  const nextStarts = titles.slice(index + 1).map((t) => text.indexOf(t, start + 1)).filter((at) => at > start);
  const end = nextStarts.length > 0 ? Math.min(...nextStarts) : text.length;
  return citations.filter((c) => c.at >= start && c.at < end).map((c) => c.url);
}

function toCandidates(items: readonly z.infer<typeof itemSchema>[], text: string, citations: readonly Citation[], domainId: string): CatalogCandidate[] {
  const titles = items.map((item) => item.title);
  return items.flatMap((item, index) => {
    const evidence = [...new Set([...item.evidenceUrls, ...citationsFor(text, titles, index, citations)].map(webUrl).filter((u): u is string => u !== null))];
    if (new Set(evidence.map(hostKey)).size < MIN_DISTINCT_HOSTS) return [];
    return [{ title: item.title, description: item.oneLineSummary || undefined, alternateTitles: [], ref: evidence[0], url: evidence[0], evidence, source: 'web' as const, domainId }];
  });
}

function parseItems(text: string): z.infer<typeof itemSchema>[] | null {
  let value: unknown;
  try { value = parseJsonLoose(text); } catch { return null; }
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    const item = itemSchema.safeParse(entry);
    return item.success ? [item.data] : [];
  });
}

export async function researchEmergingTitles(http: SourceHttp, opts: ResearchOptions): Promise<ResearchResult> {
  if (!opts.apiKey) return { candidates: [], skipped: 'no_openai_key', called: false };
  if (opts.demo) return { candidates: [], skipped: 'demo', called: false };
  let raw: unknown;
  try {
    const response = await fetchWithRetry(RESPONSES_URL, http, {
      attempts: RESEARCH_ATTEMPTS,
      timeoutMs: opts.timeoutMs,
      init: {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: opts.model, tools: [{ type: 'web_search' }], input: prompt(opts) }),
      },
    });
    raw = await response.json();
  } catch (err) {
    return { candidates: [], skipped: `request_failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), called: true };
  }
  const { text, citations } = readReply(raw);
  const items = parseItems(text);
  if (!items) return { candidates: [], skipped: 'invalid_reply', called: true };
  return { candidates: toCandidates(items, text, citations, opts.domainId), called: true };
}
