import { describe, it, expect } from 'vitest';
import {
  AWARD_TIERS, awardsForPromotion, formatReference, referenceBlocks,
  awardEvidence, serialiseEvidence, upgradeLegacyEvidence, unearnedReason, tierCode, journeyTiers, awardHeadline,
  type AwardFacts, type LegacyStoredEvidence,
} from '../src/domain/candidateAwards.js';
import {
  awardEvidenceSchema, CERTIFICATE_TIERS, CURRENT_EVIDENCE_VERSION, legacyAwardEvidenceSchema,
  parseStoredEvidence, whenLabel,
} from '../src/services/awardEvidence.js';
import { DEFAULT_STAGES } from '../src/domain/pipelineStages.js';

/**
 * The rule everybody gets backwards: a tier is earned when the candidate is
 * promoted OUT of it, never when they arrive in it. Silver is struck by the
 * move to Gold, Gold by the move to Diamond, and Diamond alone is struck by
 * arriving — because there is nowhere further to be promoted to.
 *
 * These are the rules on their own, with no database behind them. Every case
 * below was reachable in a draft where "awarded at Silver" read as "awarded on
 * entering Silver", which showed a candidate a badge for an interview nobody
 * had acted on.
 */

const stages = DEFAULT_STAGES;

describe('which tiers a promotion earns', () => {
  it('earns Silver when the candidate is moved from Silver to Gold', () => {
    expect(awardsForPromotion(stages, 'silver', 'gold')).toEqual(['silver']);
  });

  it('earns both Gold and Diamond on the single move from Gold to Diamond', () => {
    expect(awardsForPromotion(stages, 'gold', 'diamond')).toEqual(['gold', 'diamond']);
  });

  it('earns nothing for the move into Silver', () => {
    expect(awardsForPromotion(stages, 'bronze', 'silver')).toEqual([]);
  });

  it('earns nothing for the move into Bronze', () => {
    expect(awardsForPromotion(stages, 'participation', 'bronze')).toEqual([]);
  });

  it('never earns Bronze by promotion, because no person assessed it', () => {
    const everyMove = stages.flatMap((from) => stages.map((to) => awardsForPromotion(stages, from.key, to.key)));
    expect(everyMove.flat()).not.toContain('bronze');
  });

  it('skips Gold when a finalisation carries the candidate straight past it', () => {
    expect(awardsForPromotion(stages, 'silver', 'diamond')).toEqual(['silver', 'diamond']);
  });

  it('earns nothing when the move goes backwards', () => {
    expect(awardsForPromotion(stages, 'gold', 'silver')).toEqual([]);
  });

  it('earns nothing when the move goes nowhere', () => {
    expect(awardsForPromotion(stages, 'gold', 'gold')).toEqual([]);
  });

  it('earns nothing in a stage plan that uses none of the tier keys', () => {
    const custom = [
      { key: 'intake', label: 'Intake', kind: 'intake' as const },
      { key: 'screen', label: 'Screen', kind: 'profile_review' as const },
      { key: 'offer', label: 'Offer', kind: 'human_interview' as const },
    ];
    expect(awardsForPromotion(custom, 'screen', 'offer')).toEqual([]);
  });
});

