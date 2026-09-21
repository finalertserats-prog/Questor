/**
 * The rules behind the tech-stack editor and its confirmations, kept free of
 * React so they can be unit tested (web/tests/techStackModel.test.ts). The
 * server holds the same shape (server/src/domain/techStack.ts) and is the
 * one that counts; this copy keeps the page honest as the person types.
 */

export type TechCategory = 'language' | 'framework' | 'platform' | 'data' | 'tooling' | 'other';
export type TechLevel = 'familiar' | 'working' | 'strong' | 'expert';

export interface TechStackItem {
  readonly name: string;
  readonly category: TechCategory;
  readonly level: TechLevel;
  readonly required: boolean;
}

export const TECH_CATEGORIES: readonly TechCategory[] = ['language', 'framework', 'platform', 'data', 'tooling', 'other'];
export const TECH_LEVELS: readonly TechLevel[] = ['familiar', 'working', 'strong', 'expert'];
export const TECH_STACK_MAX_ITEMS = 25;
export const TECH_NAME_MAX_LENGTH = 40;

export const LEVEL_LABEL: Record<TechLevel, string> = { familiar: 'Familiar', working: 'Working', strong: 'Strong', expert: 'Expert' };
export const CATEGORY_LABEL: Record<TechCategory, string> = {
  language: 'Language', framework: 'Framework', platform: 'Platform', data: 'Data', tooling: 'Tooling', other: 'Other',
};

export interface KnownTechnology { readonly name: string; readonly category: TechCategory }

const clean = (s: string) => s.trim().split(/\s+/).join(' ');
const key = (s: string) => clean(s).toLowerCase();

/** Why a typed name cannot be added, or null. */
export function techNameProblem(stack: readonly TechStackItem[], raw: string): string | null {
  const name = clean(raw);
  if (!name) return 'Type a technology first.';
  if (name.length > TECH_NAME_MAX_LENGTH) return `Keep the name under ${TECH_NAME_MAX_LENGTH} characters.`;
  if (stack.some((t) => key(t.name) === key(name))) return `${name} is already on the list.`;
  if (stack.length >= TECH_STACK_MAX_ITEMS) return `A role lists at most ${TECH_STACK_MAX_ITEMS} technologies.`;
  return null;
}

/**
 * The stack with a typed technology added: a known name takes the catalog's
 * spelling and category, anything else is filed under "other". A name that
 * cannot be added leaves the stack as it was.
 */
export function addTechnology(stack: readonly TechStackItem[], raw: string, catalog: readonly KnownTechnology[] = []): TechStackItem[] {
  if (techNameProblem(stack, raw)) return [...stack];
  const name = clean(raw);
  const known = catalog.find((t) => key(t.name) === key(name));
  return [...stack, { name: known?.name ?? name, category: known?.category ?? 'other', level: 'working', required: true }];
}

export function updateTechnology(stack: readonly TechStackItem[], name: string, patch: Partial<Omit<TechStackItem, 'name'>>): TechStackItem[] {
  return stack.map((t) => (t.name === name ? { ...t, ...patch } : t));
}

export function removeTechnology(stack: readonly TechStackItem[], name: string): TechStackItem[] {
  return stack.filter((t) => t.name !== name);
}

/** Detected technologies merged in behind what the person already typed. */
export function mergeDetected(stack: readonly TechStackItem[], detected: readonly TechStackItem[]): TechStackItem[] {
  const have = new Set(stack.map((t) => key(t.name)));
  const fresh = detected.filter((t) => !have.has(key(t.name)));
  return [...stack, ...fresh].slice(0, TECH_STACK_MAX_ITEMS);
}

export const stackNames = (stack: readonly TechStackItem[]): string[] => stack.map((t) => t.name);

/** The catalog names not yet on the stack that begin with what was typed. */
export function suggestionsFor(stack: readonly TechStackItem[], raw: string, catalog: readonly KnownTechnology[], limit = 8): string[] {
  const q = key(raw);
  if (!q) return [];
  const have = new Set(stack.map((t) => key(t.name)));
  return catalog.filter((t) => !have.has(key(t.name)) && key(t.name).startsWith(q)).map((t) => t.name).slice(0, limit);
}

// ---- The job-description confirmation ----------------------------------------

export interface DiffLine { readonly kind: 'kept' | 'removed' | 'added'; readonly text: string }

/** The section before and after as one list: what goes, what comes, what stays. */
export function jdDiffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  const afterSet = new Set(after.map((l) => l.trim()));
  const beforeSet = new Set(before.map((l) => l.trim()));
  return [
    ...before.map((text): DiffLine => ({ kind: afterSet.has(text.trim()) ? 'kept' : 'removed', text })),
    ...after.filter((text) => !beforeSet.has(text.trim())).map((text): DiffLine => ({ kind: 'added', text })),
  ];
}

export function confirmQuestion(kind: 'inserted' | 'replaced' | 'removed' | 'unchanged', count: number): string {
  const n = `${count} ${count === 1 ? 'technology' : 'technologies'}`;
  if (kind === 'removed') return 'Remove the tech-stack section from the job description?';
  if (kind === 'replaced') return `Update the job description with these ${n}?`;
  return `Add a tech-stack section with these ${n} to the job description?`;
}

// ---- Proposed competencies ---------------------------------------------------

export interface StackProposal {
  readonly name: string;
  readonly definition: string;
  readonly category: 'technical';
  readonly classification: 'essential';
  readonly indicators: readonly string[];
  readonly requiredLevel: number;
  readonly targetLevel: number;
  readonly technologies: readonly string[];
}

/** What the page sends to POST /roles/:id/scorecard/competencies for a proposal. */
export function proposalPayload(p: StackProposal) {
  return {
    name: p.name, definition: p.definition, category: p.category, classification: p.classification,
    indicators: [...p.indicators], requiredLevel: p.requiredLevel, targetLevel: p.targetLevel, mustPass: false,
  };
}

export function withoutProposal(proposals: readonly StackProposal[], name: string): StackProposal[] {
  return proposals.filter((p) => p.name !== name);
}
