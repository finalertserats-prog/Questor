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
 * This is the shape the award lane writes into `CandidateAward.evidenceJson`:
 * `StoredEvidence` in `domain/candidateAwards.ts` is the other end of it, and
 * the two are changed together or not at all. They were not, once — the writer
 * stored rows and nothing else while this demanded a name, a role title and
 * two signatures — and because the only tests of this side fed it JSON a test
 * author had written by hand, every real certificate export answered 500 for
 * months without a single test going red. `awardCertificateRoundTrip.test.ts`
 * is the test that now stands between the two halves.
 *
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
}).strict();

const row = z.object({
  /** May carry `**emphasis**` around the names of people involved. */
  what: printable(400),
  /**
   * The instant the row is about, or null where Questor holds no date.
   *
   * Stored as an instant and formatted at render time, which is the one place
   * this contract deliberately does NOT freeze what is printed. The date is
   * the fact; "22 Sep 2026" is typography. Freezing the typography would put a
   * display string into the journey endpoint's payload, where the client needs
   * a date it can reason about, and would leave certificates struck under an
   * older house style unreproducible. `whenLabel` is the only place it is
   * turned into words.
   */
  when: z.string().datetime().nullable(),
}).strict();

const EM_DASH = '—';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * The date a row prints, or the dash that stands for a fact Questor does not
 * hold.
 *
 * The month names are written out rather than taken from `toLocaleDateString`,
 * which renders September as "Sept" in en-GB under CLDR 42 and later. The
 * approved design prints "Sep", and a certificate whose dates change shape
 * because the Node image was upgraded is a document that cannot be reproduced.
 *
 * UTC, like `issuedOn`, so that the same award reads the same way wherever it
 * is exported from.
 */
export function whenLabel(when: string | null): string {
  if (when === null) return EM_DASH;
  const at = new Date(when);
  // Unreachable through `parseAwardEvidence`, which has already refused
  // anything that is not an instant; kept because this is exported and a
  // renderer must never be handed the string "Invalid Date".
  if (Number.isNaN(at.getTime())) return EM_DASH;
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

/**
 * Exactly five rows, never four and never six.
 *
 * The approved design is a fixed frame: the same five-row block on Bronze,
 * Silver and Gold, so that two certificates can be held side by side and read
 * as the same document. A render that quietly dropped or added a row would
 * make one candidate's record look structurally different from another's for
 * no reason a reader could see. The writer holds up its end — a fact Questor
 * does not have is named as absent rather than dropped — so this stays a
 * demand rather than becoming a tolerance.
 *
 * This is the contract for a record that will be RENDERED, which is why the
 * count is here rather than on the stored column. Diamond stores two rows and
 * is never parsed by this: it carries no certificate, and padding its journey
 * out with three "no record" lines would be inventing a document.
 *
 * ---- Why this and the legacy shape below are both strict
 *
 * Zod objects allow unknown keys by default, and that default is what would
 * let the original defect recur one letter away. A record carrying everything
 * a current one has, wearing `version: 1`, would otherwise parse happily as
 * legacy — silently dropping the name, the title and the signatures it was
 * holding — which is once again a shape that changed while the number did not.
 *
 * Strict makes the two versions genuinely exclusive, and makes adding a field
 * to either of them move the number with it, because the old schema refuses
 * the new shape instead of quietly reading a subset of it.
 */
export const awardEvidenceSchema = z.object({
  version: z.literal(2),
  candidateName: printable(200),
  roleTitle: printable(200),
  rows: z.array(row).length(5),
  signatures: z.object({ left: signature, right: signature }).strict(),
}).strict();

export type AwardEvidence = z.infer<typeof awardEvidenceSchema>;

/** What a strike writes today. Bumped whenever the shape above gains or loses a field. */
export const CURRENT_EVIDENCE_VERSION = 2;

/**
 * What a strike wrote before the name, the title and the signatures were
 * frozen onto it.
 *
 * Version 1 is not a draft or a mistake: it is what every award in the
 * database was written as, and it holds the five evidence rows and nothing
 * that says whose record they are. The number went up rather than the meaning
 * of `1` changing under it, because a reader that cannot tell a valid old
 * record from a corrupt new one has no way to answer either of them properly.
 *
 * `what` is NOT held to `printable` here. The old writer did not clean what it
 * stored, so a legacy row may carry a control character or run long; the
 * upgrade cleans it on the way through, which is a write and therefore the
 * right moment to. See `awardEvidenceBackfill.ts`.
 *
 * ---- Why this one names what it refuses instead of refusing everything
 *
 * The current schema above is strict, and can afford to be: it describes what
 * this build writes, so an unknown field there means a newer writer and the
 * number should have moved. This one describes records written in the past,
 * which nobody can go back and change.
 *
 * Flatly strict here was the first attempt and it is a trap. Any genuine
 * version-1 row that had picked up a field of its own would stop parsing as
 * legacy and start parsing as CORRUPT — skipped by the sweep, uncounted by
 * `countOutstanding`, and refused by the export for ever, with nothing anywhere
 * saying why. Permanent and invisible is the worst pair.
 *
 * So the guard is aimed at what it is actually for. The recurrence this must
 * catch is a current-shaped record wearing the old number, and what makes a
 * record current-shaped is precisely these three fields. Naming them keeps
 * that guard exactly as strong while an unrelated extra is tolerated and
 * simply dropped when the record is rewritten.
 *
 * ---- The five rows, and the one version-1 record that does not have them
 *
 * This demands five rows because it exists to serve the certificate path, and
 * five is the frame. Diamond is also a version-1 record and holds two, so it
 * would be read as corrupt here rather than as old.
 *
 * That is safe because nothing hands a Diamond record to this: the export and
 * the send both refuse Diamond before parsing anything, and the backfill only
 * ever reads awards whose tier carries a certificate. It is safe by that
 * gating and by nothing else, so this is the line that breaks the day a
 * caller parses an award without first asking whether its tier prints one.
 */
const CURRENT_ONLY_FIELDS = ['candidateName', 'roleTitle', 'signatures'] as const;

export const legacyAwardEvidenceSchema = z.object({
  version: z.literal(1),
  rows: z.array(z.object({ what: z.string(), when: z.string().datetime().nullable() })).length(5),
})
  // Passthrough rather than strip, because the refinement below has to be able
  // to SEE a field that should not be there; a stripping parse would have
  // removed it before anything could object.
  .passthrough()
  .superRefine((value, ctx) => {
    for (const field of CURRENT_ONLY_FIELDS) {
      if (field in value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: 'is a version 2 field on a record calling itself version 1',
        });
      }
    }
  });

