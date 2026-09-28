import { describe, it, expect } from 'vitest';
import {
  resolveCandidateBand,
  bandForRoleSeniority,
  bandGuidanceFor,
  templateAllowedForBand,
} from '../src/engines/bandCalibration.js';
import { buildInterviewPlan } from '../src/engines/interviewPlanner.js';
import { extractRoleHeuristic } from '../src/engines/roleIntelligence.js';
import { normalizeProfile } from '../src/engines/resumeParser.js';
import { DEMO_JD, DEMO_RESUME } from '../src/seed/demoData.js';
import { bandById } from '../src/engines/experienceBands.js';
import type { NormalizedProfile } from '../src/domain/types.js';

const ROLE = extractRoleHeuristic(DEMO_JD, 'Senior Data Engineer').profile;

function profileWith(totalYears?: number): NormalizedProfile {
  return { employment: [], education: [], projects: [], certifications: [], skills: [], totalYears };
}

describe('bandForRoleSeniority', () => {
  it('reads the level words a JD actually uses', () => {
    expect(bandForRoleSeniority('Junior').id).toBe('emerging');
    expect(bandForRoleSeniority('Mid').id).toBe('developing');
    expect(bandForRoleSeniority('Senior').id).toBe('established');
    expect(bandForRoleSeniority('Lead').id).toBe('senior');
    expect(bandForRoleSeniority('Principal').id).toBe('principal');
    expect(bandForRoleSeniority('Director').id).toBe('executive');
  });

  it('falls back to the middle rather than guessing high or low', () => {
    expect(bandForRoleSeniority('').id).toBe('established');
    expect(bandForRoleSeniority('Grade 7').id).toBe('established');
  });

  it('is case and punctuation tolerant, because JDs are written by people', () => {
    expect(bandForRoleSeniority('  SENIOR  ').id).toBe('established');
    expect(bandForRoleSeniority('Sr.').id).toBe('established');
    expect(bandForRoleSeniority('VP of Engineering').id).toBe('executive');
  });
});

describe('resolveCandidateBand', () => {
  it('bands a real parsed resume from its own evidence', () => {
    const profile = normalizeProfile(DEMO_RESUME);
    const r = resolveCandidateBand({ profile, resumeText: DEMO_RESUME, roleSeniority: 'Senior' });
    expect(['established', 'senior']).toContain(r.band.id);
    expect(r.rationale.length).toBeGreaterThan(20);
  });

  it('uses the candidate, not the role, when the resume says enough', () => {
    // The whole point. A junior applying to a senior req is still a junior, and
    // interviewing them at the req's level is how a fresher ends up being asked
    // how they architected a system.
    const r = resolveCandidateBand({
      profile: profileWith(1),
      resumeText: 'Implemented well-specified features and fixed defects raised in review.',
      roleSeniority: 'Lead',
    });
    expect(r.band.id).toBe('emerging');
  });

  it('falls back to the role level when the resume gives nothing to go on', () => {
    const r = resolveCandidateBand({ profile: profileWith(undefined), resumeText: '', roleSeniority: 'Principal' });
    expect(r.band.id).toBe('principal');
    expect(r.source).toBe('role');
  });

  it('reports which signal decided it, so a reviewer can audit the pitch', () => {
    const fromCandidate = resolveCandidateBand({
      profile: profileWith(15), resumeText: 'Set architecture across four teams.', roleSeniority: 'Junior',
    });
    expect(fromCandidate.source).toBe('candidate');
    expect(fromCandidate.rationale).toMatch(/year|scope|evidence/i);
  });

  it('never lands outside the band table', () => {
    for (const years of [0, 1, 4, 7, 11, 17, 30, 60]) {
      const r = resolveCandidateBand({ profile: profileWith(years), resumeText: '', roleSeniority: '' });
      expect(() => bandById(r.band.id)).not.toThrow();
    }
  });
});

describe('bandGuidanceFor', () => {
  it('tells the interviewer what to ask and what to avoid', () => {
    const g = bandGuidanceFor('emerging');
    expect(g).toMatch(/craft/i);
    expect(g.toLowerCase()).toContain('architected');   // from the avoid list
  });

  it('differs between the bottom and the top of the scale', () => {
    expect(bandGuidanceFor('emerging')).not.toBe(bandGuidanceFor('executive'));
  });

  it('names the evidence bar so the interviewer knows when to stop probing', () => {
    for (const id of ['emerging', 'senior', 'executive'] as const) {
      expect(bandGuidanceFor(id)).toContain(bandById(id).evidenceBar);
    }
  });
});

describe('templateAllowedForBand', () => {
  /**
   * The question that started this. A one-year junior was asked to diagnose a
   * system they inherited, undocumented, from someone who left — a question
   * that presumes ownership they have never had.
   */
  const INHERITED = 'Suppose you joined us and in your first month inherited a {name} setup you didn\'t build and nobody documented. What are the first three things you\'d look at, and why those three?';

  it('keeps the inherited-system hypothetical away from the craft bands', () => {
    expect(templateAllowedForBand(INHERITED, 'emerging')).toBe(false);
    expect(templateAllowedForBand(INHERITED, 'developing')).toBe(false);
  });

  it('allows it once the candidate plausibly owns systems', () => {
    expect(templateAllowedForBand(INHERITED, 'established')).toBe(true);
    expect(templateAllowedForBand(INHERITED, 'senior')).toBe(true);
  });

  it('leaves band-neutral question forms alone at every band', () => {
    const neutral = 'Tell me about a time {name} was the difference between a project going well and going badly.';
    for (const id of ['emerging', 'developing', 'established', 'senior', 'principal', 'executive'] as const) {
      expect(templateAllowedForBand(neutral, id)).toBe(true);
    }
  });
});

describe('buildInterviewPlan carries the band', () => {
  it('records the band on the plan so every downstream stage can see it', () => {
    const plan = buildInterviewPlan({ role: ROLE, band: 'principal' });
    expect(plan.band).toBe('principal');
  });

  it('defaults to the role seniority when no band is supplied', () => {
    const plan = buildInterviewPlan({ role: { ...ROLE, seniority: 'Junior' } });
    expect(plan.band).toBe('emerging');
  });

  it('puts the band guidance on every competency block', () => {
    const plan = buildInterviewPlan({ role: ROLE, band: 'emerging' });
    const scored = plan.blocks.filter((b) => !b.competencyId.startsWith('__'));
    expect(scored.length).toBeGreaterThan(0);
    for (const b of scored) {
      expect(b.bandGuidance, b.competencyName).toBeTruthy();
      expect(b.bandGuidance).toContain('craft');
    }
  });

  it('changes the guidance when the band changes, not just the label', () => {
    const junior = buildInterviewPlan({ role: ROLE, band: 'emerging' });
    const exec = buildInterviewPlan({ role: ROLE, band: 'executive' });
    const j = junior.blocks.find((b) => !b.competencyId.startsWith('__'))!;
    const e = exec.blocks.find((b) => !b.competencyId.startsWith('__'))!;
    expect(j.bandGuidance).not.toBe(e.bandGuidance);
  });

  it('leaves the process and close blocks free of band guidance', () => {
    // These are script, not assessment — pitching a consent disclosure at a
    // seniority level would be nonsense.
    const plan = buildInterviewPlan({ role: ROLE, band: 'senior' });
    expect(plan.blocks.find((b) => b.competencyId === '__process__')?.bandGuidance).toBeUndefined();
  });
});
