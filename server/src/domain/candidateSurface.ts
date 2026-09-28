import { capabilitiesOf } from './capabilities.js';

/**
 * Where a person may open a candidate, and whether they may be told who it is.
 *
 * One answer, in one place, because there were two and they disagreed. Booking
 * a round emails the people seated on it, and the queue shows them a row for
 * the round they are about to run; both have to decide the same thing about the
 * same person, and the email decided it correctly while the queue did not.
 *
 * The rule the queue got wrong: a round seat is NOT an assignment. Seating an
 * expert on a round deliberately does not create their
 * `CandidateAssignment{relation:'sme'}` — routes/pipelines.ts says so in as many
 * words, because a row minted from a seat would outlive a role change as a
 * silent claim on a named person. So an expert's entitlement to the candidate
 * comes from `assertSmeAssignment` and from nothing else, and a surface that
 * infers it from the seat is handing out a name nobody granted.
 *
 * Pure, so both callers can be tested against it without a database, and so a
 * third caller cannot quietly invent a fourth rule.
 */
export interface CandidateSurface {
  /**
   * The page this person's own role can open for this candidate, as a path.
   * Null when their role can open none — an auditor, or a role the capability
   * map does not recognise.
   */
  readonly path: string | null;
  /**
   * Whether a surface may name the candidate to them.
   *
   * False for an expert who holds only the seat. They will meet the person in
   * the room, but Questor is not the thing that tells them who it is before
   * somebody has assigned them — and a queue row carrying the name is a
   * disclosure made by a list, which nobody decided.
   */
  readonly mayName: boolean;
}

export function candidateSurfaceFor(o: {
  readonly role: string;
  readonly candidateId: string;
  /** Whether they hold the SME assignment for THIS candidate. */
  readonly smeAssigned: boolean;
}): CandidateSurface {
  const capabilities = capabilitiesOf(o.role);
  // The hiring team works in candidate scope; the candidate's own page is
  // theirs, and object scope decides which candidates, not this.
  if (capabilities.includes('candidate:read')) {
    return { path: `/candidates/${o.candidateId}`, mayName: true };
  }
  if (!capabilities.includes('sme:assigned_read')) return { path: null, mayName: false };
  // An assigned expert sees the candidate by name: the owner's decision, on the
  // grounds that assessing a person is what they were asked to do
  // (docs/credentials-contract.md §3, routes/sme.ts).
  if (o.smeAssigned) return { path: `/sme/candidates/${o.candidateId}`, mayName: true };
  // Seated but not assigned. /sme/candidates/:id would answer 404 —
  // `assertSmeAssignment` has no seat clause — so they go to their own
  // worklist, which is a page that works, and nothing names the candidate.
  return { path: '/sme', mayName: false };
}
