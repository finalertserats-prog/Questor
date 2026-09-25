import { randomInt } from 'node:crypto';
import type { PipelineStage } from './pipelineStages.js';

/**
 * Tier awards: the rules, with no database behind them.
 *
 * ---- The rule that is read backwards
 *
 * A tier is earned when the candidate is promoted OUT of it, never when they
 * arrive in it. Silver is struck by the move to Gold, Gold by the move to
 * Diamond, and Diamond alone is struck by arriving, because there is nowhere
 * further to promote anyone to. One Gold → Diamond promotion therefore earns
 * TWO badges.
 *
 * Bronze is the exception in the other direction: it is earned by the CV being
 * read against an APPROVED scorecard, which no person does, so no promotion
 * ever earns it and `awardedByUserId` stays null on it. A badge struck by a
 * move out of Bronze would carry a person's name on a reading nobody made.
 *
 * The consequence everyone builds wrongly: a candidate whose Silver interview
 * is finished but who has not been progressed has NO Silver badge. Nothing is
 * shown before it is earned.
 */

export const AWARD_TIERS = ['bronze', 'silver', 'gold', 'diamond'] as const;
export type AwardTier = (typeof AWARD_TIERS)[number];

const TIER_SET: ReadonlySet<string> = new Set(AWARD_TIERS);

export function isAwardTier(value: string): value is AwardTier {
  return TIER_SET.has(value);
}

const TIER_CODES: Readonly<Record<AwardTier, string>> = {
  bronze: 'BRZ', silver: 'SLV', gold: 'GLD', diamond: 'DIA',
};

export function tierCode(tier: AwardTier): string {
  return TIER_CODES[tier];
}

export const TIER_LABELS: Readonly<Record<AwardTier, string>> = {
  bronze: 'Bronze', silver: 'Silver', gold: 'Gold', diamond: 'Diamond',
};

/** The three tiers whose award is printed on paper. */
export type CertificateAwardTier = Exclude<AwardTier, 'diamond'>;

/**
 * Diamond records what an employer decided, which is theirs to announce; the
 * other three record what a candidate did.
 *
 * A type guard rather than a plain boolean, so that everything which exists
 * only because a certificate is printed — the candidate's name, the role's
 * title, the two signatures — is unreachable for Diamond by construction
 * instead of by everyone remembering.
 */
export function tierHasCertificate(tier: AwardTier): tier is CertificateAwardTier {
  return tier !== 'diamond';
}

/**
 * The tiers a single move from `fromKey` to `toKey` earns, in the order they
 * should be struck.
 *
 * Two independent earnings, which is why one promotion can return two tiers:
 *   - the tier being left, when it is Silver or Gold;
 *   - Diamond, when the move arrives there.
 *
 * A finalisation that carries a candidate straight from Silver to Diamond
 * therefore earns Silver and Diamond and NOT Gold: nobody ever interviewed
 * them at Gold, and a Gold certificate would claim rounds that never happened.
 *
 * Stage plans are configurable per role, so a plan using none of the tier keys
 * earns nothing — the same way an event finds no stage of its kind.
 */
export function awardsForPromotion(stages: readonly PipelineStage[], fromKey: string, toKey: string): AwardTier[] {
  const fromIndex = stages.findIndex((stage) => stage.key === fromKey);
  const toIndex = stages.findIndex((stage) => stage.key === toKey);
  if (fromIndex < 0 || toIndex <= fromIndex) return [];

  const earned: AwardTier[] = [];
  if (fromKey === 'silver' || fromKey === 'gold') earned.push(fromKey);
  if (toKey === 'diamond') earned.push('diamond');
  return earned;
}

/** Why a tier is not on the journey yet, said as the move that will earn it. */
export function unearnedReason(stages: readonly PipelineStage[], tier: AwardTier): string {
  if (tier === 'bronze') return 'Awarded when the CV is read against an approved scorecard';
  // Diamond is the one tier earned by arriving, so it names its own stage
  // rather than the one after it.
  if (tier === 'diamond') return `Awarded when they move to ${TIER_LABELS.diamond}`;
  const index = stages.findIndex((stage) => stage.key === tier);
  const next = index >= 0 ? stages[index + 1] : undefined;
  // "they", never "she" or "he". Questor holds a candidate's name and nothing
  // that says how they should be referred to, and inferring it from a name is
  // exactly the reading this product must not make.
  return `Awarded when they move to ${next?.label ?? TIER_LABELS.diamond}`;
}

