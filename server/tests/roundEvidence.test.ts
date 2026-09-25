import { describe, it, expect } from 'vitest';
import {
  checkEvidenceEntries, evidenceKindOf, evidenceView, parseEvidenceEntries, peerNotesWereVisible, peerQuarantine,
  PEER_NOTES_WITHHELD, type QuarantineInput,
} from '../src/domain/roundEvidence.js';

/**
 * The two rules a human round lives by, tested where they are decided rather
 * than through a route: what the round is allowed to claim it holds, and which
 * of a candidate's own interviewers may read it.
 */

const NO_RECORD = { notes: '', structuredCount: 0, observationStatus: null, segmentCount: 0 };

describe('what a human round can claim it holds', () => {
  it('claims nothing for a round nobody has closed', () => {
    expect(evidenceKindOf(NO_RECORD)).toBe('none');
  });

  it('claims only the written account when that is all the interviewer left', () => {
    expect(evidenceKindOf({ ...NO_RECORD, notes: 'Walked a production incident end to end.' })).toBe('notes');
  });

  it('claims the structured record once claims carry quotes', () => {
    expect(evidenceKindOf({ ...NO_RECORD, notes: 'Strong throughout.', structuredCount: 3 })).toBe('structured');
  });

  it('claims the transcript when the observer ended with something captured', () => {
    const kind = evidenceKindOf({ ...NO_RECORD, notes: 'Strong.', structuredCount: 3, observationStatus: 'ENDED', segmentCount: 12 });

    expect(kind).toBe('transcript');
  });

  // A consented observer that heard nothing is the case that would quietly
  // overstate the record: the round looks transcribed and holds no words.
  it('does not claim a transcript when the observer captured nothing', () => {
    const kind = evidenceKindOf({ ...NO_RECORD, notes: 'Strong.', observationStatus: 'ENDED', segmentCount: 0 });

    expect(kind).toBe('notes');
  });

  it('does not claim a transcript while the observer is still listening', () => {
    const kind = evidenceKindOf({ ...NO_RECORD, notes: 'Strong.', observationStatus: 'LISTENING', segmentCount: 4 });

    expect(kind).toBe('notes');
  });

  it('does not claim a transcript when the candidate declined the observer', () => {
    const kind = evidenceKindOf({ ...NO_RECORD, notes: 'Strong.', structuredCount: 2, observationStatus: 'DECLINED', segmentCount: 0 });

    expect(kind).toBe('structured');
  });

  // The line the whole feature turns on. A typed quote is the interviewer's
  // recollection; a certificate that let it read as a recording would claim
  // more than the mechanism delivers.
  it('says plainly that a typed quote is not a recording', () => {
    expect(evidenceView('structured').detail).toContain('not a recording of it');
  });

  it('says prose alone has nothing in it that can be checked', () => {
    expect(evidenceView('notes').detail).toContain('nothing here can be checked');
  });

  // No longer "the candidate's own words": the round is captured with everyone
  // in the room consented, so the transcript is everyone's words, and claiming
  // only the candidate's would understate what a reader is looking at.
  it('says the transcript is what was said, not anyone\'s recollection of it', () => {
    expect(evidenceView('transcript').detail).toContain('the words that were actually said');
  });

  it('says everyone in the room agreed to it before joining', () => {
    expect(evidenceView('transcript').detail).toContain('agreed to that before they joined');
  });
});

const COMPETENCIES = [
  { id: 'c1', name: 'Incident response' },
  { id: 'c2', name: 'Data modelling' },
];
const ENTRY = { competencyId: 'c1', claim: 'Owned the incident end to end.', quote: 'I paged myself at 2am and ran it.' };

describe('checking a structured record before it is stored', () => {
  it('accepts a claim with the words it rests on', () => {
    expect(checkEvidenceEntries([ENTRY], COMPETENCIES).ok).toBe(true);
  });

  // The name is resolved from the scorecard, never taken from the request: a
  // client-chosen name would let a record claim a competency the role is not
  // assessed on while still passing the id check.
  it('files the entry under the scorecard\'s own name for the competency', () => {
    const checked = checkEvidenceEntries([ENTRY], COMPETENCIES);

    expect(checked.ok && checked.entries[0].competencyName).toBe('Incident response');
  });

  it('refuses a competency the role is not assessed on', () => {
    const checked = checkEvidenceEntries([{ ...ENTRY, competencyId: 'not-on-the-scorecard' }], COMPETENCIES);

    expect(checked.ok).toBe(false);
  });

  it('refuses the same competency twice, which reads as one finding with two supports', () => {
    const checked = checkEvidenceEntries([ENTRY, { ...ENTRY, quote: 'Something else entirely that I said.' }], COMPETENCIES);

    expect(checked.ok).toBe(false);
  });

  it('refuses a claim with no quote under it', () => {
    const checked = checkEvidenceEntries([{ ...ENTRY, quote: '' }], COMPETENCIES);

    expect(checked.ok && 'problem' in checked).toBe(false);
  });

  it('says why a claim with no quote is not evidence', () => {
    const checked = checkEvidenceEntries([{ ...ENTRY, quote: '' }], COMPETENCIES);

    expect(!checked.ok && checked.problem).toContain('not evidence');
  });

  // The failure this product exists to prevent: pasting the conclusion into the
  // quote box produces a record whose every claim is "supported" and whose
  // every support is the claim.
  it('refuses a quote that merely repeats the claim', () => {
    const checked = checkEvidenceEntries([{ ...ENTRY, quote: ENTRY.claim }], COMPETENCIES);

    expect(checked.ok).toBe(false);
  });

  it('refuses it however it was capitalised', () => {
    const checked = checkEvidenceEntries([{ ...ENTRY, quote: ENTRY.claim.toUpperCase() }], COMPETENCIES);

    expect(checked.ok).toBe(false);
  });
});

