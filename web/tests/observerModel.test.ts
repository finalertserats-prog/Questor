import { describe, it, expect } from 'vitest';
import {
  candidatePhase, formatOffset, groupQuotesByCompetency, orderedTranscript, readQuotes, roomPhase, stopSentence,
  type ObservationView, type ObserverRoundView,
} from '../src/components/observerModel';

function roundView(observation: Partial<ObservationView> | null, round: Partial<ObserverRoundView['round']> = {}): ObserverRoundView {
  return {
    round: { id: 'r1', candidateId: 'c1', stageKey: 'gold', status: 'SCHEDULED', aiObserver: true, scheduledAt: '2026-10-08T09:00:00Z', ...round },
    notice: 'notice',
    capture: { mode: 'browser', provider: 'webspeech' },
    observation: observation === null ? null : {
      id: 'o1', status: 'AWAITING_CANDIDATE', isInterviewer: true, interviewerConsentAt: null, candidateConsentAt: null,
      declinedBy: null, startedAt: null, stoppedBy: null, stoppedAt: null, endedAt: null, readOnly: false,
      captureStatus: 'OK', legalHold: false, candidateLink: null, transcript: [],
      quotes: { status: 'PENDING', note: '', framing: '', items: [] },
      ...observation,
    },
  };
}

describe('the room phase', () => {
  it('asks the interviewer first when nobody has decided', () => {
    expect(roomPhase(roundView(null))).toBe('ask_interviewer');
  });

  it('is unavailable on a round without an AI observer', () => {
    expect(roomPhase(roundView(null, { aiObserver: false }))).toBe('unavailable');
  });

  it('is unavailable on a finished round nobody set up an observer for', () => {
    expect(roomPhase(roundView(null, { status: 'COMPLETED' }))).toBe('unavailable');
  });

  it('follows the server status once the observer exists', () => {
    expect(['AWAITING_CANDIDATE', 'CONSENTED', 'LISTENING', 'STOPPED', 'DECLINED', 'ENDED']
      .map((status) => roomPhase(roundView({ status: status as ObservationView['status'] }))))
      .toEqual(['awaiting_candidate', 'ready', 'listening', 'stopped', 'declined', 'ended']);
  });
});

describe('explaining why nothing is captured', () => {
  it('names the candidate when they stopped it', () => {
    expect(stopSentence({ status: 'STOPPED', stoppedBy: 'candidate', declinedBy: null })).toMatch(/candidate stopped/);
  });

  it('names the candidate when they declined', () => {
    expect(stopSentence({ status: 'DECLINED', stoppedBy: null, declinedBy: 'candidate' })).toMatch(/candidate declined/);
  });

  it('says nothing while the observer is running', () => {
    expect(stopSentence({ status: 'LISTENING', stoppedBy: null, declinedBy: null })).toBe('');
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