/**
 * The tiers a candidate's journey shows: every tier they have earned, and the
 * one they are sitting at right now if they have not earned it yet.
 *
 * Not the whole ladder, and not everything behind them either.
 *
 * A candidate at Silver is shown Bronze and Silver — their Silver interview may
 * already have happened, and the row says why the badge is not there yet — but
 * not a dashed Gold and a dashed Diamond, which read as a promise nobody has
 * made them.
 *
 * Nor a tier they were carried past. A finalisation from Silver puts a
 * candidate at Diamond having earned Silver and Diamond and never Gold; showing
 * a dashed Gold there offered them "Awarded when they move to Diamond" for a
 * move they had already made, which is a row that can never come true.
 *
 * An award for a tier past the current stage is still shown. It should not
 * happen, and if it ever does, hiding it would be the worse failure: the badge
 * exists and something has to account for it.
 */
export function journeyTiers(
  stages: readonly PipelineStage[], currentStageKey: string, earned: readonly AwardTier[],
): AwardTier[] {
  const earnedSet = new Set(earned);
  return AWARD_TIERS.filter((tier) => earnedSet.has(tier) || tier === currentStageKey);
}

/** The one line the journey row leads with, read off the frozen evidence rather than the database. */
export function awardHeadline(tier: AwardTier, rows: readonly { readonly what: string }[]): string {
  if (tier === 'diamond') return 'The hiring team decided: ready to join';
  // Bronze leads with the reading itself; the other two lead with the move
  // that earned them, which is the last row on the certificate.
  const row = tier === 'bronze' ? rows[1] : rows[rows.length - 1];
  return row?.what ?? '';
}

// ---------------------------------------------------------------------------
// The printed reference
// ---------------------------------------------------------------------------

/**
 * No 0/O and no 1/I/L: a reference is printed on a certificate and then read
 * aloud or typed back by someone who is holding the paper, and the pairs above
 * are the ones they get wrong.
 */
const REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export interface ReferenceBlocks {
  readonly block: string;
  readonly digits: string;
}

export function referenceBlocks(): ReferenceBlocks {
  let block = '';
  for (let i = 0; i < 4; i++) block += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return { block, digits: String(randomInt(10_000)).padStart(4, '0') };
}

/** `QS-SLV-8F2K-4471`, as the certificate prints it. */
export function formatReference(tier: AwardTier, block: string, digits: string): string {
  return `QS-${tierCode(tier)}-${block}-${digits}`;
}

// ---------------------------------------------------------------------------
// The evidence, frozen at award time
// ---------------------------------------------------------------------------

export interface AwardEvidenceRow {
  /** What happened, in one line. */
  readonly what: string;
  /** When, or null where Questor holds no date — printed as a dash. */
  readonly when: Date | null;
}

export interface AwardHumanRound {
  readonly completedAt: Date;
  readonly minutes: number | null;
  readonly interviewers: readonly string[];
}

/** Everything the evidence rows are built from, read once, just before the award is written. */
export interface AwardFacts {
  readonly awardedAt: Date;
  /**
   * The candidate's name and the role's title as they stood at this moment.
   *
   * Frozen rather than looked up when the certificate is rendered. A role
   * renamed or a name corrected six months later must not silently rewrite a
   * document somebody has already filed, and a certificate has to stay
   * renderable after the rows it was derived from are gone — which is the
   * whole reason `evidenceJson` exists. The cost is that the award carries
   * personal data of its own, which is why erasing a candidate deletes their
   * awards outright rather than blanking the rows behind them.
   */
  readonly candidateName: string;
  readonly roleTitle: string;
  readonly candidateCreatedAt: Date | null;
  readonly profile: {
    readonly readAt: Date;
    readonly scorecardVersion: number | null;
    readonly competenciesEvidenced: number;
    readonly competenciesTotal: number;
  } | null;
  readonly aiInterview: {
    readonly completedAt: Date;
    readonly minutes: number | null;
    readonly competencies: number;
    readonly quotedEvidence: boolean;
  } | null;
  readonly humanReview: { readonly at: Date; readonly reviewerName: string } | null;
  readonly humanRounds: readonly AwardHumanRound[];
  /** When the tier below this one was struck, where there is one. */
  readonly priorAwardAt: Date | null;
  /** The stage this promotion moved them to; empty for Bronze, which no promotion earns. */
  readonly promotedTo: string;
  /** The person who moved them; empty for Bronze. */
  readonly promotedByName: string;
  /**
   * The person whose act this award rides on, for the right-hand signature:
   * the one who promoted the candidate, or on Bronze the one who put the CV
   * into Questor. Empty when Questor holds no name for them.
   *
   * "Recorded by", never "assessed by". Bronze's `awardedByUserId` stays null
   * because nobody assessed it, and this is the other half of that sentence —
   * somebody did record the application, and naming them under a line that
   * says what they actually did claims nothing about the reading.
   */
  readonly recordedByName: string;
}

