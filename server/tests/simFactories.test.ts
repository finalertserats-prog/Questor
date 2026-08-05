import { describe, it, expect } from 'vitest';
import { BANDS, inferBand, bandById } from '../src/sim/bands.js';
import { ROLE_FAMILIES, templateRole, validateRoleSpec } from '../src/sim/roleFactory.js';
import {
  CANDIDATE_STRENGTHS,
  templateCandidate,
  validateCandidateSpec,
  midBandYears,
} from '../src/sim/candidateFactory.js';

describe('role families', () => {
  it('covers more than one kind of knowledge work', () => {
    expect(ROLE_FAMILIES.length).toBeGreaterThanOrEqual(6);
    expect(new Set(ROLE_FAMILIES).size).toBe(ROLE_FAMILIES.length);
  });
});

describe('templateRole', () => {
  it('produces a usable JD for every family and band', () => {
    for (const family of ROLE_FAMILIES) {
      for (const band of BANDS) {
        const role = templateRole({ family, band: band.id });
        expect(role.jdText.length).toBeGreaterThan(200);
        expect(role.title.length).toBeGreaterThan(3);
        expect(role.band).toBe(band.id);
        expect(role.family).toBe(family);
      }
    }
  });

  it('is deterministic — the same request gives the same JD', () => {
    const a = templateRole({ family: 'data_engineering', band: 'senior' });
    const b = templateRole({ family: 'data_engineering', band: 'senior' });
    expect(a.jdText).toBe(b.jdText);
    expect(a.title).toBe(b.title);
  });

  it('varies the title by band, so the level is visible in the JD', () => {
    const junior = templateRole({ family: 'software_engineering', band: 'emerging' });
    const principal = templateRole({ family: 'software_engineering', band: 'principal' });
    expect(junior.title).not.toBe(principal.title);
  });
});

describe('validateRoleSpec', () => {
  const good = templateRole({ family: 'finance', band: 'established' });

  it('accepts a well-formed spec', () => {
    expect(() => validateRoleSpec({ title: good.title, jdText: good.jdText })).not.toThrow();
  });

  it('rejects a missing or stub job description', () => {
    expect(() => validateRoleSpec({ title: 'X', jdText: 'too short' })).toThrow();
    expect(() => validateRoleSpec({ title: 'X' })).toThrow();
  });

  it('rejects a missing title', () => {
    expect(() => validateRoleSpec({ jdText: good.jdText })).toThrow();
  });
});

describe('midBandYears', () => {
  it('lands inside the band for every band', () => {
    for (const band of BANDS) {
      const y = midBandYears(band.id);
      expect(y).toBeGreaterThanOrEqual(band.yearsPrior.min);
      if (Number.isFinite(band.yearsPrior.max)) expect(y).toBeLessThan(band.yearsPrior.max);
    }
  });

  it('gives the open-ended top band a concrete, plausible figure', () => {
    const y = midBandYears('executive');
    expect(Number.isFinite(y)).toBe(true);
    expect(y).toBeGreaterThanOrEqual(18);
    expect(y).toBeLessThan(45);
  });
});

describe('templateCandidate', () => {
  const role = templateRole({ family: 'data_engineering', band: 'senior' });

  it('produces a candidate for every band and strength', () => {
    for (const band of BANDS) {
      for (const strength of CANDIDATE_STRENGTHS) {
        const c = templateCandidate({ role, band: band.id, strength });
        expect(c.resumeText.length).toBeGreaterThan(150);
        expect(c.personaBrief.length).toBeGreaterThan(80);
        expect(c.band).toBe(band.id);
        expect(c.strength).toBe(strength);
        expect(c.email).toMatch(/@example\.(com|org)$/);
      }
    }
  });

  it('gives the candidate years consistent with their band', () => {
    for (const band of BANDS) {
      const c = templateCandidate({ role, band: band.id, strength: 'strong' });
      expect(c.totalYears).toBeGreaterThanOrEqual(band.yearsPrior.min);
      if (Number.isFinite(band.yearsPrior.max)) expect(c.totalYears).toBeLessThan(band.yearsPrior.max);
    }
  });

  /**
   * The round trip that makes the whole harness trustworthy: if a resume
   * generated FOR a band does not band back TO it, then a calibration failure
   * measured later could just as easily be the fixture's fault as the engine's.
   */
  it('round-trips — a resume built for a band infers back to that band', () => {
    for (const band of BANDS) {
      for (const strength of CANDIDATE_STRENGTHS) {
        const c = templateCandidate({ role, band: band.id, strength });
        const inferred = inferBand({ totalYears: c.totalYears, evidenceText: c.resumeText });
        expect(inferred.band.id, `${band.id}/${strength} inferred as ${inferred.band.id}`).toBe(band.id);
      }
    }
  });

  it('never writes a resume that claims scope the band forbids', () => {
    for (const band of BANDS) {
      const forbidden = bandById(band.id).avoid;
      const c = templateCandidate({ role, band: band.id, strength: 'strong' });
      // A blunt proxy for the real rule: an entry-level resume must not claim
      // headcount or P&L ownership.
      if (band.id === 'emerging' || band.id === 'developing') {
        expect(c.resumeText.toLowerCase()).not.toMatch(/\b(p&l|headcount|board)\b/);
      }
      expect(forbidden.length).toBeGreaterThan(0);
    }
  });

  it('distinguishes the three strengths in the answering brief', () => {
    const briefs = CANDIDATE_STRENGTHS.map(
      (s) => templateCandidate({ role, band: 'established', strength: s }).personaBrief,
    );
    expect(new Set(briefs).size).toBe(CANDIDATE_STRENGTHS.length);
  });

  it('is deterministic for a given role, band and strength', () => {
    const a = templateCandidate({ role, band: 'principal', strength: 'borderline' });
    const b = templateCandidate({ role, band: 'principal', strength: 'borderline' });
    expect(a.resumeText).toBe(b.resumeText);
    expect(a.fullName).toBe(b.fullName);
  });
});

describe('validateCandidateSpec', () => {
  it('accepts a well-formed spec', () => {
    expect(() =>
      validateCandidateSpec({
        fullName: 'Avery Lin',
        resumeText: 'x'.repeat(200),
        personaBrief: 'y'.repeat(100),
        totalYears: 7,
      }),
    ).not.toThrow();
  });

  it('rejects a stub resume or a missing brief', () => {
    expect(() => validateCandidateSpec({ fullName: 'A', resumeText: 'short', personaBrief: 'y'.repeat(100), totalYears: 7 })).toThrow();
    expect(() => validateCandidateSpec({ fullName: 'A', resumeText: 'x'.repeat(200), totalYears: 7 })).toThrow();
  });

  it('rejects a nonsensical year count', () => {
    expect(() =>
      validateCandidateSpec({ fullName: 'A', resumeText: 'x'.repeat(200), personaBrief: 'y'.repeat(100), totalYears: -2 }),
    ).toThrow();
  });
});