describe('which tiers the journey shows', () => {
  it('shows a candidate at Bronze only Bronze and the Silver they are working towards', () => {
    expect(journeyTiers(stages, 'silver', ['bronze'])).toEqual(['bronze', 'silver']);
  });

  it('does not tease a dashed Gold and Diamond at a candidate who is nowhere near them', () => {
    expect(journeyTiers(stages, 'bronze', ['bronze'])).not.toContain('gold');
  });

  it('shows the whole ladder once the candidate has reached Diamond', () => {
    expect(journeyTiers(stages, 'diamond', ['bronze', 'silver', 'gold', 'diamond'])).toEqual(AWARD_TIERS.slice());
  });

  it('shows a tier that was somehow awarded past the current stage rather than hiding the badge', () => {
    expect(journeyTiers(stages, 'bronze', ['bronze', 'gold'])).toEqual(['bronze', 'gold']);
  });

  it('shows nothing at all before a candidate has left Participation', () => {
    expect(journeyTiers(stages, 'participation', [])).toEqual([]);
  });

  // A finalisation from Silver earns Silver and Diamond and never Gold. A
  // dashed Gold row would offer "Awarded when they move to Diamond" to someone
  // who has already made that move: a promise that can never come true.
  it('does not offer a tier the candidate was carried straight past', () => {
    expect(journeyTiers(stages, 'diamond', ['silver', 'diamond'])).toEqual(['silver', 'diamond']);
  });

  it('does not keep offering Bronze to a candidate who is already past it', () => {
    expect(journeyTiers(stages, 'gold', ['silver'])).toEqual(['silver', 'gold']);
  });
});

describe('the line a journey row leads with', () => {
  const rows = [{ what: 'first' }, { what: 'second' }, { what: 'third' }, { what: 'fourth' }, { what: 'Progressed to Gold by Rahul Menon' }];

  it('leads a Bronze row with the reading itself', () => {
    expect(awardHeadline('bronze', rows)).toBe('second');
  });

  it('leads a Silver row with the move that earned it', () => {
    expect(awardHeadline('silver', rows)).toBe('Progressed to Gold by Rahul Menon');
  });

  it('leads a Diamond row with the decision, which is what Diamond records', () => {
    expect(awardHeadline('diamond', rows)).toBe('The hiring team decided: ready to join');
  });

  it('says nothing rather than crashing on evidence it cannot read', () => {
    expect(awardHeadline('gold', [])).toBe('');
  });
});

describe('the printed reference', () => {
  it('prints in the form the certificate shows', () => {
    expect(formatReference('silver', '8F2K', '4471')).toBe('QS-SLV-8F2K-4471');
  });

  it('gives each tier its own three-letter code', () => {
    const codes = AWARD_TIERS.map(tierCode);
    expect(codes).toEqual(['BRZ', 'SLV', 'GLD', 'DIA']);
    expect(new Set(codes).size).toBe(AWARD_TIERS.length);
  });

  it('draws blocks from an alphabet with no character that can be misread', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const { block, digits } = referenceBlocks();
      seen.add(block);
      expect(block).toMatch(/^[2-9A-HJ-NP-Z]{4}$/);
      expect(digits).toMatch(/^[0-9]{4}$/);
    }
    // Reading a reference aloud off a printed certificate is the point of the
    // restricted alphabet; near-duplicate references would defeat it.
    expect(seen.size).toBeGreaterThan(390);
  });
});

describe('the reason an unearned tier is not there yet', () => {
  it('names the move that will earn Silver', () => {
    expect(unearnedReason(stages, 'silver')).toBe('Awarded when they move to Gold');
  });

  it('names the move that will earn Gold', () => {
    expect(unearnedReason(stages, 'gold')).toBe('Awarded when they move to Diamond');
  });

  it('says what earns Bronze, which no promotion does', () => {
    expect(unearnedReason(stages, 'bronze')).toBe('Awarded when the CV is read against an approved scorecard');
  });

  it('says what earns Diamond, which arriving does', () => {
    expect(unearnedReason(stages, 'diamond')).toBe('Awarded when they move to Diamond');
  });
});