const MISSING = (what: string): AwardEvidenceRow => ({ what, when: null });

function scorecardRow(facts: AwardFacts): AwardEvidenceRow {
  if (!facts.profile) return MISSING('The CV was not read against an approved scorecard');
  const version = facts.profile.scorecardVersion;
  return {
    what: version === null
      ? 'CV read against the approved scorecard'
      : `CV read against the approved scorecard, version ${version}`,
    when: facts.profile.readAt,
  };
}

function progressedRow(facts: AwardFacts): AwardEvidenceRow {
  if (!facts.promotedTo || !facts.promotedByName) return MISSING('Progressed by a member of the hiring team');
  return { what: `Progressed to ${facts.promotedTo} by ${facts.promotedByName}`, when: facts.awardedAt };
}

function bronzeRows(facts: AwardFacts): AwardEvidenceRow[] {
  const profile = facts.profile;
  const evidenced = profile
    ? `${profile.competenciesEvidenced} of ${profile.competenciesTotal} competencies evidenced; ${Math.max(profile.competenciesTotal - profile.competenciesEvidenced, 0)} not addressed`
    : 'No competency reading is on record';
  return [
    facts.candidateCreatedAt
      ? { what: 'Application received; identity confirmed', when: facts.candidateCreatedAt }
      : MISSING('Application received'),
    scorecardRow(facts),
    { what: evidenced, when: profile?.readAt ?? null },
    // The absence of a person is the fact this row exists to record. It is on
    // the certificate as text because the Bronze watermark disappears in a
    // black-and-white print, and a reader must not be able to mistake an
    // automated reading for an assessed one.
    { what: 'Profile matched to the role by Questor, no human assessment', when: profile?.readAt ?? null },
    MISSING('No interview has taken place at this stage'),
  ];
}

function silverRows(facts: AwardFacts): AwardEvidenceRow[] {
  const ai = facts.aiInterview;
  return [
    scorecardRow(facts),
    ai
      ? {
          what: `Structured interview completed — ${ai.minutes === null ? 'duration not recorded' : `${ai.minutes} minutes`}, ${ai.competencies} competencies`,
          when: ai.completedAt,
        }
      : MISSING('No completed AI interview is on record'),
    ai && ai.quotedEvidence
      ? { what: 'Every rating carries a verbatim quote from the transcript', when: ai.completedAt }
      : MISSING('Not every rating carries a verbatim quote from the transcript'),
    facts.humanReview
      ? { what: `Assessed by ${facts.humanReview.reviewerName}, subject-matter expert`, when: facts.humanReview.at }
      : MISSING('No subject-matter expert review is on record'),
    progressedRow(facts),
  ];
}

function roundRow(round: AwardHumanRound): AwardEvidenceRow {
  const by = round.interviewers.length > 0 ? ` conducted by ${round.interviewers.join(' and ')}` : '';
  const length = round.minutes === null ? '' : ` — ${round.minutes} minutes`;
  return { what: `Interview${by}${length}, transcript on record`, when: round.completedAt };
}

