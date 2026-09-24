import { z } from 'zod';
import type { Tier } from './badgeGeometry.js';

/**
 * What a certificate is allowed to say, frozen at the moment the award was
 * struck.
 *
 * Everything printed comes from here and nothing is read back out of the
 * database at render time — not the candidate's name, not the role's title,
 * not who signed. A certificate states what was true when it was struck, and a
 * role renamed or a candidate's name corrected six months later must not
 * silently rewrite a document somebody has already filed. The same reasoning
 * as `CandidateFeedbackEmail.optInAsked`.
 *
 * This is the shape the award lane writes into `CandidateAward.evidenceJson`.
 * Changing it is a contract change (docs/credentials-contract.md §2), not a
 * local edit.
 */

/**
 * A string that may be printed, and nothing else.
 *
 * Surrounding whitespace is trimmed; a control character that survives the
 * trim is rejected outright. The asymmetry is deliberate. A stored value with
 * a stray newline on the end is untidy and harmless once trimmed, but one with
 * a carriage return in the MIDDLE is the shape that matters: `roleTitle` is
 * interpolated into the subject line of the email the send endpoint composes,
 * and CR-LF in the middle of a header is how a second header is smuggled in.
 * Rejecting rather than stripping that one says the stored row is wrong
 * instead of quietly printing something other than what was frozen — and a
 * control character means nothing in a PDF text run in any case.
 */
const CONTROL_CHARACTERS = /[\p{Cc}]/u;

const printable = (max: number) =>
  z.string().trim().min(1).max(max).refine((value) => !CONTROL_CHARACTERS.test(value), {
    message: 'must not contain control characters',
  });

const signature = z.object({
  name: printable(120),
  /** The line under the rule: "Assessed by · subject-matter expert". */
  role: printable(160),
});

const row = z.object({
  /** May carry `**emphasis**` around the names of people involved. */
  what: printable(400),
  /** Already formatted for reading — "22 Sep 2026", or "—" when there is no date. */
  when: printable(40),
});

/**
 * Exactly five rows, never four and never six.
 *
 * The approved design is a fixed frame: the same five-row block on Bronze,
 * Silver and Gold, so that two certificates can be held side by side and read
 * as the same document. A render that quietly dropped or added a row would
 * make one candidate's record look structurally different from another's for
 * no reason a reader could see.
 */
export const awardEvidenceSchema = z.object({
  version: z.literal(1),
  candidateName: printable(200),
  roleTitle: printable(200),
  rows: z.array(row).length(5),
  signatures: z.object({ left: signature, right: signature }),
});

export type AwardEvidence = z.infer<typeof awardEvidenceSchema>;

export class AwardEvidenceError extends Error {
  constructor(readonly awardId: string, readonly detail: string) {
    super(`CandidateAward ${awardId} cannot be rendered: ${detail}`);
    this.name = 'AwardEvidenceError';
  }
}

export function parseAwardEvidence(awardId: string, evidenceJson: string): AwardEvidence {
  let raw: unknown;
  try {
    raw = JSON.parse(evidenceJson);
  } catch {
    throw new AwardEvidenceError(awardId, 'evidenceJson is not valid JSON');
  }
  const parsed = awardEvidenceSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new AwardEvidenceError(awardId, `${first.path.join('.') || 'evidenceJson'} — ${first.message}`);
  }
  return parsed.data;
}

/** The three tiers that carry a certificate. Diamond deliberately does not. */
export const CERTIFICATE_TIERS = ['bronze', 'silver', 'gold'] as const;
export type CertificateTier = (typeof CERTIFICATE_TIERS)[number];

export function hasCertificate(tier: Tier): tier is CertificateTier {
  return (CERTIFICATE_TIERS as readonly string[]).includes(tier);
}

/**
 * Why Diamond has no certificate, in the words a person can act on.
 *
 * A bare 404 here reads as a bug — the award plainly exists, the journey row
 * shows it, and the Badge button beside it works. The refusal has to say that
 * this is a decision rather than a gap.
 */
export const NO_DIAMOND_CERTIFICATE =
  'Diamond has no certificate. The first three tiers record what a candidate did; Diamond records what the hiring team decided, which is the employer’s to announce in their own words. The Diamond badge and the candidate’s journey carry the record instead.';

const TIER_LABEL: Readonly<Record<CertificateTier, string>> = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold' };

/** "Record of assessment · not for release" is Bronze's, and it matters in monochrome. */
export function kickerFor(tier: CertificateTier): string {
  return tier === 'bronze' ? 'Record of assessment · not for release' : 'Record of assessment';
}

export interface ClaimParts {
  readonly lead: string;
  readonly tier: string;
  readonly middle: string;
  readonly role: string;
}

/**
 * The claim line, in fragments so the tier and the role can be set in bold.
 *
 * No organisation name appears anywhere in it. Questor is the only party that
 * can vouch for its own process, and a certificate that carried the employer's
 * name would read as the employer's endorsement of the candidate — which is
 * precisely what the footnote exists to deny.
 */
export function claimFor(tier: CertificateTier, roleTitle: string): ClaimParts {
  return tier === 'bronze'
    ? { lead: 'Reached Questor’s ', tier: TIER_LABEL[tier], middle: ' stage for ', role: roleTitle }
    : { lead: 'Completed Questor’s ', tier: TIER_LABEL[tier], middle: ' assessment for ', role: roleTitle };
}

export const FOOTNOTE = '* Evidence of process, not a recommendation.';
export const BRONZE_FOOTNOTE_SUFFIX = 'Held by the hiring team; not issued to the candidate.';

export function footnoteFor(tier: CertificateTier): string {
  return tier === 'bronze' ? `${FOOTNOTE} ${BRONZE_FOOTNOTE_SUFFIX}` : FOOTNOTE;
}

/**
 * Bronze's left-hand signature is a constant of the design, not data.
 *
 * No human assesses a Bronze, so the slot where an assessor's name would go
 * says "Questor" instead. Taking that name from the frozen evidence would mean
 * a lane that wrote a person's name there — a talent lead who merely pressed
 * the button — would produce a certificate that looked human-reviewed when it
 * was not. The absence of a person is the point of the row, so the render
 * asserts it rather than trusting it.
 *
 * The qualifier beneath still comes from the evidence, because it names the
 * scorecard version that actually read the CV.
 */
export const BRONZE_ASSESSOR_NAME = 'Questor';
export const BRONZE_ASSESSOR_ROLE = 'Assessed by · scorecard v4, no human review';