const facts: AwardFacts = {
  awardedAt: new Date('2026-09-24T09:00:00Z'),
  candidateName: 'Priya Sharma',
  roleTitle: 'Senior Marketing Manager',
  recordedByName: 'Rahul Menon',
  candidateCreatedAt: new Date('2026-09-20T09:00:00Z'),
  profile: { readAt: new Date('2026-09-21T09:00:00Z'), scorecardVersion: 4, competenciesEvidenced: 8, competenciesTotal: 10 },
  aiInterview: { completedAt: new Date('2026-09-22T09:00:00Z'), minutes: 24, competencies: 10, quotedEvidence: true },
  humanReview: { at: new Date('2026-09-23T09:00:00Z'), reviewerName: 'Aparna Rao' },
  humanRounds: [
    { completedAt: new Date('2026-09-27T09:00:00Z'), minutes: 48, interviewers: ['Aparna Rao'] },
    { completedAt: new Date('2026-09-30T09:00:00Z'), minutes: 40, interviewers: ['Devika Iyer'] },
  ],
  priorAwardAt: new Date('2026-09-24T09:00:00Z'),
  promotedTo: 'Diamond',
  promotedByName: 'Rahul Menon',
};

describe('the evidence frozen onto an award', () => {
  it.each(['bronze', 'silver', 'gold'] as const)('gives %s exactly five rows, as the certificate lays out', (tier) => {
    expect(awardEvidence(tier, facts)).toHaveLength(5);
  });

  it('says on a Bronze award that no person assessed it', () => {
    const rows = awardEvidence('bronze', facts).map((r) => r.what);
    expect(rows.some((r) => r.includes('no human assessment'))).toBe(true);
  });

  it('says on a Bronze award that no interview has happened', () => {
    expect(awardEvidence('bronze', facts)[4]).toEqual({ what: 'No interview has taken place at this stage', when: null });
  });

  it('names the scorecard version the CV was read against', () => {
    expect(awardEvidence('bronze', facts)[1].what).toBe('CV read against the approved scorecard, version 4');
  });

  it('names who progressed the candidate on a Silver award', () => {
    expect(awardEvidence('silver', facts)[4].what).toBe('Progressed to Diamond by Rahul Menon');
  });

  it('lists each human round separately on a Gold award, not a count of them', () => {
    const rows = awardEvidence('gold', facts).map((r) => r.what);
    expect(rows[1]).toContain('Aparna Rao');
    expect(rows[2]).toContain('Devika Iyer');
  });

  it('names what is missing rather than dropping the row', () => {
    const thin: AwardFacts = { ...facts, humanRounds: [], humanReview: null, aiInterview: null };
    const rows = awardEvidence('gold', thin);
    expect(rows).toHaveLength(5);
    expect(rows[1]).toEqual({ what: 'No completed interview round is on record for this stage', when: null });
  });

  it('holds only dates it has, and says so with a dash where it has none', () => {
    const thin: AwardFacts = { ...facts, profile: null, aiInterview: null, humanReview: null, humanRounds: [] };
    for (const tier of AWARD_TIERS) {
      for (const row of awardEvidence(tier, thin)) {
        expect(typeof row.what).toBe('string');
        expect(row.what.length).toBeGreaterThan(0);
        expect(row.when === null || row.when instanceof Date).toBe(true);
      }
    }
  });
});

/**
 * The writer, checked against the reader that has to render what it wrote.
 *
 * The two halves of this contract drifted apart once and nothing caught it:
 * the writer stored rows and nothing else, the reader demanded a name, a role
 * title and two signatures, and every certificate export answered 500 for
 * months. What each side was tested against was the other side's absence.
 *
 * So the writer's output is fed to the reader's schema here, on facts rich
 * enough and facts thin enough, for every tier that carries a certificate.
 * `awardCertificateRoundTrip.test.ts` does the same through HTTP; this does it
 * across the permutations of missing facts that no single journey produces.
 */
