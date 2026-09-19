import { describe, it, expect } from 'vitest';
import { normalizeProfile } from '../src/engines/resumeParser.js';

const YEAR = new Date().getFullYear();

describe('total years of experience', () => {
  /**
   * The defect. Tenure was the span between the earliest and latest years
   * WRITTEN on the CV, and "Present" is not a year — so a director employed
   * since 2004 measured as zero years. That fed the band calibration, which
   * banded a 22-year executive as `developing` and interviewed them at a level
   * meant for someone with two to five years.
   */
  it('counts an ongoing role up to today, not up to the last year written down', () => {
    const cv = `Avery Lin\n\nExperience:\nDirector of Data, Acme (2004 - Present)\n- Owned the P&L.\n\nEducation:\nB.Sc. Computer Science (2004)\n`;
    expect(normalizeProfile(cv).totalYears).toBe(YEAR - 2004);
  });

  it('recognises the other ways a CV says "still there"', () => {
    for (const word of ['Present', 'present', 'Current', 'now', 'to date', 'Ongoing']) {
      const cv = `X\n\nExperience:\nLead Engineer, Acme (2015 - ${word})\n\nEducation:\nB.Sc. (2015)\n`;
      expect(normalizeProfile(cv).totalYears, word).toBe(YEAR - 2015);
    }
  });

  it('leaves a fully dated history alone', () => {
    const cv = `X\n\nExperience:\nEngineer, Acme (2018 - 2021)\n\nEducation:\nB.Sc. (2014)\n`;
    expect(normalizeProfile(cv).totalYears).toBe(7);
  });

  it('still reports nothing when there are no usable dates', () => {
    expect(normalizeProfile('X\n\nExperience:\nEngineer, Acme\n').totalYears).toBeUndefined();
  });

  it('does not invent tenure from a lone education year with no ongoing role', () => {
    expect(normalizeProfile('X\n\nEducation:\nB.Sc. (2014)\n').totalYears).toBeUndefined();
  });

  it('stays within the sane ceiling', () => {
    const cv = `X\n\nExperience:\nEngineer, Acme (1981 - Present)\n\nEducation:\nB.Sc. (1981)\n`;
    expect(normalizeProfile(cv).totalYears).toBeLessThanOrEqual(45);
  });
});