describe('reading a stored structured record back', () => {
  it('returns the entries it holds', () => {
    const stored = [{ competencyId: 'c1', competencyName: 'Incident response', claim: 'Owned it.', quote: 'I ran it.' }];

    expect(parseEvidenceEntries(stored)).toHaveLength(1);
  });

  // A half-written row would render as a claim with a blank quote, which is
  // exactly the shape the check above refuses to create.
  it('drops a row that lost a field', () => {
    expect(parseEvidenceEntries([{ competencyId: 'c1', claim: 'Owned it.' }])).toEqual([]);
  });

  it('returns nothing for a value that is not a list', () => {
    expect(parseEvidenceEntries({ competencyId: 'c1' })).toEqual([]);
  });
});

const GOLD_A = { id: 'round-a', stageKey: 'gold', conductedBy: 'HUMAN', panelUserIds: ['sme-a'], hasNotes: true };
const GOLD_B = { id: 'round-b', stageKey: 'gold', conductedBy: 'HUMAN', panelUserIds: ['sme-b'], hasNotes: false };

function reading(overrides: Partial<QuarantineInput> = {}): QuarantineInput {
  return {
    round: { id: 'round-a', stageKey: 'gold', conductedBy: 'HUMAN' },
    viewerUserId: 'sme-b',
    viewerDecides: false,
    rounds: [GOLD_A, GOLD_B],
    pipeline: { status: 'ACTIVE', currentStageKey: 'gold' },
    ...overrides,
  };
}

describe('which of a candidate\'s interviewers may read a peer round', () => {
  it('withholds one SME\'s round from the other while the stage is undecided', () => {
    const result = peerQuarantine(reading());

    expect(result.withheld).toBe(true);
  });

  it('says why it is withheld rather than returning an empty round', () => {
    expect(peerQuarantine(reading()).reason).toBe(PEER_NOTES_WITHHELD);
  });

  it('lets an interviewer read their own round', () => {
    const result = peerQuarantine(reading({ viewerUserId: 'sme-a' }));

    expect(result.withheld).toBe(false);
  });

  // The whole point of the gate is the independence of the opinions HR weighs
  // up; HR cannot weigh up what it cannot read.
  it('never withholds anything from someone who decides', () => {
    const result = peerQuarantine(reading({ viewerDecides: true }));

    expect(result.withheld).toBe(false);
  });

  it('opens once the candidate has moved past the stage', () => {
    const result = peerQuarantine(reading({ pipeline: { status: 'ACTIVE', currentStageKey: 'diamond' } }));

    expect(result.withheld).toBe(false);
  });

  it('opens once a decision closes the pipeline', () => {
    const result = peerQuarantine(reading({ pipeline: { status: 'DECIDED', currentStageKey: 'gold' } }));

    expect(result.withheld).toBe(false);
  });

  it('leaves a colleague who is conducting nothing exactly as they were', () => {
    const result = peerQuarantine(reading({ viewerUserId: 'recruiter-with-no-round' }));

    expect(result.withheld).toBe(false);
  });

  // Silver and Gold are separate readings of separate things. Holding a Silver
  // round would not anchor a Gold opinion, and pretending otherwise would hide
  // evidence from the person conducting the next round.
  it('does not withhold across stages', () => {
    const result = peerQuarantine(reading({
      round: { id: 'round-s', stageKey: 'silver', conductedBy: 'HUMAN' },
      rounds: [{ id: 'round-s', stageKey: 'silver', conductedBy: 'HUMAN', panelUserIds: ['sme-a'], hasNotes: true }, GOLD_B],
    }));

    expect(result.withheld).toBe(false);
  });

  // The AI round's own gate is shadow mode's, which is a different rule with a
  // different reveal; applying this one as well would give two answers.
  it('does not apply to the AI round', () => {
    const result = peerQuarantine(reading({
      round: { id: 'round-ai', stageKey: 'gold', conductedBy: 'AI' },
      rounds: [{ id: 'round-ai', stageKey: 'gold', conductedBy: 'AI', panelUserIds: [], hasNotes: true }, GOLD_B],
    }));

    expect(result.withheld).toBe(false);
  });

  // Asked about the PEER rounds, never about the writer's own: their own is
  // always theirs to read, so asking about it would answer "visible" for
  // everyone and the stored fact would mean nothing.
  it('reports that an SME writing their own round had no peer record in front of them', () => {
    const seen = peerNotesWereVisible(reading({
      round: { id: 'round-b', stageKey: 'gold', conductedBy: 'HUMAN' }, viewerUserId: 'sme-b',
    }));

    expect(seen).toBe(false);
  });

  it('reports that a decider writing a round could read the peer record', () => {
    const seen = peerNotesWereVisible(reading({
      round: { id: 'round-b', stageKey: 'gold', conductedBy: 'HUMAN' }, viewerUserId: 'hr', viewerDecides: true,
    }));

    expect(seen).toBe(true);
  });

  it('reports no peer record seen when the peer round has not been written yet', () => {
    const seen = peerNotesWereVisible(reading({
      round: { id: 'round-a', stageKey: 'gold', conductedBy: 'HUMAN' }, viewerUserId: 'hr', viewerDecides: true,
      rounds: [{ ...GOLD_A, hasNotes: false }, GOLD_B],
    }));

    expect(seen).toBe(false);
  });

  it('reports no peer record seen when this is the only round at the stage', () => {
    const seen = peerNotesWereVisible(reading({
      round: { id: 'round-a', stageKey: 'gold', conductedBy: 'HUMAN' }, viewerUserId: 'hr', viewerDecides: true,
      rounds: [GOLD_A],
    }));

    expect(seen).toBe(false);
  });
});
