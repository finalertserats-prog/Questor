import { describe, expect, it } from 'vitest';
import { computeFitScore } from '../src/engines/fitScoring.js';
import { buildInterviewPlan } from '../src/engines/interviewPlanner.js';
import { cvSignalsFor } from '../src/library/planLadders.js';
import { cvAnchorsFrom } from '../src/engines/cvAnchors.js';
import { normalizeProfile } from '../src/engines/resumeParser.js';
import { DATA_ENGINEER_ROLE, DATA_ENGINEER_STACK, STRONG_CV, WEAK_CV } from './fixtures/cvFixtures.js';

/**
 * The CV reading has to change the interview, or it is a report nobody acts on.
 *
 * Two routes already exist and this checks both still carry: the top probe
 * becomes the resume-validation block's intent, and the per-competency reading
 * becomes the signal that pitches each question ladder. Neither the planner nor
 * the library was changed to make this pass — what changed is the quality of
 * what flows through them.
 */

const NOW = new Date('2026-09-23T00:00:00Z');
const fitFor = (cv: string) => computeFitScore({}, cv, DATA_ENGINEER_ROLE, DATA_ENGINEER_STACK, { now: NOW }).fit;

describe('the top probe', () => {
  it('becomes what the resume-validation block is for', () => {
    const fit = fitFor(WEAK_CV);
    const plan = buildInterviewPlan({ role: DATA_ENGINEER_ROLE, fit, durationMinutes: 45 });
    const block = plan.blocks.find((b) => b.competencyId === '__resume_validation__')!;

    expect(block.intent).toContain(fit.probes[0]);
  });

  it('is the must-have gap when there is one, not whatever came first alphabetically', () => {
    const fit = fitFor(WEAK_CV);
    expect(fit.probes[0]).toContain('Pipeline Engineering');
  });
});

describe('the per-competency reading', () => {
  it('pitches a ladder down for a competency the CV never mentions', () => {
    const signals = cvSignalsFor(fitFor(WEAK_CV), DATA_ENGINEER_ROLE.competencies);
    expect(signals['c-pipelines']).toBe('thin');
  });

  it('pitches a ladder up for one the CV evidences repeatedly', () => {
    const signals = cvSignalsFor(fitFor(STRONG_CV), DATA_ENGINEER_ROLE.competencies);
    expect(Object.values(signals)).toContain('strong');
  });

  it('never marks a competency both thin and strong', () => {
    const signals = cvSignalsFor(fitFor(STRONG_CV), DATA_ENGINEER_ROLE.competencies);
    for (const value of Object.values(signals)) expect(['thin', 'strong', 'neutral']).toContain(value);
  });
});

describe('the probes and the identity lane', () => {
  /**
   * Identity assurance asks the candidate about lines from their own CV
   * (engines/cvAnchors.ts). These probes ask about what the ROLE needs. If both
   * quoted the CV the interview would ask the same thing twice, in a way that
   * would feel like an interrogation rather than a conversation.
   */
  it('do not ask the same thing as the CV-anchored questions', () => {
    const fit = fitFor(STRONG_CV);
    const anchors = cvAnchorsFrom(normalizeProfile(STRONG_CV));

    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      for (const probe of fit.probes) expect(probe).not.toContain(anchor.fact);
    }
  });

  it('name a role requirement rather than quoting the candidate back at themselves', () => {
    for (const probe of fitFor(WEAK_CV).probes) expect(probe).toMatch(/^Probe [^:]+:/);
  });
});
