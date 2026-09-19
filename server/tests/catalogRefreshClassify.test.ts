import { describe, expect, it } from 'vitest';
import { buildCatalogIndex, type CatalogRoleForMatch } from '../src/domain/catalogMatch.js';
import { familiesByDomain, tokenOverlapClassification, validateModelClassifications } from '../src/domain/catalogClassification.js';
import { classifyTitles, type ClassificationModel } from '../src/services/catalogClassify.js';

function role(id: string, title: string, domainId: string, familyId: string | null): CatalogRoleForMatch {
  return { id, title, domainId, familyId, aliases: [] };
}

const roles = [
  role('r1', 'Software Engineer', 'tech', 'eng'),
  role('r2', 'Backend Software Developer', 'tech', 'eng'),
  role('r3', 'Clinical Nurse', 'health', 'care'),
];
const index = buildCatalogIndex(roles);
const allowed = { domainIds: new Set(['tech', 'health']), familiesByDomain: familiesByDomain(roles) };

function titles(...values: string[]) {
  return values.map((title) => ({ title }));
}

describe('token-overlap fallback', () => {
  it('assigns the domain of the most similar existing role', () => {
    expect(tokenOverlapClassification('Senior Software Engineer', roles).domainId).toBe('tech');
  });

  it('takes the family of the most similar existing role', () => {
    expect(tokenOverlapClassification('Clinical Nurse Specialist', roles).familyId).toBe('care');
  });

  it('never claims more than 0.5 confidence', () => {
    expect(tokenOverlapClassification('Software Engineer', roles).confidence).toBeLessThanOrEqual(0.5);
  });

  it('assigns no domain when no word overlaps', () => {
    expect(tokenOverlapClassification('Farmworkers', roles)).toEqual({ domainId: null, familyId: null, confidence: 0 });
  });
});

describe('validating model classifications against real ids', () => {
  it('keeps a row whose domain and family exist together', () => {
    const out = validateModelClassifications([{ title: 'ML Engineer', domainId: 'tech', familyId: 'eng', confidence: 0.9 }], allowed);
    expect(out.get('ml engineer')).toEqual({ domainId: 'tech', familyId: 'eng', confidence: 0.9 });
  });

  it('drops a row whose domain id does not exist', () => {
    const out = validateModelClassifications([{ title: 'ML Engineer', domainId: 'made-up', familyId: null, confidence: 0.9 }], allowed);
    expect(out.has('ml engineer')).toBe(false);
  });

  it('clears a family that belongs to another domain', () => {
    const out = validateModelClassifications([{ title: 'ML Engineer', domainId: 'tech', familyId: 'care', confidence: 0.9 }], allowed);
    expect(out.get('ml engineer')?.familyId).toBeNull();
  });

  it('ignores rows that are not shaped like a classification', () => {
    expect(validateModelClassifications([{ title: 5 }, 'nonsense', null], allowed).size).toBe(0);
  });

  it('ignores a reply that is not a list', () => {
    expect(validateModelClassifications({ title: 'x' }, allowed).size).toBe(0);
  });
});

describe('classifying titles for new-role proposals', () => {
  it('uses the model when it answers with real ids', async () => {
    const model: ClassificationModel = async () => [{ title: 'Nurse Practitioner', domainId: 'health', familyId: 'care', confidence: 0.8 }];
    const result = await classifyTitles(titles('Nurse Practitioner'), { index, allowed, model, maxCalls: 5 });
    expect(result.byTitle.get('nurse practitioner')).toEqual({ domainId: 'health', familyId: 'care', confidence: 0.8, method: 'model' });
  });

  it('falls back to token overlap when the model invents a domain id', async () => {
    const model: ClassificationModel = async () => [{ title: 'Software Tester', domainId: 'cjld2cjxh0000qzrmn831i7rn', familyId: null, confidence: 0.99 }];
    const result = await classifyTitles(titles('Software Tester'), { index, allowed, model, maxCalls: 5 });
    expect(result.byTitle.get('software tester')).toMatchObject({ domainId: 'tech', method: 'overlap' });
  });

  it('falls back when the model gives no answer', async () => {
    const model: ClassificationModel = async () => null;
    const result = await classifyTitles(titles('Software Tester'), { index, allowed, model, maxCalls: 5 });
    expect(result.byTitle.get('software tester')?.method).toBe('overlap');
  });

  it('neither calls nor counts a model that is not available', async () => {
    let calls = 0;
    const model: ClassificationModel = async () => { calls += 1; return []; };
    const result = await classifyTitles(titles('Software Tester'), { index, allowed, model, maxCalls: 5, modelAvailable: false });
    expect({ calls, reported: result.modelCalls, method: result.byTitle.get('software tester')?.method }).toEqual({ calls: 0, reported: 0, method: 'overlap' });
  });

  it('falls back instead of failing when the model call throws', async () => {
    const model: ClassificationModel = async () => { throw new Error('provider down'); };
    const result = await classifyTitles(titles('Software Tester'), { index, allowed, model, maxCalls: 5 });
    expect(result.byTitle.get('software tester')?.method).toBe('overlap');
  });

  it('asks the model in batches of 25', async () => {
    const batchSizes: number[] = [];
    const model: ClassificationModel = async (request) => { batchSizes.push(request.titles.length); return []; };
    await classifyTitles(Array.from({ length: 30 }, (_, i) => ({ title: `Title ${i}` })), { index, allowed, model, maxCalls: 5 });
    expect(batchSizes).toEqual([25, 5]);
  });

  it('stops calling the model at the call cap and falls back for the rest', async () => {
    let calls = 0;
    const model: ClassificationModel = async () => { calls += 1; return []; };
    const result = await classifyTitles(Array.from({ length: 30 }, (_, i) => ({ title: `Software Title ${i}` })), { index, allowed, model, maxCalls: 1 });
    expect({ calls, reported: result.modelCalls, classified: result.byTitle.size }).toEqual({ calls: 1, reported: 1, classified: 30 });
  });

  it('sends only real domain ids and their families to the model', async () => {
    let seen: unknown = null;
    const model: ClassificationModel = async (request) => { seen = request.domains; return []; };
    const names = { domains: new Map([['tech', 'Tech'], ['health', 'Health']]), families: new Map([['eng', 'Engineering'], ['care', 'Care']]) };
    await classifyTitles(titles('X'), { index, allowed, model, maxCalls: 1, names });
    expect(seen).toEqual([
      { id: 'tech', name: 'Tech', families: [{ id: 'eng', name: 'Engineering' }] },
      { id: 'health', name: 'Health', families: [{ id: 'care', name: 'Care' }] },
    ]);
  });
});
