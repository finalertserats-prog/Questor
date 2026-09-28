import { prisma } from '../db.js';

/**
 * The scorecard a resume should be scored against.
 *
 * The approved version, when there is one; otherwise the newest draft. This
 * used to be one query ordered by `status desc`, with a comment saying
 * "approved preferred". Descending string order puts "draft" before "approved",
 * so every role mid-edit scored resumes against its unapproved draft while the
 * interview plan used the approved one: two numbers for the same candidate,
 * silently disagreeing.
 *
 * ---- The draft fall-through, and what it is allowed to do
 *
 * Falling through to a draft is a deliberate choice and a dangerous one, so it
 * is written down here rather than left as a comment saying "indicative".
 *
 * A draft scorecard is a machine's first reading of a job description that no
 * person has checked. Its competencies may be wrong, its must-haves may be
 * invented, and its weights are whatever the extractor guessed. A fit score
 * built on one is therefore a guess about a guess.
 *
 * The reason it exists at all: HR uploads CVs while the role is still being
 * written, and the alternative — no reading at all — means the resume panel is
 * empty on exactly the screen where someone is deciding whether the scorecard
 * is any good. Seeing what the draft does to a real CV is how a draft gets
 * fixed.
 *
 * So a fit scored against a draft is marked `provisional` on the stored
 * `FitScore` (domain/types.ts), and that mark is structural — a field a reader
 * has to handle — rather than a docstring a reader has to find.
 *
 * What a provisional reading MAY do:
 *   - be shown to HR on the candidate's own page, labelled as provisional
 *     wherever the number appears;
 *   - say what the interview should probe, because a probe is a question and a
 *     question costs a candidate nothing;
 *   - be recomputed and replaced the moment a scorecard is approved.
 *
 * What a provisional reading may NEVER do:
 *   - order, rank or shortlist candidates;
 *   - filter a candidate out of a list, a stage or a comparison;
 *   - be compared against another candidate's score, or against this
 *     candidate's score for another role (routes/candidates.ts);
 *   - stand in for an approved reading in any record a decision is later
 *     justified from.
 *
 * The one hard gate in front of the interview itself is unchanged:
 * routes/interviews.ts refuses to create a session at all until the role's
 * scorecard is approved.
 */
export async function scorecardForFit(roleId: string | null | undefined) {
  if (!roleId) return null;
  const approved = await prisma.roleScorecardVersion.findFirst({
    where: { roleId, status: 'approved' },
    orderBy: { version: 'desc' },
  });
  if (approved) return approved;
  return prisma.roleScorecardVersion.findFirst({ where: { roleId }, orderBy: { version: 'desc' } });
}
