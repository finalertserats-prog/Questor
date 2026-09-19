import { z } from 'zod';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { normalizeTitle } from '../domain/catalogText.js';
import type { CatalogIndex } from '../domain/catalogMatch.js';
import { tokenOverlapClassification, validateModelClassifications, type AllowedClassificationIds, type Classification } from '../domain/catalogClassification.js';
import { generateJson, getLlm } from '../providers/llm/index.js';
import { inDemoContext } from './demoPolicy.js';

/** Titles per model call: small enough to answer reliably, large enough to stay under the call cap. */
export const CLASSIFY_BATCH_SIZE = 25;

export interface ClassificationRequest {
  readonly titles: readonly { readonly title: string; readonly description?: string }[];
  readonly domains: readonly { readonly id: string; readonly name: string; readonly families: readonly { readonly id: string; readonly name: string }[] }[];
}

/** Returns the model's raw answer, or null when no model is available. */
export type ClassificationModel = (request: ClassificationRequest) => Promise<unknown>;

export interface ClassifiedTitle extends Classification {
  readonly method: 'model' | 'overlap';
}

export interface ClassifyOptions {
  readonly index: CatalogIndex;
  readonly allowed: AllowedClassificationIds;
  readonly model: ClassificationModel;
  /** Model calls still allowed in this run. */
  readonly maxCalls: number;
  /** False without a key or in a demo: nothing is called and nothing counted. */
  readonly modelAvailable?: boolean;
  readonly names?: { readonly domains: ReadonlyMap<string, string>; readonly families: ReadonlyMap<string, string> };
}

const replySchema = z.array(z.unknown());

const SYSTEM_PROMPT = [
  'You classify job titles into a fixed catalog of domains and job families.',
  'Use ONLY the domain ids and family ids given. A family must be one listed under the chosen domain.',
  'If no domain fits, use null for domainId. confidence is 0 to 1: how sure you are the domain fits.',
  'Reply with a JSON array: [{"title":"...","domainId":"...","familyId":"..."|null,"confidence":0.0}].',
].join(' ');

/** The production model: the configured LLM, or null in a demo or without a key. */
export const defaultClassificationModel: ClassificationModel = (request) => generateJson({
  fn: 'catalog_refresh_classify',
  system: SYSTEM_PROMPT,
  user: JSON.stringify(request),
  validate: (raw) => replySchema.parse(raw),
  maxTokens: 3000,
  temperature: 0,
  // A background job's model call must end; a hung one would hold the run.
  timeoutMs: config.catalogRefresh.classifyTimeoutMs,
});

/** Whether the default model would actually be called (generateJson returns null otherwise). */
export function defaultModelAvailable(): boolean {
  return getLlm().enabled && !inDemoContext();
}

function requestDomains(opts: ClassifyOptions): ClassificationRequest['domains'] {
  return [...opts.allowed.domainIds].map((id) => ({
    id,
    name: opts.names?.domains.get(id) ?? id,
    families: [...(opts.allowed.familiesByDomain.get(id) ?? [])].map((familyId) => ({ id: familyId, name: opts.names?.families.get(familyId) ?? familyId })),
  }));
}

async function askModel(batch: ClassificationRequest['titles'], opts: ClassifyOptions): Promise<Map<string, Classification>> {
  try {
    const raw = await opts.model({ titles: batch, domains: requestDomains(opts) });
    return validateModelClassifications(raw, opts.allowed);
  } catch (err) {
    // A classification is advisory: the owner reviews every proposal, so a
    // provider outage costs precision, never the run.
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Catalog classification call failed; using token overlap');
    return new Map();
  }
}

/**
 * Classify titles in batches, with the model while the call budget lasts and
 * token overlap for everything the model could not (or did not validly) place.
 */
export async function classifyTitles(
  titles: readonly { readonly title: string; readonly description?: string }[],
  opts: ClassifyOptions,
): Promise<{ readonly byTitle: ReadonlyMap<string, ClassifiedTitle>; readonly modelCalls: number }> {
  const byTitle = new Map<string, ClassifiedTitle>();
  let modelCalls = 0;
  const canAsk = () => opts.modelAvailable !== false && modelCalls < opts.maxCalls;
  for (let start = 0; start < titles.length; start += CLASSIFY_BATCH_SIZE) {
    const batch = titles.slice(start, start + CLASSIFY_BATCH_SIZE);
    const asking = canAsk();
    const fromModel = asking ? await askModel(batch, opts) : new Map<string, Classification>();
    if (asking) modelCalls += 1;
    for (const item of batch) {
      const key = normalizeTitle(item.title);
      const modelAnswer = fromModel.get(key);
      byTitle.set(key, modelAnswer
        ? { ...modelAnswer, method: 'model' }
        : { ...tokenOverlapClassification(item.title, opts.index.roles), method: 'overlap' });
    }
  }
  return { byTitle, modelCalls };
}
