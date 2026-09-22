import { describe, expect, it } from 'vitest';
import {
  consequenceCopy, consequenceFor, evidenceChips, exportRefusalSentence, levelText, meterCells,
  outcomeSentence, stamp, type ConsequenceView, type JourneyView,
} from '../src/components/assessment/verdictFlowModel';
import { isVerdict, outcomeLabel, VERDICTS, verdictLabel, WITHDRAWN_LABEL } from '../src/components/assessment/verdictVocabulary';

/**
 * The sentence beside the decision, and the one after it.
 *
 * Every consequence here is built from what the server sent; the page never
 * works one out for itself, because a page that does its own arithmetic on the
 * journey is a page that can promise a move the submit will not make.
 */

function consequence(over: Partial<ConsequenceView> = {}): ConsequenceView {
  return {
    verdict: 'PROCEED', fromStageKey: 'gold', fromStageLabel: 'Gold', toStageKey: 'gold', toStageLabel: 'Gold',
    moves: false, closes: null, alreadyDecided: false, ...over,
  };
}

const CANDIDATE = 'Arjun Mehta';

describe('the one vocabulary, on screen', () => {
  it('says each verdict the same way the server does', () => {
    expect(VERDICTS.map(verdictLabel)).toEqual(['Proceed', 'Consider', 'Do not progress']);
  });

  it('reads a stored pipeline decision back in that same vocabulary', () => {
    expect([outcomeLabel('APPROVED'), outcomeLabel('REJECTED')]).toEqual(['Proceed', 'Do not progress']);
  });

  it('keeps a withdrawal out of the verdicts: nobody judged the candidate', () => {
    expect([outcomeLabel('WITHDRAWN'), isVerdict('WITHDRAWN')]).toEqual([WITHDRAWN_LABEL, false]);
  });
});

describe('what a verdict says it will do', () => {
  it('names the stage a move lands on', () => {
    const copy = consequenceCopy({
      verdict: 'PROCEED', candidate: CANDIDATE, letterWaiting: false,
      consequence: consequence({ fromStageLabel: 'Silver', toStageLabel: 'Gold', moves: true }),
    });
    expect(copy.sentence).toBe('Proceed: move Arjun Mehta to Gold and record the AI round?');
  });

  it('names the stage a move lands on in the button, not "Submit"', () => {
    const copy = consequenceCopy({
      verdict: 'PROCEED', candidate: CANDIDATE, letterWaiting: false,
      consequence: consequence({ toStageLabel: 'Gold', moves: true }),
    });
    expect(copy.act).toBe('Advance to Gold');
  });

  it('says the journey ends, and where', () => {
    const copy = consequenceCopy({
      verdict: 'DO_NOT_PROGRESS', candidate: CANDIDATE, letterWaiting: false,
      consequence: consequence({ verdict: 'DO_NOT_PROGRESS', toStageLabel: 'Gold', closes: 'REJECTED' }),
    });
    expect(copy.sentence).toBe('Do not progress: end Arjun Mehta\'s journey at Gold?');
  });

  it('says the candidate stays put when nothing moves', () => {
    const copy = consequenceCopy({ verdict: 'PROCEED', candidate: CANDIDATE, letterWaiting: false, consequence: consequence() });
    expect(copy.sentence).toBe('Proceed: Arjun Mehta stays at Gold, where the human rounds are. Record the AI round?');
  });

  // An email cannot be unsent, so this is said before the button, not after it.
  it('warns that a waiting feedback letter goes out with the verdict', () => {
    const copy = consequenceCopy({
      verdict: 'DO_NOT_PROGRESS', candidate: CANDIDATE, letterWaiting: true,
      consequence: consequence({ verdict: 'DO_NOT_PROGRESS', closes: 'REJECTED' }),
    });
    expect(copy.sentence).toContain("feedback letter is waiting and goes out with this");
  });

  it('promises nothing when the candidate has no journey for this role', () => {
    const copy = consequenceCopy({ verdict: 'PROCEED', candidate: CANDIDATE, letterWaiting: false, consequence: null });
    expect(copy.sentence).toContain('no journey for this role');
  });

  it('says a decided journey does not move again', () => {
    const copy = consequenceCopy({
      verdict: 'PROCEED', candidate: CANDIDATE, letterWaiting: false, consequence: consequence({ alreadyDecided: true }),
    });
    expect([copy.sentence.includes('already ended'), copy.offersRecordOnly]).toEqual([true, false]);
  });

  it('falls back to a neutral noun when the candidate has no name on screen', () => {
    const copy = consequenceCopy({ verdict: 'PROCEED', candidate: '  ', letterWaiting: false, consequence: consequence() });
    expect(copy.sentence).toContain('this candidate');
  });
});

describe('"Just record it"', () => {
  it('is offered when the verdict would otherwise decide the round', () => {
    const copy = consequenceCopy({
      verdict: 'DO_NOT_PROGRESS', candidate: CANDIDATE, letterWaiting: false,
      consequence: consequence({ verdict: 'DO_NOT_PROGRESS', closes: 'REJECTED' }),
    });
    expect(copy.offersRecordOnly).toBe(true);
  });

  it('is not offered for Consider, which decides nothing either way', () => {
    const copy = consequenceCopy({
      verdict: 'CONSIDER', candidate: CANDIDATE, letterWaiting: false,
      consequence: consequence({ verdict: 'CONSIDER', toStageLabel: 'Gold', moves: true }),
    });
    expect(copy.offersRecordOnly).toBe(false);
  });

  // Reviewing the interview is what assesses it, so the move happens anyway.
  // The note says so rather than letting the label imply otherwise.
  it('admits that it cannot stop a move the review itself causes', () => {
    const copy = consequenceCopy({
      verdict: 'PROCEED', candidate: CANDIDATE, letterWaiting: false,
      consequence: consequence({ toStageLabel: 'Gold', moves: true }),
    });
    expect(copy.recordOnlyNote).toContain('still counts as assessed');
  });
});

