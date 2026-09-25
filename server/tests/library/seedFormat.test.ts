import { describe, expect, it } from 'vitest';
import { contentHashOf, effectiveVerdict, parseSeedLine, seededPromptVersion } from '../../src/library/seedFormat.js';
import { GENERATOR_PROMPT_VERSION } from '../../src/library/generator.js';
import type { LibraryWorld } from './libraryFixtures.js';
import { passingVerdict, questionRecord, standardRecord } from './seedFixtures.js';

/** The seed file format: strict records, a hash that ignores cosmetic differences. */

const world: LibraryWorld = {
  operator: { id: 'o', tenantId: 't', token: '' }, admin: { id: 'a', tenantId: 't', token: '' }, demo: { id: 'd', tenantId: 't', token: '' },
  roleId: 'r', roleSlug: 'payments-platform-engineer', familySlug: 'engineering-technical-delivery', competencyKeys: ['incident-ownership', 'data-modelling'],
};

describe('parseSeedLine', () => {
  it('accepts a well-formed question record', () => {
    expect(parseSeedLine(JSON.stringify(questionRecord(world))).ok).toBe(true);
  });

  it('accepts a well-formed standard record', () => {
    expect(parseSeedLine(JSON.stringify(standardRecord(world))).ok).toBe(true);
  });

  it('names broken JSON as the reason', () => {
    expect(parseSeedLine('{"kind":"question",')).toEqual({ ok: false, reason: 'json:invalid' });
  });

  it('refuses an organisation-scoped record', () => {
    const result = parseSeedLine(JSON.stringify({ ...questionRecord(world), scope: 'org' }));
    expect(result.ok ? '' : result.reason).toMatch(/^schema:scope:/);
  });

  it('refuses a field the format does not define', () => {
    const result = parseSeedLine(JSON.stringify({ ...questionRecord(world), contentHash: 'abc' }));
    expect(result.ok ? '' : result.reason).toMatch(/unrecognized_keys/);
  });

  it('refuses the classifier-only form "other"', () => {
    const result = parseSeedLine(JSON.stringify({ ...questionRecord(world), form: 'other' }));
    expect(result.ok ? '' : result.reason).toMatch(/^schema:form:/);
  });

  it('refuses an unknown band', () => {
    const result = parseSeedLine(JSON.stringify({ ...questionRecord(world), band: 'wizard' }));
    expect(result.ok ? '' : result.reason).toMatch(/^schema:band:/);
  });

  it('refuses a critic verdict with a missing check', () => {
    const { roleSpecific: _dropped, ...verdict } = passingVerdict();
    const result = parseSeedLine(JSON.stringify({ ...questionRecord(world), critic: verdict }));
    expect(result.ok ? '' : result.reason).toMatch(/^schema:critic\.roleSpecific:/);
  });
});

describe('contentHashOf', () => {
  it('ignores case and spacing in the question', () => {
    const a = questionRecord(world, { questionText: 'How do you   run a settlement incident?' });
    expect(contentHashOf(a)).toBe(contentHashOf({ ...a, questionText: 'how do you run a Settlement incident?' }));
  });

  it('differs for the same text in another band', () => {
    const a = questionRecord(world);
    expect(contentHashOf(a)).not.toBe(contentHashOf({ ...a, band: 'senior' }));
  });
});

describe('effectiveVerdict', () => {
  it('uses the tie-break verdict and marks the split when there is one', () => {
    const tiebreak = passingVerdict({ notes: 'third lane' });
    expect(effectiveVerdict({ critic: passingVerdict({ roleSpecific: false }), tiebreak })).toEqual({ verdict: tiebreak, split: true });
  });

  it('uses the critic verdict when there is no tie-break', () => {
    expect(effectiveVerdict({ critic: passingVerdict() }).split).toBe(false);
  });
});

describe('seededPromptVersion', () => {
  it('never equals the worker prompt version, so seeded entries form their own strata', () => {
    expect(seededPromptVersion(GENERATOR_PROMPT_VERSION)).not.toBe(GENERATOR_PROMPT_VERSION);
  });
});