describe('the writer and the reader, held against each other', () => {
  const accepted = (tier: 'bronze' | 'silver' | 'gold', from: AwardFacts) =>
    awardEvidenceSchema.safeParse(JSON.parse(serialiseEvidence(tier, from)));

  it.each(CERTIFICATE_TIERS)('writes a %s record the certificate reader accepts', (tier) => {
    expect(accepted(tier, facts).success).toBe(true);
  });

  // The honest failure mode: a tier struck for a candidate whose journey has
  // gaps. Nothing here may be dropped, because a dropped field is a 500 at the
  // moment somebody presses Certificate and not before.
  it.each(CERTIFICATE_TIERS)('writes a %s record the reader accepts when Questor holds almost nothing', (tier) => {
    const thin: AwardFacts = {
      ...facts, profile: null, aiInterview: null, humanReview: null, humanRounds: [],
      priorAwardAt: null, promotedTo: '', promotedByName: '', recordedByName: '',
    };

    expect(accepted(tier, thin).success).toBe(true);
  });

  it.each(CERTIFICATE_TIERS)('still signs both slots on a %s nobody is named on', (tier) => {
    const thin: AwardFacts = { ...facts, humanReview: null, humanRounds: [], recordedByName: '' };

    const parsed = accepted(tier, thin);

    // "Questor", never a blank a reader fills in themselves and never the
    // nearest available name, which would put somebody under "assessed by"
    // for a reading they did not make.
    expect(parsed.success && [parsed.data.signatures.left.name, parsed.data.signatures.right.name])
      .toEqual(['Questor', 'Questor']);
  });

  it('prints a name and a role even when the rows behind them are blank', () => {
    const nameless: AwardFacts = { ...facts, candidateName: '', roleTitle: '   ' };

    const parsed = accepted('silver', nameless);

    expect(parsed.success && [parsed.data.candidateName, parsed.data.roleTitle])
      .toEqual(['Name not on record', 'Role not on record']);
  });

  /**
   * `roleTitle` is interpolated into the subject line of the email the send
   * endpoint composes, and a carriage return there is how a second header is
   * smuggled in. The reader refuses one outright; the writer must never hand
   * it one, or a promotion would roll back over a pasted job title.
   */
  it('strips a control character out of a role title instead of storing one', () => {
    const smuggled: AwardFacts = { ...facts, roleTitle: 'Senior Marketing Manager\r\nBcc: someone@elsewhere.test' };

    const parsed = accepted('silver', smuggled);

    expect(parsed.success && parsed.data.roleTitle).toBe('Senior Marketing Manager Bcc: someone@elsewhere.test');
  });

  it('truncates a name too long for the certificate rather than refusing the award', () => {
    const shouted: AwardFacts = { ...facts, candidateName: 'A'.repeat(500) };

    expect(accepted('silver', shouted).success).toBe(true);
  });
});

/**
 * The number on the record, which is the part that was got wrong.
 *
 * The stored shape changed while the version stayed at 1, so the reader could
 * not tell a valid old record from a corrupt new one and answered both with a
 * 500. These pin the thing that stops it happening again: the two versions
 * must be mutually exclusive, so that a schema which accepts a record is also
 * a schema that can render it.
 */
describe('telling one stored version from another', () => {
  const legacyOf = (tier: 'bronze' | 'silver' | 'gold'): LegacyStoredEvidence => ({
    version: 1,
    rows: awardEvidence(tier, facts).map((row) => ({ what: row.what, when: row.when ? row.when.toISOString() : null })),
  });

  it('stamps what it writes with the version this build reads', () => {
    const written = JSON.parse(serialiseEvidence('silver', facts)) as { version: number };

    expect(written.version).toBe(CURRENT_EVIDENCE_VERSION);
  });

  it('will not read a version 1 record as a current one', () => {
    // The whole defect in one assertion. If this ever passes, the two shapes
    // have become indistinguishable again and a corrupt record will be
    // rendered as though it were merely old.
    expect(awardEvidenceSchema.safeParse(legacyOf('silver')).success).toBe(false);
  });

  it('will not read a current record as a version 1 one', () => {
    expect(legacyAwardEvidenceSchema.safeParse(JSON.parse(serialiseEvidence('silver', facts))).success).toBe(false);
  });

  it.each(['bronze', 'silver', 'gold'] as const)('reads a struck %s as the current version', (tier) => {
    expect(parseStoredEvidence('a1', serialiseEvidence(tier, facts)).kind).toBe('current');
  });

  it.each(['bronze', 'silver', 'gold'] as const)('reads an old %s as the version it says it is', (tier) => {
    expect(parseStoredEvidence('a1', JSON.stringify(legacyOf(tier))).kind).toBe('legacy');
  });

  it('refuses a version this build has never written rather than guessing', () => {
    // A record from a newer writer is not one an older reader may reinterpret.
    expect(() => parseStoredEvidence('a1', JSON.stringify({ version: 99, rows: [] })))
      .toThrow(/version 99/);
  });
});

