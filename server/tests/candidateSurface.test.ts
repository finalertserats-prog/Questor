import { describe, it, expect } from 'vitest';
import { candidateSurfaceFor } from '../src/domain/candidateSurface.js';

/**
 * Where a person may open a candidate, and whether they may be told who it is.
 *
 * One answer for the interviewer's email and the "Needs you" queue, because
 * there were two and they disagreed: the email asked whether the expert held
 * the assignment, the queue assumed the seat was enough. A round seat is NOT an
 * assignment — routes/pipelines.ts refuses to mint one — so the queue was
 * arming a candidate-name leak for whoever next widened the dashboard route.
 */

const surface = (role: string, smeAssigned = false) => candidateSurfaceFor({ role, candidateId: 'c1', smeAssigned });

describe('the surface a role can open a candidate on', () => {
  it('sends the hiring team to the candidate page', () => {
    expect(surface('recruiter')).toEqual({ path: '/candidates/c1', mayName: true });
  });

  it('sends an assigned expert to their own surface, which is the one their role can open', () => {
    expect(surface('sme', true)).toEqual({ path: '/sme/candidates/c1', mayName: true });
  });

  // The whole point. `assertSmeAssignment` has no seat clause, so
  // /sme/candidates/:id would answer 404 — and the name would have been
  // disclosed by a list rather than by anybody's decision.
  it('does not name the candidate to an expert who holds only a round seat', () => {
    expect(surface('sme', false)).toEqual({ path: '/sme', mayName: false });
  });

  it('opens nothing for a role that reads no candidates at all', () => {
    expect(surface('auditor')).toEqual({ path: null, mayName: false });
  });

  // An unrecognised role resolves to no capabilities (domain/capabilities.ts),
  // so it must fall through to nothing rather than to a default.
  it('opens nothing for a role the capability map does not recognise', () => {
    expect(surface('program_owner')).toEqual({ path: null, mayName: false });
  });

  it('does not let an assignment widen a role that could not read candidates anyway', () => {
    expect(surface('auditor', true)).toEqual({ path: null, mayName: false });
  });
});