export type LegacyAwardEvidence = z.infer<typeof legacyAwardEvidenceSchema>;

export type StoredEvidenceRead =
  | { readonly kind: 'current'; readonly evidence: AwardEvidence }
  | { readonly kind: 'legacy'; readonly legacy: LegacyAwardEvidence };

/**
 * A record that is not wrong, only not yet brought up to date.
 *
 * Distinct from `AwardEvidenceError` because the two call for different
 * sentences and different answers. A corrupt record is a fault in the data
 * that nobody can fix by waiting; a version-1 record is a fault in the
 * DEPLOYMENT — the backfill has not run, or could not finish — and it fixes
 * itself the moment it does.
 *
 * Nothing renders one. The certificate could be assembled by resolving the
 * name and the title live, and an earlier draft of this lane did exactly that
 * on the way past a GET; it was wrong. A migration inside a read endpoint
 * hands one reader a document built from live rows while the stored record
 * says something else, and two exports of one reference then disagree. The
 * only content that may leave this building is content derived from one
 * committed record, so a record that has not been migrated is refused and the
 * migration happens at rest.
 */
export class AwardEvidenceNotReadyError extends Error {
  constructor(readonly awardId: string) {
    super(`CandidateAward ${awardId} still holds a version 1 record and has not been backfilled`);
    this.name = 'AwardEvidenceNotReadyError';
  }
}

export class AwardEvidenceError extends Error {
  constructor(readonly awardId: string, readonly detail: string) {
    super(`CandidateAward ${awardId} cannot be rendered: ${detail}`);
    this.name = 'AwardEvidenceError';
  }
}

function refusal(awardId: string, error: z.ZodError): AwardEvidenceError {
  const first = error.issues[0];
  return new AwardEvidenceError(awardId, `${first.path.join('.') || 'evidenceJson'} — ${first.message}`);
}

export function parseAwardEvidence(awardId: string, evidenceJson: string): AwardEvidence {
  let raw: unknown;
  try {
    raw = JSON.parse(evidenceJson);
  } catch {
    throw new AwardEvidenceError(awardId, 'evidenceJson is not valid JSON');
  }
  const parsed = awardEvidenceSchema.safeParse(raw);
  if (!parsed.success) throw refusal(awardId, parsed.error);
  return parsed.data;
}

const versionProbe = z.object({ version: z.number().int() });

/**
 * A stored record, read as whichever version it says it is.
 *
 * The version is read first and then the matching schema is applied, so a
 * refusal names what is actually wrong with THAT shape instead of listing the
 * fields a different version was never supposed to have. A number this build
 * does not know is refused rather than guessed at: a record from a newer
 * writer is not a record this one may reinterpret.
 */
export function parseStoredEvidence(awardId: string, evidenceJson: string): StoredEvidenceRead {
  let raw: unknown;
  try {
    raw = JSON.parse(evidenceJson);
  } catch {
    throw new AwardEvidenceError(awardId, 'evidenceJson is not valid JSON');
  }
  const version = versionProbe.safeParse(raw);
  if (!version.success) throw new AwardEvidenceError(awardId, 'evidenceJson carries no version');

  if (version.data.version === 1) {
    const legacy = legacyAwardEvidenceSchema.safeParse(raw);
    if (!legacy.success) throw refusal(awardId, legacy.error);
    return { kind: 'legacy', legacy: legacy.data };
  }
  if (version.data.version === CURRENT_EVIDENCE_VERSION) {
    const current = awardEvidenceSchema.safeParse(raw);
    if (!current.success) throw refusal(awardId, current.error);
    return { kind: 'current', evidence: current.data };
  }
  throw new AwardEvidenceError(awardId, `evidenceJson is version ${version.data.version}, which this build cannot render`);
}

/**
 * What a certificate is drawn from: the stored record, and nothing assembled
 * on the way past.
 *
 * Pure, and deliberately so — there is no database here, because the moment
 * there is, an export can start issuing a document that the row does not hold.
 */
export function certificateEvidence(awardId: string, evidenceJson: string): AwardEvidence {
  const stored = parseStoredEvidence(awardId, evidenceJson);
  if (stored.kind === 'current') return stored.evidence;
  throw new AwardEvidenceNotReadyError(awardId);
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
 * scorecard version that actually read the CV — `domain/candidateAwards.ts`
 * builds it from the version the fit was measured against. A constant for it
 * used to sit here spelling a fixed "v4"; it was never read, and it would have
 * been wrong on the first role whose scorecard was revised.
 */
export const BRONZE_ASSESSOR_NAME = 'Questor';
