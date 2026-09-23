import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { consentIntro, hasConsentIntro } from '../src/domain/interviewerModel.js';

/**
 * §5: the shipped load harness no longer ran.
 *
 * server/sim/loadPortal.ts carried the pre-rename disclosure wording as a
 * hand-typed string. POST /consent refuses any session whose stored disclosure
 * does not open with the consentIntro() wording, so every consent answered
 * `409 disclosure_missing` and every turn after it answered 409 — the harness
 * reported latency for a run in which no interview ever started.
 * server/sim/voiceAB.ts carried the same string.
 *
 * Both now build the disclosure from consentIntro(). These tests hold that
 * shut from both ends: the derived text passes the check the portal applies,
 * and neither file has gone back to typing one out.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const sim = (name: string) => readFileSync(path.join(here, '..', 'sim', name), 'utf8');

describe('the disclosure the harness stores', () => {
  it('passes the check POST /consent applies', () => {
    const disclosure = `${consentIntro('Maya')} While you speak, your voice is captured and written down. `
      + 'No recording of your voice is stored — the written transcript is what is kept.';
    expect(hasConsentIntro(disclosure)).toBe(true);
  });

  it('would not have passed it as it was written before', () => {
    const old = "Hi, I'm Maya, your AI interviewer from Questor. I'll be conducting your first-round interview today. "
      + 'While you speak, your voice is captured and written down.';
    expect(hasConsentIntro(old)).toBe(false);
  });
});

describe('the harness files themselves', () => {
  it('builds loadPortal.ts\'s disclosure from consentIntro', () => {
    const source = sim('loadPortal.ts');
    expect([source.includes('consentIntro('), /const DISCLOSURE =\s*\n?\s*`\$\{consentIntro/.test(source)]).toEqual([true, true]);
  });

  it('builds voiceAB.ts\'s spoken disclosure from consentIntro', () => {
    expect(sim('voiceAB.ts').includes('consentIntro(')).toBe(true);
  });

  it('leaves no hand-typed introduction in either', () => {
    const typed = /I['’]m\s+\w+,\s*your AI interviewer from Questor/;
    expect([typed.test(sim('loadPortal.ts')), typed.test(sim('voiceAB.ts'))]).toEqual([false, false]);
  });
});
