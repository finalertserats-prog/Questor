import { describe, it, expect } from 'vitest';
import {
  MAX_MISHEARD_TURNS, MAX_RECONNECTS, MAX_UNUSABLE_REPLY_SHARE, MIN_AI_CONFIDENCE, MIN_REPLIES_TO_JUDGE,
  feedbackHold, holdReasonTexts, trustSignals, type TrustSignals,
} from '../src/services/feedbackHoldModel.js';

/**
 * When the candidate's automatic feedback email is held for a person instead
 * of going on its own (owner, 2026-09-22): the AI was unsure of its reading,
 * or the interview's audio/transcript was too poor to trust. Every threshold
 * is a named constant, and every reason reads in plain words.
 */

const GOOD_ANSWER = 'I rebuilt the billing pipeline in Spark and cut the nightly run from four hours to forty minutes.';

function signals(patch: Partial<TrustSignals> = {}): TrustSignals {
  return {
    recommendation: 'CONSIDER', aiConfidence: 0.6, replies: 6, unusableReplies: 0, misheardTurns: 0, reconnects: 0,
    ...patch,
  };
}

describe('the thresholds', () => {
  it('holds below 35% AI confidence', () => {
    expect(MIN_AI_CONFIDENCE).toBe(0.35);
  });

  it('judges the transcript only from four replies up', () => {
    expect(MIN_REPLIES_TO_JUDGE).toBe(4);
  });

  it('holds when 40% or more of the replies had nothing usable in them', () => {
    expect(MAX_UNUSABLE_REPLY_SHARE).toBe(0.4);
  });

  it('holds from three repeat-or-correction requests', () => {
    expect(MAX_MISHEARD_TURNS).toBe(3);
  });

  it('holds from three reconnects', () => {
    expect(MAX_RECONNECTS).toBe(3);
  });
});

describe('feedbackHold', () => {
  it('does not hold a normal interview', () => {
    expect(feedbackHold(signals())).toBeNull();
  });

  it('holds when automated scoring failed', () => {
    expect(feedbackHold(signals({ recommendation: 'SCORING_UNAVAILABLE' }))?.reasons).toContain('SCORING_UNAVAILABLE');
  });

  it('holds when the AI confidence is under the floor', () => {
    expect(feedbackHold(signals({ aiConfidence: 0.34 }))?.reasons).toEqual(['LOW_AI_CONFIDENCE']);
  });

  it('does not hold at exactly the confidence floor', () => {
    expect(feedbackHold(signals({ aiConfidence: 0.35 }))).toBeNull();
  });

  it('holds when too many replies had nothing usable in them', () => {
    expect(feedbackHold(signals({ replies: 5, unusableReplies: 2 }))?.reasons).toEqual(['UNUSABLE_REPLIES']);
  });

  it('does not hold just under the unusable share', () => {
    expect(feedbackHold(signals({ replies: 6, unusableReplies: 2 }))).toBeNull();
  });

  it('does not judge the transcript from too few replies', () => {
    expect(feedbackHold(signals({ replies: 3, unusableReplies: 2 }))).toBeNull();
  });

  it('holds when the candidate repeatedly could not hear or was misheard', () => {
    expect(feedbackHold(signals({ misheardTurns: 3 }))?.reasons).toEqual(['MISHEARD']);
  });

  it('holds when the connection dropped repeatedly', () => {
    expect(feedbackHold(signals({ reconnects: 3 }))?.reasons).toEqual(['RECONNECTS']);
  });

  it('lists every reason that applies, in a stable order', () => {
    expect(feedbackHold(signals({ aiConfidence: 0.2, reconnects: 4, misheardTurns: 5 }))?.reasons)
      .toEqual(['LOW_AI_CONFIDENCE', 'MISHEARD', 'RECONNECTS']);
  });

  it('keeps the signals it decided on, for the record', () => {
    const s = signals({ reconnects: 4 });
    expect(feedbackHold(s)?.signals).toEqual(s);
  });
});

describe('trustSignals', () => {
  const assessment = { recommendation: 'CONSIDER', confidence: 0.6 };

  it('counts only the candidate side of the transcript', () => {
    const turns = [
      { speaker: 'agent', text: 'Tell me about a project.' },
      { speaker: 'candidate', text: GOOD_ANSWER },
      { speaker: 'system', text: 'note' },
    ];
    expect(trustSignals(assessment, turns, 0).replies).toBe(1);
  });

  it('counts empty and content-free replies as unusable', () => {
    const turns = ['', 'No', 'Oh', GOOD_ANSWER].map((text) => ({ speaker: 'candidate', text }));
    expect(trustSignals(assessment, turns, 0).unusableReplies).toBe(3);
  });

  it('counts requests to repeat and corrections of what was heard as misheard turns', () => {
    const turns = ['Sorry, can you repeat that?', "That's not what I said", GOOD_ANSWER].map((text) => ({ speaker: 'candidate', text }));
    expect(trustSignals(assessment, turns, 0).misheardTurns).toBe(2);
  });

  it('does not count a pause or a question to the interviewer against the transcript', () => {
    const turns = ['Pause', 'What does the team work on?'].map((text) => ({ speaker: 'candidate', text }));
    const s = trustSignals(assessment, turns, 0);
    expect([s.unusableReplies, s.misheardTurns]).toEqual([0, 0]);
  });

  it('carries the reconnects and the AI reading through', () => {
    const s = trustSignals({ recommendation: 'PROCEED', confidence: 0.81 }, [], 2);
    expect([s.recommendation, s.aiConfidence, s.reconnects]).toEqual(['PROCEED', 0.81, 2]);
  });
});

describe('holdReasonTexts', () => {
  it('words a low confidence as a percentage', () => {
    expect(holdReasonTexts(['LOW_AI_CONFIDENCE'], signals({ aiConfidence: 0.28 }))[0]).toContain('28%');
  });

  it('says how many replies were unusable', () => {
    expect(holdReasonTexts(['UNUSABLE_REPLIES'], signals({ replies: 7, unusableReplies: 4 }))[0]).toContain('4 of 7');
  });

  it('says how many times the connection dropped', () => {
    expect(holdReasonTexts(['RECONNECTS'], signals({ reconnects: 5 }))[0]).toContain('5 times');
  });

  it('gives one sentence per reason', () => {
    expect(holdReasonTexts(['SCORING_UNAVAILABLE', 'MISHEARD'], signals({ misheardTurns: 3 }))).toHaveLength(2);
  });

  it('skips a reason it does not know rather than showing a code', () => {
    expect(holdReasonTexts(['SOMETHING_NEW'], signals())).toEqual([]);
  });
});