function goldRows(facts: AwardFacts): AwardEvidenceRow[] {
  const rounds = facts.humanRounds;
  // Two slots, because the certificate holds exactly five rows and the other
  // three are spoken for. Rounds are named one by one rather than counted:
  // "two rounds" tells a reader less than the two dates do. Past two there is
  // no room, and summarising the remainder loses less than dropping it.
  const first = rounds[0] ? roundRow(rounds[0]) : MISSING('No completed interview round is on record for this stage');
  const second = rounds.length > 2
    ? { what: `${rounds.length - 1} further rounds conducted, each with a transcript on record`, when: rounds[rounds.length - 1].completedAt }
    : rounds[1] ? roundRow(rounds[1]) : MISSING('No further interview round is on record');
  const lastRound = rounds[rounds.length - 1] ?? null;
  return [
    facts.priorAwardAt
      ? { what: 'Silver assessment completed and progressed', when: facts.priorAwardAt }
      : MISSING('No Silver award precedes this one'),
    first,
    second,
    lastRound
      ? { what: 'Written up and assessed against the same scorecard', when: lastRound.completedAt }
      : MISSING('No written-up assessment is on record for this stage'),
    progressedRow(facts),
  ];
}

function diamondRows(facts: AwardFacts): AwardEvidenceRow[] {
  // Diamond has no certificate, so these rows are not laid out on paper; they
  // are the journey's record of the decision, and they are frozen for the same
  // reason as the rest — see `awardEvidence`.
  return [
    facts.priorAwardAt
      ? { what: 'Gold assessment completed and progressed', when: facts.priorAwardAt }
      : MISSING('No Gold award precedes this one'),
    progressedRow(facts),
  ];
}

/**
 * The evidence rows for an award, built ONCE from facts read at the moment it
 * is struck and then stored verbatim.
 *
 * Never re-derived on a read. A certificate states what was true when it was
 * struck; re-reading the database later would silently rewrite history — a
 * re-scored CV, a corrected competency or a deleted round would change what a
 * certificate issued months earlier claims, with nobody able to see that it
 * had changed. Same reasoning as CandidateFeedbackEmail.optInAsked.
 *
 * Bronze, Silver and Gold return exactly five rows, which is the certificate's
 * fixed structure. A fact Questor does not hold is named as absent rather than
 * dropped: five rows with one saying "no review is on record" is honest, and
 * four rows silently means the same thing while reading as a complete record.
 */
