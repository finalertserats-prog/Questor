import { describe, expect, it } from 'vitest';
import { BANDS } from '../src/engines/experienceBands.js';
import { draftJdFromDescriptionHeuristic, draftJdHeuristic, lintJd, personaliseJd } from '../src/engines/jdDraft.js';

const base = {
  title: 'Forward Deployed Engineer',
  domainName: 'Frontier AI, Applied AI & Forward Deployed Engineering',
  familyName: 'Engineering / Technical Delivery',
  summary: 'Own complex end-to-end deployments of advanced AI systems with strategic customers, from problem discovery through production rollout.',
  marketSignal: 'High-growth / expanding',
  regionName: 'India',
};

// Words that belong to our catalog and rubric, never to a candidate-facing JD.
const INTERNAL = /\bband\b|pedigree|\bfamily\b|High-growth|evidence bar|calibrated/i;

describe('draftJdHeuristic', () => {
  it('has every section a job description needs', () => {
    const text = draftJdHeuristic({ ...base, band: 'senior' });
    for (const section of ['About the role', 'What you will do', 'What you bring', 'Nice to have', 'Location']) expect(text).toContain(section);
  });

  it('opens by telling the candidate what they will own, in plain words', () => {
    const text = draftJdHeuristic({ ...base, band: 'senior' });
    expect(text).toContain('As a Forward Deployed Engineer, you will own complex end-to-end deployments of advanced AI systems');
  });

  it('never shows internal catalog or rubric language to a candidate, at any level', () => {
    for (const band of BANDS) expect(draftJdHeuristic({ ...base, band: band.id })).not.toMatch(INTERNAL);
  });

  it('never pastes the domain name in lower case into a sentence', () => {
    expect(draftJdHeuristic({ ...base, band: 'established' })).not.toContain(base.domainName.toLowerCase());
  });

  it('pitches the work at the level: hands-on early, direction-setting at the top', () => {
    expect([
      /hands-on/i.test(draftJdHeuristic({ ...base, band: 'developing' })),
      /set direction/i.test(draftJdHeuristic({ ...base, band: 'principal' })),
    ]).toEqual([true, true]);
  });

  it('treats years as a guide, and asks for no minimum at entry level', () => {
    expect([
      draftJdHeuristic({ ...base, band: 'senior' }).includes('or equivalent evidence'),
      /no minimum/i.test(draftJdHeuristic({ ...base, band: 'emerging' })),
    ]).toEqual([true, true]);
  });

  it('names the location and passes the fairness lint at every level', () => {
    for (const band of BANDS) {
      const text = draftJdHeuristic({ ...base, band: band.id });
      expect({ india: text.includes('India'), lint: lintJd(text) }).toEqual({ india: true, lint: [] });
    }
  });

  it('still reads well when the catalog has no summary', () => {
    const text = draftJdHeuristic({ ...base, summary: '', band: 'established' });
    expect(text).toMatch(/As a Forward Deployed Engineer, you will [a-z]/);
  });
});

describe('draftJdFromDescriptionHeuristic', () => {
  it('builds a candidate-facing draft from the description without internal language', () => {
    const text = draftJdFromDescriptionHeuristic({
      title: 'Payments Engineer',
      description: 'You will run our card payments platform. You will work with risk and finance. Success is fewer failed payments and faster settlement.',
      band: 'senior',
      regionName: 'India',
    });
    expect({ opens: text.startsWith('Payments Engineer'), internal: INTERNAL.test(text), lint: lintJd(text) }).toEqual({ opens: true, internal: false, lint: [] });
  });
});

describe('lintJd and personaliseJd', () => {
  it('flags exclusionary terms', () => {
    expect(lintJd('We need a digital native.')).toEqual([{ term: 'digital native', suggestion: 'Avoid age-coded language; describe the skill instead.' }]);
  });

  it('adds the tech stack to the organisation copy only', () => {
    const shared = 'Role text';
    expect([personaliseJd(shared, { techStack: ['React'] }), shared]).toEqual(['Role text\n\nTech stack: React.', 'Role text']);
  });
});
