import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CandidateObserverConsent, InterviewerConsentCard, ListeningIndicator, ObserverRoomControls, ObserverTranscript,
} from '../src/components/ObserverPanels';
import type { CandidateConsentView, ObservationView } from '../src/components/observerModel';

const noop = () => undefined;
const NOTICE = 'Questor will transcribe this interview. It will not score you.';

function observation(overrides: Partial<ObservationView> = {}): ObservationView {
  return {
    id: 'obs1', status: 'ENDED', isInterviewer: true, interviewerConsentAt: '2026-09-17T09:00:00Z',
    candidateConsentAt: '2026-09-17T09:01:00Z', declinedBy: null, startedAt: '2026-09-17T09:02:00Z',
    stoppedBy: null, stoppedAt: null, endedAt: '2026-09-17T10:00:00Z', readOnly: true, captureStatus: 'OK',
    legalHold: false, candidateLink: null,
    transcript: [
      { index: 0, kind: 'SPEECH', offsetMs: 0, durationMs: 30_000, text: 'Tell me about an incident you owned.' },
      { index: 1, kind: 'GAP', offsetMs: 30_000, durationMs: 30_000, text: '' },
      { index: 2, kind: 'SPEECH', offsetMs: 60_000, durationMs: 30_000, text: 'I led the rollback and wrote the postmortem.' },
    ],
    quotes: {
      status: 'READY', note: '', framing: 'Verbatim quotes. Quotes only, no AI judgement.',
      items: [
        { competencyId: 'own', competencyName: 'Ownership', quote: 'I led the rollback', segmentIndex: 2, offsetMs: 60_000 },
        { competencyId: 'own', competencyName: 'Ownership', quote: 'wrote the postmortem', segmentIndex: 2, offsetMs: 60_000, score: 5 },
      ],
    },
    ...overrides,
  };
}

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

describe('the listening indicator', () => {
  it('says plainly that the observer is listening', () => {
    expect(html(createElement(ListeningIndicator, { listening: true }))).toContain('Observer is listening');
  });

  it('is announced to assistive technology', () => {
    expect(html(createElement(ListeningIndicator, { listening: true }))).toContain('role="status"');
  });

  it('says nothing is being captured when it is not listening', () => {
    expect(html(createElement(ListeningIndicator, { listening: false }))).toContain('Not capturing');
  });
});

describe('the interviewer consent card', () => {
  const card = () => html(createElement(InterviewerConsentCard, { notice: NOTICE, busy: false, onConsent: noop, onDecline: noop }));

  it('shows the notice both parties agree to', () => {
    expect(card()).toContain(NOTICE);
  });

  it('offers to agree and to decline', () => {
    expect(card()).toMatch(/I agree[\s\S]*No observer for this round/);
  });
});

describe('the room controls', () => {
  const controls = (phase: Parameters<typeof ObserverRoomControls>[0]['phase'], extra: Partial<Parameters<typeof ObserverRoomControls>[0]> = {}) =>
    html(createElement(ObserverRoomControls, {
      phase, isInterviewer: true, busy: false, stopSentence: '', onStart: noop, onStop: noop, onEnd: noop, ...extra,
    }));

  it('puts a stop button in front of the interviewer while listening', () => {
    expect(controls('listening')).toContain('Stop the observer');
  });

  it('shows the listening indicator while listening', () => {
    expect(controls('listening')).toContain('Observer is listening');
  });

  it('offers to start once both have agreed', () => {
    expect(controls('ready')).toContain('Start listening');
  });

  it('does not let a colleague start someone else’s observer', () => {
    expect(controls('ready', { isInterviewer: false })).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Start listening/);
  });

  it('explains a stop and offers no way to restart', () => {
    const out = controls('stopped', { stopSentence: 'The candidate stopped the observer.' });

    expect(out).toContain('The candidate stopped the observer.');
    expect(out).not.toContain('Start listening');
  });

  it('shows why capture is incomplete', () => {
    expect(controls('listening', { degradedMessage: 'Part of the round could not be transcribed.' }))
      .toContain('Part of the round could not be transcribed.');
  });
});

describe('the observed round', () => {
  const view = (o = observation()) => html(createElement(ObserverTranscript, { observation: o }));

  it('frames the quotes as quotes only, with no AI judgement', () => {
    expect(view()).toContain('Quotes only, no AI judgement');
  });

  it('files quotes under their competency', () => {
    expect(view()).toMatch(/Ownership[\s\S]*I led the rollback/);
  });

  it('stamps each quote with its place in the round', () => {
    expect(view()).toMatch(/1:00[\s\S]*I led the rollback/);
  });

  it('never renders fields beyond the evidence itself', () => {
    expect(view()).not.toMatch(/score|>5</i);
  });

  it('marks where capture failed instead of hiding it', () => {
    expect(view()).toContain('Not captured');
  });

  it('says so when no quotes could be extracted', () => {
    const o = observation({ quotes: { status: 'UNAVAILABLE', note: 'No language model is configured.', framing: 'Quotes only, no AI judgement.', items: [] } });

    expect(view(o)).toContain('No language model is configured.');
  });

  it('labels the record read-only once the round has ended', () => {
    expect(view()).toContain('Read-only');
  });
});

describe('the candidate consent page', () => {
  const base: CandidateConsentView = {
    status: 'AWAITING_CANDIDATE', organisation: 'Acme', stage: 'Gold', notice: NOTICE, decision: 'pending',
    canConsent: true, canDecline: true, canStop: false, listening: false,
  };
  const page = (v: Partial<CandidateConsentView> = {}) =>
    html(createElement(CandidateObserverConsent, { view: { ...base, ...v }, busy: false, onConsent: noop, onDecline: noop, onStop: noop }));

  it('shows the notice and asks for a decision', () => {
    expect(page()).toMatch(new RegExp(`${NOTICE}[\\s\\S]*I agree[\\s\\S]*No, thank you`));
  });

  it('lets the candidate stop it while it is listening, and says it is listening', () => {
    const out = page({ status: 'LISTENING', decision: 'consented', canConsent: false, canDecline: false, canStop: true, listening: true });

    expect(out).toContain('Stop the observer');
    expect(out).toContain('Observer is listening');
  });

  it('offers nothing to press once declined', () => {
    expect(page({ status: 'DECLINED', decision: 'declined', canConsent: false, canDecline: false })).not.toContain('<button');
  });
});
