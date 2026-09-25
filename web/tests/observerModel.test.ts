import { describe, it, expect } from 'vitest';
import {
  candidatePhase, formatOffset, groupQuotesByCompetency, orderedTranscript, readQuotes, roomPhase, stopSentence,
  type ObservationView, type ObserverRoundView, observeLoadProblem } from '../src/components/observerModel';

function roundView(observation: Partial<ObservationView> | null, round: Partial<ObserverRoundView['round']> = {}): ObserverRoundView {
  return {
    round: { id: 'r1', candidateId: 'c1', stageKey: 'gold', status: 'SCHEDULED', aiObserver: true, scheduledAt: '2026-10-08T09:00:00Z', ...round },
    you: { party: 'interviewer' },
    notice: 'notice',
    capture: { mode: 'browser', provider: 'webspeech' },
    // Consented by default: the phases below are about what the ROOM is doing,
    // and the gate is tested on its own. A view with no gate would answer
    // 'gate' for every status and say nothing about any of them.
    gate: {
      notice: 'notice', noticeVersion: 'observer-entry-v1', consequence: '',
      decided: 'consented', awaiting: [], mayEnter: true, refusal: null,
    },
    observation: observation === null ? null : {
      id: 'o1', status: 'AWAITING_CONSENT', isInterviewer: true, interviewerConsentAt: null, candidateConsentAt: null,
      declinedBy: null, startedAt: null, stoppedBy: null, stoppedAt: null, endedAt: null, readOnly: false,
      captureStatus: 'OK', legalHold: false, candidateLink: null, transcript: [],
      participants: [], awaiting: [], blocked: null,
      quotes: { status: 'PENDING', note: '', framing: '', items: [] },
      ...observation,
    },
  };
}

describe('the room phase', () => {
  it('is unavailable on a round without an AI observer', () => {
    expect(roomPhase(roundView(null, { aiObserver: false }))).toBe('unavailable');
  });

  it('is unavailable on a finished round nobody set up an observer for', () => {
    expect(roomPhase(roundView(null, { status: 'COMPLETED' }))).toBe('unavailable');
  });

  it('follows the server status once this person has passed the gate', () => {
    expect(['AWAITING_CONSENT', 'CONSENTED', 'LISTENING', 'STOPPED', 'DECLINED', 'ENDED']
      .map((status) => roomPhase(roundView({ status: status as ObservationView['status'] }))))
      .toEqual(['awaiting_others', 'awaiting_others', 'listening', 'stopped', 'declined', 'ended']);
  });

  // The gate comes ahead of everything but an unavailable round. Somebody who
  // has not agreed sees the notice and nothing else, whatever the round is
  // doing — including a round already being recorded for everyone else.
  it('shows the gate to somebody who has not decided, whatever the round is doing', () => {
    const view = roundView({ status: 'LISTENING' });

    expect(roomPhase({ ...view, gate: { ...view.gate!, decided: 'pending', mayEnter: false } })).toBe('gate');
  });

  it('shows the gate to somebody who declined a round still running for others', () => {
    const view = roundView({ status: 'LISTENING' });

    expect(roomPhase({ ...view, gate: { ...view.gate!, decided: 'declined', mayEnter: false } })).toBe('gate');
  });
});

describe('explaining why nothing is captured', () => {
  const BLOCK = { reason: 'The candidate has not agreed to this round being recorded.', nextSteps: ['Rebook it.'] };

  it('uses the server\'s own sentence when the round cannot go ahead', () => {
    expect(stopSentence({ status: 'DECLINED', stoppedBy: null, declinedBy: 'candidate', blocked: BLOCK }))
      .toBe(BLOCK.reason);
  });

  // The old copy here told the reader to run the round as normal because
  // nothing was being captured. That is now exactly the wrong instruction: a
  // round with no transcript produces no evidence, so it is not one to run.
  it('never tells anyone to run the round unrecorded', () => {
    expect(stopSentence({ status: 'DECLINED', stoppedBy: null, declinedBy: 'candidate', blocked: null }))
      .not.toMatch(/as normal/i);
  });

  it('says the round cannot go ahead even without a sentence from the server', () => {
    expect(stopSentence({ status: 'STOPPED', stoppedBy: 'candidate', declinedBy: null, blocked: null }))
      .toMatch(/cannot go ahead/);
  });

  it('says nothing while the observer is running', () => {
    expect(stopSentence({ status: 'LISTENING', stoppedBy: null, declinedBy: null, blocked: null })).toBe('');
  });
});

describe('positions in the round', () => {
  it('formats minutes and seconds', () => {
    expect(formatOffset(125_000)).toBe('2:05');
  });

  it('adds hours for a long round', () => {
    expect(formatOffset(3_723_000)).toBe('1:02:03');
  });

  it('treats nonsense as the start', () => {
    expect([formatOffset(-5), formatOffset(Number.NaN)]).toEqual(['0:00', '0:00']);
  });
});

describe('reading quotes', () => {
  it('keeps only the evidence fields of a quote', () => {
    const [quote] = readQuotes([{ competencyId: 'a', competencyName: 'A', quote: 'q text', segmentIndex: 0, offsetMs: 0, score: 5 }]);

    expect(Object.keys(quote).sort()).toEqual(['competencyId', 'competencyName', 'offsetMs', 'quote', 'segmentIndex']);
  });

  it('drops anything that is not a quote', () => {
    expect(readQuotes([null, 'text', { quote: 'no competency' }])).toEqual([]);
  });

  it('groups by competency in round order', () => {
    const groups = groupQuotesByCompetency([
      { competencyId: 'a', competencyName: 'A', quote: 'later', segmentIndex: 2, offsetMs: 60_000 },
      { competencyId: 'b', competencyName: 'B', quote: 'other', segmentIndex: 1, offsetMs: 30_000 },
      { competencyId: 'a', competencyName: 'A', quote: 'earlier', segmentIndex: 0, offsetMs: 0 },
    ]);

    expect(groups.map((g) => [g.competencyName, g.quotes.map((q) => q.quote)])).toEqual([['A', ['earlier', 'later']], ['B', ['other']]]);
  });
});

describe('the transcript order', () => {
  it('orders by position in the round, not by arrival', () => {
    const ordered = orderedTranscript([
      { index: 0, kind: 'SPEECH', offsetMs: 30_000, durationMs: 0, text: 'second' },
      { index: 1, kind: 'SPEECH', offsetMs: 0, durationMs: 0, text: 'first' },
    ]);

    expect(ordered.map((s) => s.text)).toEqual(['first', 'second']);
  });
});

describe('the candidate phase', () => {
  it('maps a listening observer to listening', () => {
    expect(candidatePhase({
      status: 'LISTENING', organisation: '', stage: '', notice: '', decision: 'consented',
      canConsent: false, canDecline: false, canStop: true, listening: true,
    })).toBe('listening');
  });
});

describe('observeLoadProblem', () => {
  it('treats 409 as waiting for the candidate, and anything else as an error', () => {
    expect([observeLoadProblem(409), observeLoadProblem(500), observeLoadProblem(undefined)]).toEqual(['waiting', 'error', 'error']);
  });
});
