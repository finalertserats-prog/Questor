import { describe, it, expect } from 'vitest';
import {
  AWARD_TIERS, awardsForPromotion, formatReference, referenceBlocks,
  awardEvidence, unearnedReason, tierCode, journeyTiers, awardHeadline, type AwardFacts,
} from '../src/domain/candidateAwards.js';
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