export function awardEvidence(tier: AwardTier, facts: AwardFacts): AwardEvidenceRow[] {
  switch (tier) {
    case 'bronze': return bronzeRows(facts);
    case 'silver': return silverRows(facts);
    case 'gold': return goldRows(facts);
    case 'diamond': return diamondRows(facts);
    default: {
      const unreachable: never = tier;
      throw new Error(`Unknown award tier: ${String(unreachable)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// The two signatures
// ---------------------------------------------------------------------------

export interface AwardSignature {
  readonly name: string;
  /** The line under the rule: "Assessed by · subject-matter expert". */
  readonly role: string;
}

/** Left is who assessed; right is who recorded. Both are always present. */
export interface AwardSignatures {
  readonly left: AwardSignature;
  readonly right: AwardSignature;
}

/**
 * The name a slot carries when no person belongs in it.
 *
 * Bronze's assessor slot is the original case: no human assesses a Bronze, so
 * the name says Questor and the line beneath says what stood in for a person.
 * Every other gap is answered the same way — a Silver struck before a
 * subject-matter expert read the assessment, a Gold whose rounds are not on
 * record. The two wrong answers are a blank, which a reader fills in
 * themselves, and the nearest available name, which would put the talent lead
 * who pressed the button under "assessed by".
 */
const UNATTRIBUTED = 'Questor';

const ASSESSED_BY_SME = 'Assessed by · subject-matter expert';
const RECORDED_BY_TEAM = 'Recorded by · the hiring team';

function assessorOf(tier: CertificateAwardTier, facts: AwardFacts): AwardSignature {
  switch (tier) {
    case 'bronze': {
      const version = facts.profile?.scorecardVersion ?? null;
      // The qualifier names the scorecard version that actually read the CV,
      // so the claim is checkable against a specific artefact rather than
      // against "the scorecard", which changes.
      return {
        name: UNATTRIBUTED,
        role: version === null
          ? 'Assessed by · approved scorecard, no human review'
          : `Assessed by · scorecard v${version}, no human review`,
      };
    }
    case 'silver':
      return facts.humanReview
        ? { name: facts.humanReview.reviewerName, role: ASSESSED_BY_SME }
        : { name: UNATTRIBUTED, role: 'Assessed by · structured interview, no human review' };
    case 'gold': {
      // The first round's interviewer, matching the first interview row. Where
      // two people conducted it the row names both and the signature names the
      // first, because a signature block is one name over one rule.
      const first = facts.humanRounds[0]?.interviewers[0] ?? '';
      return first
        ? { name: first, role: ASSESSED_BY_SME }
        : { name: UNATTRIBUTED, role: 'Assessed by · no interview round on record' };
    }
    default: {
      const unreachable: never = tier;
      throw new Error(`Unknown award tier: ${String(unreachable)}`);
    }
  }
}

function recorderOf(facts: AwardFacts): AwardSignature {
  return facts.recordedByName.trim()
    ? { name: facts.recordedByName, role: RECORDED_BY_TEAM }
    : { name: UNATTRIBUTED, role: 'Recorded by · no person on record' };
}

// ---------------------------------------------------------------------------
// The stored shape
// ---------------------------------------------------------------------------

/**
 * The stored shape, at version 2.
 *
 * Versioned so that a certificate struck under an older layout still renders,
 * and the number is part of the contract rather than decoration. Version 1 —
 * `{ version, rows }`, no name, no title, no signatures — is what every award
 * in the database was written as before this shape existed, and
 * `services/awardEvidenceBackfill.ts` is what reaches those, as a sweep at rest.
 *
 * The number goes up whenever a field is added or removed. Leaving it at 1
 * while the required fields changed would mean the reader could not tell a
 * valid old record from a corrupt new one, and would answer both the same
 * way — which is what happened, and is why every existing award answered 500.
 *
 * This is the whole of what `services/awardEvidence.ts` reads back, and the
 * two must be changed together. They were not, once: the writer stored rows
 * while the reader required a name, a role title and two signatures nothing in
 * the repository ever wrote, and it went unnoticed for as long as the only
 * tests of the reader fed it JSON a test author had typed out by hand.
 */
export interface StoredEvidenceRow {
  readonly what: string;
  /** An instant, or null where Questor holds no date. Formatted for reading at render time. */
  readonly when: string | null;
}

export interface StoredEvidence {
  readonly version: 2;
  readonly candidateName: string;
  readonly roleTitle: string;
  readonly rows: readonly StoredEvidenceRow[];
  readonly signatures: AwardSignatures;
}

/**
 * Version 1: the rows, and nothing saying whose record they are.
 *
 * Not only a shape from the past, which is why it is not called a legacy one.
 * The version describes the CONTENT rather than the era — version 1 is the
 * rows alone, version 2 is the rows plus everything a certificate prints — so
 * a tier that prints no certificate is a version-1 record by nature rather
 * than by age.
 *
 * Two kinds of record hold it, and the distinction matters when reading the
 * backfill: awards struck before a certificate's record carried a name, which
 * are migrated, and Diamond, which is not and never will be.
 */
export interface RowsOnlyEvidence {
  readonly version: 1;
  readonly rows: readonly StoredEvidenceRow[];
}

/**
 * A value made printable at the moment it is frozen, rather than at the moment
 * somebody tries to print it.
 *
 * The reader refuses a control character outright, because `roleTitle` is
 * interpolated into the subject line of the email the send endpoint composes
 * and a carriage return in the middle of a header is how a second header is
 * smuggled in. That refusal is the right answer for a row already in the
 * database. It is the wrong moment to discover the problem for a row being
 * written — a promotion would roll back over a stray tab in a job title — so
 * the writer cleans here and the reader's refusal stays the backstop it was
 * meant to be.
 */
function printable(value: string, max: number, whenEmpty: string): string {
  const cleaned = value.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, max).trim() || whenEmpty;
}

/**
 * Limits taken from the reader's schema. A name or a title long enough to
 * overflow one is truncated rather than refused, for the same reason as above:
 * the alternative is a stage move that fails over a job title somebody pasted
 * a paragraph into.
 */
const MAX = { name: 120, signatureRole: 160, person: 200, row: 400 } as const;

/**
 * Nothing sensible to print, which the database's own constraints should make
 * unreachable — `Candidate.fullName` and `Role.title` are both required. The
 * placeholder exists so that a row which somehow got past them still produces
 * a certificate that says what is missing, rather than one that cannot be
 * produced at all.
 */
const NAME_ABSENT = 'Name not on record';
const ROLE_ABSENT = 'Role not on record';

function signaturesFor(tier: CertificateAwardTier, facts: AwardFacts): AwardSignatures {
  const clean = (signature: AwardSignature): AwardSignature => ({
    name: printable(signature.name, MAX.name, UNATTRIBUTED),
    role: printable(signature.role, MAX.signatureRole, RECORDED_BY_TEAM),
  });
  return { left: clean(assessorOf(tier, facts)), right: clean(recorderOf(facts)) };
}

/**
 * Everything a certificate for this award is allowed to say, built once from
 * facts read at the moment it is struck.
 *
 * One function, taking the tier and the facts, so that there is no way to
 * assemble a partial record: a caller cannot write rows and forget the name,
 * which is exactly how the two halves of this contract drifted apart.
 */
export function buildEvidence(tier: AwardTier, facts: AwardFacts): StoredEvidence | RowsOnlyEvidence {
  const rows = awardEvidence(tier, facts).map((row) => ({
    what: printable(row.what, MAX.row, 'Not on record'),
    when: row.when ? row.when.toISOString() : null,
  }));

  // Diamond keeps the rows and nothing else. Nothing renders its record — it
  // carries no certificate, and the journey reads only the rows — so a name
  // frozen here would be personal data stored for nothing to print, which is
  // the one thing that cannot be justified by the argument for freezing a name
  // at all. `awardEvidenceBackfill.ts` refuses to add one for the same reason;
  // writing one here would have had the writer doing hourly what the sweep
  // exists to decline.
  if (!tierHasCertificate(tier)) return { version: 1, rows };

  return {
    version: 2,
    candidateName: printable(facts.candidateName, MAX.person, NAME_ABSENT),
    roleTitle: printable(facts.roleTitle, MAX.person, ROLE_ABSENT),
    rows,
    signatures: signaturesFor(tier, facts),
  };
}

/**
 * What a version-1 record can honestly be turned into.
 *
 * It holds the five evidence rows — the substance of the certificate, and the
 * only part that was ever frozen — and nothing that says whose record they
 * are. Two different things are therefore done with the two gaps, and the
 * difference is the whole argument:
 *
 * The name and the title are RESOLVED. `candidateId` and `roleId` have always
 * been on the award, so the person and the role were never ambiguous; what was
 * never written down is the spelling they had at the time. Following a pointer
 * that was frozen is not re-deriving a claim. It does mean today's spelling is
 * used, and the cost of that is bounded by the fact that no certificate for a
 * version-1 award has ever been issued — every export of one answered 500 —
 * so there is no earlier document for it to contradict.
 *
 * The signatures are NOT reconstructed. Who assessed a candidate is a claim
 * about what happened, and reading it out of today's rows is exactly the
 * history-rewriting `evidenceJson` exists to prevent: a review added or
 * removed since would change what a certificate asserts about the past. The
 * slots say so, in the same form used everywhere else a person is absent.
 *
 * The rows themselves are copied across untouched but for the cleaning every
 * stored value gets, because the old writer did none.
 */
export function upgradeLegacyEvidence(o: {
  readonly legacy: RowsOnlyEvidence;
  readonly candidateName: string;
  readonly roleTitle: string;
}): StoredEvidence {
  return {
    version: 2,
    candidateName: printable(o.candidateName, MAX.person, NAME_ABSENT),
    roleTitle: printable(o.roleTitle, MAX.person, ROLE_ABSENT),
    rows: o.legacy.rows.map((row) => ({
      what: printable(row.what, MAX.row, 'Not on record'),
      when: row.when,
    })),
    signatures: {
      left: { name: UNATTRIBUTED, role: 'Assessed by · not recorded on this award' },
      right: { name: UNATTRIBUTED, role: 'Recorded by · not named on this award' },
    },
  };
}

export function serialiseEvidence(tier: AwardTier, facts: AwardFacts): string {
  return JSON.stringify(buildEvidence(tier, facts));
}
