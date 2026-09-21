import { describe, it, expect } from 'vitest';
import {
  addTechnology, confirmQuestion, jdDiffLines, mergeDetected, proposalPayload, removeTechnology, suggestionsFor,
  techNameProblem, updateTechnology, withoutProposal, type StackProposal, type TechStackItem,
} from '../src/components/techStackModel';

const item = (over: Partial<TechStackItem> = {}): TechStackItem => ({ name: 'React', category: 'framework', level: 'working', required: true, ...over });
const CATALOG = [{ name: 'PostgreSQL', category: 'data' as const }, { name: 'Python', category: 'language' as const }];

describe('adding a technology', () => {
  it('takes the catalog spelling and category for a known name', () => {
    expect(addTechnology([], 'postgresql', CATALOG)).toEqual([{ name: 'PostgreSQL', category: 'data', level: 'working', required: true }]);
  });

  it('files an unknown name under other', () => {
    expect(addTechnology([], 'Elixir', CATALOG)[0].category).toBe('other');
  });

  it('collapses inner whitespace', () => {
    expect(addTechnology([], '  Spring   Boot ', [])[0].name).toBe('Spring Boot');
  });

  it('leaves the stack alone when the name is a duplicate', () => {
    expect(addTechnology([item()], 'react', [])).toEqual([item()]);
  });
});

describe('why a name cannot be added', () => {
  it('asks for a name when blank', () => {
    expect(techNameProblem([], '  ')).toBe('Type a technology first.');
  });

  it('refuses a duplicate whatever its case', () => {
    expect(techNameProblem([item()], 'REACT')).toBe('REACT is already on the list.');
  });

  it('refuses a name over forty characters', () => {
    expect(techNameProblem([], 'x'.repeat(41))).toMatch(/under 40 characters/);
  });

  it('refuses a twenty-sixth technology', () => {
    const full = Array.from({ length: 25 }, (_, i) => item({ name: `T${i}` }));
    expect(techNameProblem(full, 'One more')).toMatch(/at most 25/);
  });

  it('is null for a usable name', () => {
    expect(techNameProblem([item()], 'Vue')).toBeNull();
  });
});

describe('editing a row', () => {
  it('changes the level of that technology only', () => {
    const next = updateTechnology([item(), item({ name: 'Vue' })], 'Vue', { level: 'expert' });
    expect(next.map((t) => t.level)).toEqual(['working', 'expert']);
  });

  it('removes by name', () => {
    expect(removeTechnology([item(), item({ name: 'Vue' })], 'React').map((t) => t.name)).toEqual(['Vue']);
  });
});

describe('merging what the job description names', () => {
  it('adds detected technologies behind the typed ones', () => {
    expect(mergeDetected([item()], [item({ name: 'Kafka' })]).map((t) => t.name)).toEqual(['React', 'Kafka']);
  });

  it('keeps the typed row when the same name is detected', () => {
    expect(mergeDetected([item({ level: 'expert' })], [item({ level: 'familiar' })])).toEqual([item({ level: 'expert' })]);
  });
});

describe('suggestions', () => {
  it('offers catalog names that start with what was typed', () => {
    expect(suggestionsFor([], 'py', CATALOG)).toEqual(['Python']);
  });

  it('leaves out names already on the stack', () => {
    expect(suggestionsFor([item({ name: 'Python' })], 'py', CATALOG)).toEqual([]);
  });

  it('offers nothing for an empty query', () => {
    expect(suggestionsFor([], '', CATALOG)).toEqual([]);
  });
});

describe('the job description confirmation', () => {
  it('marks removed, kept and added lines', () => {
    const lines = jdDiffLines(['Tech stack', '- Vue: working knowledge (required)'], ['Tech stack', '- React: strong experience (required)']);
    expect(lines.map((l) => l.kind)).toEqual(['kept', 'removed', 'added']);
  });

  it('asks about adding a section to a JD without one', () => {
    expect(confirmQuestion('inserted', 2)).toBe('Add a tech-stack section with these 2 technologies to the job description?');
  });

  it('asks about updating an existing section', () => {
    expect(confirmQuestion('replaced', 1)).toBe('Update the job description with these 1 technology?');
  });

  it('asks about removing the section when the stack is emptied', () => {
    expect(confirmQuestion('removed', 0)).toMatch(/^Remove the tech-stack section/);
  });
});

const PROPOSAL: StackProposal = {
  name: 'React', definition: 'Builds with React.', category: 'technical', classification: 'essential',
  indicators: ['One', 'Two', 'Three'], requiredLevel: 3, targetLevel: 4, technologies: ['React'],
};

describe('accepting a proposal', () => {
  it('sends the fields the add route accepts and nothing else', () => {
    expect(Object.keys(proposalPayload(PROPOSAL)).sort()).toEqual(['category', 'classification', 'definition', 'indicators', 'mustPass', 'name', 'requiredLevel', 'targetLevel']);
  });

  it('never makes a proposal must-pass by itself', () => {
    expect(proposalPayload(PROPOSAL).mustPass).toBe(false);
  });

  it('drops the accepted proposal from the list', () => {
    expect(withoutProposal([PROPOSAL, { ...PROPOSAL, name: 'Kafka' }], 'React').map((p) => p.name)).toEqual(['Kafka']);
  });
});