/**
 * What an award struck before the name was frozen can honestly be turned into.
 */
describe('upgrading a record struck before this shape existed', () => {
  const legacy: LegacyStoredEvidence = {
    version: 1,
    rows: awardEvidence('silver', facts).map((row) => ({ what: row.what, when: row.when ? row.when.toISOString() : null })),
  };

  const upgraded = (over: Partial<{ candidateName: string; roleTitle: string }> = {}) =>
    upgradeLegacyEvidence({ legacy, candidateName: 'Priya Sharma', roleTitle: 'Senior Marketing Manager', ...over });

  it('produces a record the certificate reader accepts', () => {
    expect(awardEvidenceSchema.safeParse(upgraded()).success).toBe(true);
  });

  it('carries the five frozen rows across unchanged', () => {
    expect(upgraded().rows.map((row) => row.what)).toEqual(legacy.rows.map((row) => row.what));
  });

  it('says no assessor was recorded rather than naming the one the live rows show today', () => {
    // `facts` names a subject-matter expert. A version-1 record did not, and
    // reading one out of today's rows would re-derive a claim about the past —
    // the exact thing the frozen column exists to prevent.
    expect([upgraded().signatures.left.name, upgraded().signatures.left.role])
      .toEqual(['Questor', 'Assessed by · not recorded on this award']);
  });

  it('cleans a row the old writer never cleaned', () => {
    // The old writer stored `what` as it came. A control character in one
    // would be refused by the reader, so the upgrade — which is a write — is
    // where it gets taken out.
    const dirty: LegacyStoredEvidence = { version: 1, rows: legacy.rows.map((row, index) => (index === 0 ? { ...row, what: 'Progressed by\r\nBcc: someone@elsewhere.test' } : row)) };

    const result = upgradeLegacyEvidence({ legacy: dirty, candidateName: 'Priya Sharma', roleTitle: 'A Role' });

    expect([result.rows[0].what, awardEvidenceSchema.safeParse(result).success])
      .toEqual(['Progressed by Bcc: someone@elsewhere.test', true]);
  });

  it('says what is missing when the candidate row it pointed at has gone', () => {
    expect([upgraded({ candidateName: '' }).candidateName, upgraded({ roleTitle: '' }).roleTitle])
      .toEqual(['Name not on record', 'Role not on record']);
  });
});

/**
 * The date a row prints. Formatted at render time rather than frozen, because
 * the instant is the fact and "22 Sep 2026" is typography.
 */
describe('the date a row prints', () => {
  it('prints the day, the short month and the year, as the approved design sets them', () => {
    expect(whenLabel('2026-09-22T09:00:00.000Z')).toBe('22 Sep 2026');
  });

  // en-GB renders September as "Sept" under CLDR 42 and later, so a
  // locale-formatted certificate changes shape when the Node image is
  // upgraded. The month names are written out for exactly this date.
  it('says Sep, not Sept, whichever ICU the runtime ships', () => {
    expect(whenLabel('2026-09-01T00:00:00.000Z')).not.toContain('Sept');
  });

  it('reads the instant in UTC, so the same award reads the same way everywhere', () => {
    expect(whenLabel('2026-09-22T23:30:00.000Z')).toBe('22 Sep 2026');
  });

  it('stands a dash where Questor holds no date', () => {
    expect(whenLabel(null)).toBe('—');
  });
});
