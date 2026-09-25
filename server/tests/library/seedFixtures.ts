import { CRITIC_PROMPT_VERSION } from '../../src/library/critic.js';
import { GENERATOR_PROMPT_VERSION } from '../../src/library/generator.js';
import type { QuestionRecord, StandardRecord } from '../../src/library/seedFormat.js';
import type { CriticVerdict } from '../../src/library/types.js';
import { BAND, ROLE_TITLE, type LibraryWorld } from './libraryFixtures.js';

/** Seed-file records for the import tests, keyed to the library test world. */

export const SEED_ANCHORS = ['Names the failure mode and its blast radius', 'Says what changed in the process afterwards', 'Quantifies the impact on settlement'];

export function passingVerdict(overrides: Partial<CriticVerdict> = {}): CriticVerdict {
  return { realQuestion: true, rightBand: true, answerable: true, formCorrect: true, anchorsLeaked: false, roleSpecific: true, confidence: 0.9, notes: '', ...overrides };
}

let seq = 0;

export function questionRecord(world: LibraryWorld, overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  seq += 1;
  return {
    kind: 'question', scope: 'global', roleSlug: world.roleSlug, familySlug: world.familySlug, competencyKey: world.competencyKeys[0], band: BAND,
    form: 'star', difficultyTag: 2,
    questionText: `As a ${ROLE_TITLE}, tell me about settlement incident number ${seq} you ran: what broke in the ledger, and what did you change so it could not recur?`,
    rationale: 'Settlement incidents are the core of this role.', anchors: [...SEED_ANCHORS], critic: passingVerdict(),
    provenance: {
      source: 'brahmastra', runId: 'test-run', generatorLane: 'codex', generatorPromptVersion: GENERATOR_PROMPT_VERSION,
      generatedAt: '2026-09-22T10:00:00.000Z', criticLane: 'claude', criticPromptVersion: CRITIC_PROMPT_VERSION,
    },
    ...overrides,
  };
}

export function standardRecord(world: LibraryWorld, overrides: Partial<StandardRecord> = {}): StandardRecord {
  return {
    kind: 'standard', familySlug: world.familySlug, competencyKey: world.competencyKeys[0], band: BAND,
    anchors: [...SEED_ANCHORS], weakSigns: ['Speaks in generalities'],
    provenance: { source: 'brahmastra', runId: 'test-run', generatorLane: 'codex', generatorPromptVersion: GENERATOR_PROMPT_VERSION, generatedAt: '2026-09-22T10:00:00.000Z' },
    ...overrides,
  };
}

export function lines(...records: readonly object[]): string[] {
  return records.map((r) => JSON.stringify(r));
}
