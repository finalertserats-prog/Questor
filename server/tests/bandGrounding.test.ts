import { describe, it, expect } from 'vitest';
import { bandGuidanceFor, templateAllowedForBand } from '../src/engines/bandCalibration.js';
import type { Competency } from '../src/domain/types.js';

// A Project Manager (survey delivery) interview asked "build versus buy" about
// five times and "long-term consequences / architecture" in nearly every
// question. The source was the principal band's "Ask about" list, pasted into
// every question prompt whatever the competency: "architecture spanning
// multiple systems and its long-horizon consequences; a build-versus-buy or
// platform bet". The level should set how deep a question goes, not what it is
// about — the competency does that.

function competency(name: string, category: Competency['category'], definition = ''): Competency {
  return {
    id: name, name, definition, category, classification: 'essential', weight: 0.3,
    requiredLevel: 3, targetLevel: 4, indicators: [], evidenceModes: [],
  };
}

const PM_SURVEY = [
  competency('Project Management', 'behavioral', 'Plans and delivers survey projects on time with research managers and clients.'),
  competency('Survey Programming', 'technical', 'Scripts questionnaires, logic and quotas.'),
  competency('Technical Proficiency in Survey Tools', 'technical', 'Decipher, Qualtrics, Confirmit.'),
];

describe('band guidance is grounded in the competency', () => {
  it.each(PM_SURVEY.map((c) => [c.name, c] as const))('does not steer "%s" towards architecture or build-versus-buy', (_name, c) => {
    const guidance = bandGuidanceFor('principal', c);
    expect(guidance).not.toMatch(/build-versus-buy|architecture|long-horizon consequences/i);
  });

  it('says the competency sets the topic and the level sets the depth', () => {
    expect(bandGuidanceFor('principal', PM_SURVEY[0])).toMatch(/depth, not the topic/i);
  });

  it('keeps architecture for a competency that is about architecture', () => {
    const arch = competency('Cloud Platform Architecture', 'technical', 'Designs multi-system platforms.');
    expect(bandGuidanceFor('principal', arch)).toMatch(/architecture spanning multiple systems/);
  });

  it('keeps build-versus-buy for a competency about vendors and tooling strategy', () => {
    const vendor = competency('Vendor & Technology Strategy', 'domain', 'Selects platforms and vendors.');
    expect(bandGuidanceFor('principal', vendor)).toMatch(/build-versus-buy/);
  });

  it('still carries the level itself and what to avoid', () => {
    const g = bandGuidanceFor('principal', PM_SURVEY[1]);
    expect(g).toMatch(/CANDIDATE LEVEL/);
    expect(g).toMatch(/Do NOT ask about/);
  });
});

describe('build-versus-buy is screened in every wording', () => {
  it.each([
    'Tell me about a build versus buy decision.',
    'Tell me about a build vs buy decision.',
    'Tell me about a build-vs-buy decision.',
    'Tell me about a build or buy decision.',
  ])('"%s" is too senior for a developing candidate', (q) => {
    expect(templateAllowedForBand(q, 'developing')).toBe(false);
  });
});
