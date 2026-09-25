import { describe, expect, it } from 'vitest';
import { DEFAULT_STAGES, type PipelineStage } from '../src/domain/pipelineStages.js';
import { verdictConsequence, verdictConsequences } from '../src/domain/verdictConsequence.js';

/**
 * What each verdict will do, worked out before the reviewer presses anything.
 *
 * The page shows this sentence beside the button, so it has to be the same
 * arithmetic the submit then performs. Since "HR decides", that arithmetic is
 * one step and not two: reviewing an interview no longer moves anybody, so the
 * verdict — the decision on the AI round — is the whole of it. Proceed is what
 * carries a candidate from Silver to Gold, and it is also what strikes their
 * Silver badge on the way out.
 */

const stages = DEFAULT_STAGES;

const NO_HUMAN_ROUND: readonly PipelineStage[] = [
  { key: 'participation', label: 'Participation', kind: 'intake' },
  { key: 'silver', label: 'Silver', kind: 'ai_interview' },
  { key: 'decided', label: 'Decided', kind: 'human_interview' },
];

describe('a candidate a person has already moved to Gold', () => {
  it('Proceed leaves them at Gold, where the human rounds are', () => {
    expect(verdictConsequence(stages, 'gold', 'ACTIVE', 'PROCEED')).toMatchObject({
      toStageKey: 'gold', toStageLabel: 'Gold', moves: false, closes: null,
    });
  });

  it('Proceed never carries them to Diamond: a person still has to interview them', () => {
    expect(verdictConsequence(stages, 'gold', 'ACTIVE', 'PROCEED').toStageKey).not.toBe('diamond');
  });

  it('Consider leaves them where they are and decides nothing', () => {
    expect(verdictConsequence(stages, 'gold', 'ACTIVE', 'CONSIDER')).toMatchObject({
      toStageKey: 'gold', moves: false, closes: null,
    });
  });

  it('Do not progress ends the journey at Gold', () => {
    expect(verdictConsequence(stages, 'gold', 'ACTIVE', 'DO_NOT_PROGRESS')).toMatchObject({
      toStageKey: 'gold', toStageLabel: 'Gold', closes: 'REJECTED',
    });
  });
});

describe('a candidate whose AI interview has just been reviewed (still at Silver)', () => {
  it('Proceed says they will move to Gold, because approving the AI round is what moves them', () => {
    expect(verdictConsequence(stages, 'silver', 'ACTIVE', 'PROCEED')).toMatchObject({
      fromStageKey: 'silver', fromStageLabel: 'Silver', toStageKey: 'gold', toStageLabel: 'Gold', moves: true, closes: null,
    });
  });

  // The change this file exists to pin. Reading an interview is not a
  // judgement about it, and it used to move the candidate anyway — which is
  // how five people reached Gold with nobody deciding and no badge struck.
  it('Consider leaves them at Silver, because reviewing an interview moves nobody', () => {
    expect(verdictConsequence(stages, 'silver', 'ACTIVE', 'CONSIDER')).toMatchObject({ toStageKey: 'silver', moves: false, closes: null });
  });

  it('Do not progress ends the journey at Silver, which is where they actually stand', () => {
    expect(verdictConsequence(stages, 'silver', 'ACTIVE', 'DO_NOT_PROGRESS')).toMatchObject({ toStageKey: 'silver', closes: 'REJECTED' });
  });
});

describe('a plan whose only human stage is its last', () => {
  it('leaves the candidate at the AI round on Consider, which decides nothing', () => {
    expect(verdictConsequence(NO_HUMAN_ROUND, 'silver', 'ACTIVE', 'CONSIDER')).toMatchObject({
      toStageKey: 'silver', moves: false, closes: null,
    });
  });

  // The last stage is never reached by an event the system raises on its own,
  // and now neither is any stage past Bronze; an approval is a person's
  // decision, so it may take them all the way there.
  it('lets Proceed carry them to the last stage, because a person decided it', () => {
    expect(verdictConsequence(NO_HUMAN_ROUND, 'silver', 'ACTIVE', 'PROCEED')).toMatchObject({
      toStageKey: 'decided', toStageLabel: 'Decided', moves: true, closes: null,
    });
  });

  it('still ends the journey on Do not progress', () => {
    expect(verdictConsequence(NO_HUMAN_ROUND, 'silver', 'ACTIVE', 'DO_NOT_PROGRESS')).toMatchObject({
      toStageKey: 'silver', closes: 'REJECTED',
    });
  });
});

describe('a pipeline that has already been decided', () => {
  it('reports that no verdict moves it, whichever one is chosen', () => {
    for (const c of verdictConsequences(stages, 'gold', 'DECIDED')) {
      expect({ verdict: c.verdict, moves: c.moves, closes: c.closes, alreadyDecided: c.alreadyDecided })
        .toEqual({ verdict: c.verdict, moves: false, closes: null, alreadyDecided: true });
    }
  });
});

describe('the set offered to the page', () => {
  it('covers every verdict, in the order the control offers them', () => {
    expect(verdictConsequences(stages, 'gold', 'ACTIVE').map((c) => c.verdict))
      .toEqual(['PROCEED', 'CONSIDER', 'DO_NOT_PROGRESS']);
  });
});