describe('picking the consequence for a verdict', () => {
  const journey = {
    consequences: [consequence(), consequence({ verdict: 'CONSIDER' }), consequence({ verdict: 'DO_NOT_PROGRESS' })],
  } as unknown as JourneyView;

  it('finds the one the reviewer chose', () => {
    expect(consequenceFor(journey, 'CONSIDER')?.verdict).toBe('CONSIDER');
  });

  it('has none to offer on a server that sends no journey', () => {
    expect(consequenceFor(null, 'PROCEED')).toBeNull();
  });
});

describe('what happened, once it has', () => {
  it('reports the move that was made', () => {
    expect(outcomeSentence({
      verdict: 'PROCEED', candidate: CANDIDATE,
      move: { fromStageLabel: 'Silver', toStageLabel: 'Gold', moves: true, closes: null },
    })).toBe('Proceed recorded. Arjun Mehta moved from Silver to Gold.');
  });

  it('reports the end of a journey', () => {
    expect(outcomeSentence({
      verdict: 'DO_NOT_PROGRESS', candidate: CANDIDATE,
      move: { fromStageLabel: 'Gold', toStageLabel: 'Gold', moves: false, closes: 'REJECTED' },
    })).toBe('Do not progress recorded. Arjun Mehta\'s journey ended at Gold.');
  });

  it('reports a verdict that moved nobody without pretending it did', () => {
    expect(outcomeSentence({
      verdict: 'CONSIDER', candidate: CANDIDATE,
      move: { fromStageLabel: 'Gold', toStageLabel: 'Gold', moves: false, closes: null },
    })).toBe('Consider recorded. Arjun Mehta stays at Gold.');
  });

  it('still confirms a review recorded against no journey', () => {
    expect(outcomeSentence({ verdict: 'PROCEED', candidate: CANDIDATE, move: null }))
      .toBe('Proceed recorded for Arjun Mehta.');
  });
});

describe('the export offer', () => {
  it('says nothing when the export is on offer', () => {
    expect(exportRefusalSentence({ available: true, because: null })).toBe('');
  });

  it('names who can, rather than hiding the action', () => {
    expect(exportRefusalSentence({ available: false, because: 'no_capability' }))
      .toBe('Only a hiring manager or an admin can export this to your ATS.');
  });

  it('says why an unscored assessment cannot go to the ATS', () => {
    expect(exportRefusalSentence({ available: false, because: 'not_scored' })).toContain('no score to export');
  });
});

describe('evidence chips', () => {
  const evidence = [
    { turnId: 't7', startMs: 1_325_000, quote: 'retries were the outage' },
    { turnId: 't9', startMs: 1_651_000, quote: 'idempotency key per payment' },
  ];

  it('carries the turn the quote came from, so the transcript can be found without matching text', () => {
    expect(evidenceChips(evidence).map((c) => c.turnId)).toEqual(['t7', 't9']);
  });

  it('stamps each quote with its time into the interview', () => {
    expect(evidenceChips(evidence).map((c) => c.stamp)).toEqual(['22:05', '27:31']);
  });

  it('drops a span with no turn to jump to, rather than rendering a dead chip', () => {
    expect(evidenceChips([{ turnId: '', startMs: 0, quote: 'orphan' }])).toEqual([]);
  });

  it('is empty, not broken, when a competency has no evidence', () => {
    expect(evidenceChips(undefined)).toEqual([]);
  });

  it('keeps two quotes from one turn apart', () => {
    const twice = [evidence[0], { ...evidence[0], quote: 'second quote' }];
    expect(new Set(evidenceChips(twice).map((c) => c.key)).size).toBe(2);
  });
});

describe('the time stamp', () => {
  it('reads as minutes and seconds', () => {
    expect(stamp(372_000)).toBe('06:12');
  });

  it('is absent for a turn that recorded no time', () => {
    expect([stamp(null), stamp(-1), stamp(Number.NaN)]).toEqual([null, null, null]);
  });
});

describe('the level meter', () => {
  it('marks a whole level as whole cells', () => {
    expect(meterCells(3)).toEqual(['full', 'full', 'full', 'empty', 'empty']);
  });

  // A level read as higher than it was is the one error a scorecard must not make.
  it('never rounds a half level up', () => {
    expect(meterCells(2.5)).toEqual(['full', 'full', 'half', 'empty', 'empty']);
  });

  it('shows an ungraded competency as empty rather than as zero out of five', () => {
    expect(meterCells(null)).toEqual(['empty', 'empty', 'empty', 'empty', 'empty']);
  });
});

describe('the level in words', () => {
  it('says what a level is', () => {
    expect(levelText(3, false)).toBe('3/5');
  });

  it('says that evidence was thin rather than showing a number nobody earned', () => {
    expect(levelText(null, true)).toBe('Not enough evidence');
  });

  it('distinguishes "not graded" from "not enough evidence"', () => {
    expect(levelText(null, false)).toBe('Not graded');
  });
});
