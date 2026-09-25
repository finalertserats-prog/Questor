import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CandidateObserverConsent, EntryGateCard, ListeningIndicator, ObserverRoomControls, ObserverTranscript,
  RoundBlockedCard, WithdrawalReason,
} from '../src/components/ObserverPanels';
import type { CandidateConsentView, EntryGate, ObservationView } from '../src/components/observerModel';

const noop = () => undefined;
const NOTICE = 'Questor will transcribe this interview. It will not score you.';

function observation(overrides: Partial<ObservationView> = {}): ObservationView {
  return {
    id: 'obs1', status: 'ENDED', isInterviewer: true, interviewerConsentAt: '2026-09-17T09:00:00Z',
    candidateConsentAt: '2026-09-17T09:01:00Z', declinedBy: null, startedAt: '2026-09-17T09:02:00Z',
    stoppedBy: null, stoppedAt: null, endedAt: '2026-09-17T10:00:00Z', readOnly: true, captureStatus: 'OK',
    legalHold: false, candidateLink: null, participants: [], awaiting: [], blocked: null,
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

describe('the entry gate', () => {
  const gate: EntryGate = {
    notice: NOTICE, noticeVersion: 'observer-entry-v1',
    consequence: 'Agreeing is how you join.', decided: 'pending', awaiting: ['candidate'], mayEnter: false, refusal: null,
  };
  const card = (party: 'interviewer' | 'hr' = 'interviewer') =>
    html(createElement(EntryGateCard, { gate, party, busy: false, onConsent: noop, onDecline: noop }));

  it('shows the notice everyone in the room agrees to', () => {
    expect(card()).toContain(NOTICE);
  });

  // Not "would you like an observer?": nobody is being asked that. The round
  // is recorded, and agreeing is how a person joins it.
  it('offers to join by agreeing, and to decline', () => {
    expect(card()).toMatch(/I agree — join the round[\s\S]*I would rather not be recorded/);
  });

  it('says what declining will mean before the press, not after it', () => {
    expect(card()).toContain('Agreeing is how you join.');
  });

  it('tells an HR joiner that their own voice is captured too', () => {
    expect(card('hr')).toMatch(/Your voice is captured/);
  });

  // The AI is not a participant in the conversation and is not presented as
  // one. The disclosure is this card; there is no tile, no name, no avatar.
  it('presents the observer as a fact about the round, never as somebody in it', () => {
    expect(card()).not.toMatch(/participant|joins you|says hello/i);
  });
});

describe('a round that cannot go ahead', () => {
  const block = {
    reason: 'The candidate has not agreed to this round being recorded. Every human round is recorded.',
    nextSteps: ['Talk to them and rebook.', 'Or take the candidate out of this stage.'],
  };
  const card = () => html(createElement(RoundBlockedCard, { block }));

  it('says why, in the server\'s own sentence', () => {
    expect(card()).toContain(block.reason);
  });

  it('never leaves the reader without something they can do', () => {
    expect(card()).toMatch(/Talk to them and rebook[\s\S]*take the candidate out of this stage/);
  });
});

describe('the room controls', () => {
  const controls = (phase: Parameters<typeof ObserverRoomControls>[0]['phase'], extra: Partial<Parameters<typeof ObserverRoomControls>[0]> = {}) =>
    html(createElement(ObserverRoomControls, {
      phase, awaiting: [], busy: false, stopSentence: '', reason: '', onReasonChange: noop,
      onStop: noop, onEnd: noop, ...extra,
    }));

  it('puts a stop in front of whoever is in the room while it is recording', () => {
    expect(controls('listening')).toContain('Stop recording');
  });

  it('shows the listening indicator while listening', () => {
    expect(controls('listening')).toContain('Observer is listening');
  });

  /**
   * The guard on "nobody presses record".
   *
   * Capture begins when the room is entered, and the room cannot be entered
   * without an agreement from everyone whose voice it captures. A start button
   * would be a control over something already settled, and its reappearance
   * would mean somebody had put a room back that can be occupied but not
   * recording — which is a round that produces no evidence.
   */
  it('offers nothing to start, in any phase', () => {
    const everyPhase = (['gate', 'awaiting_others', 'listening', 'stopped', 'declined', 'ended', 'unavailable'] as const)
      .map((phase) => controls(phase));

    expect(everyPhase.join('')).not.toMatch(/start listening|start recording|begin recording/i);
  });

  it('says what it is waiting for rather than showing an idle room', () => {
    expect(controls('awaiting_others', { awaiting: ['candidate'] })).toContain('Waiting for the candidate');
  });

  it('explains a stop and offers no way to restart', () => {
    const out = controls('stopped', { stopSentence: 'Recording stopped part-way through this round.' });

    expect(out).toContain('Recording stopped part-way through this round.');
    expect(out).not.toMatch(/start listening/i);
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

  /**
   * The room must not be the one surface that still calls a one-sided
   * recording a transcript while every rule behind it refuses to
   * (`evidenceKindOf`, `mayExtract`). The words are still worth reading — they
   * are just the interviewer's, and the heading has to say so.
   */
  it('does not call a one-sided recording a transcript', () => {
    const out = view(observation({ oneSided: true }));

    expect(out).toContain('What the recording caught');
    expect(out).not.toMatch(/>Transcript/);
  });

  it('says why, above the words, so a reader knows what they are looking at', () => {
    const out = view(observation({
      oneSided: true,
      captureReport: { coverage: 'one_sided', sentence: 'Only one voice was captured in this round.' },
    }));

    expect(out).toContain('Only one voice was captured in this round.');
  });

  it('still calls an ordinary recording a transcript', () => {
    expect(view()).toContain('Transcript');
  });
});

describe('saying why you are stopping', () => {
  const box = () => html(createElement(WithdrawalReason, { value: '', onChange: noop, label: 'Why, if you like?' }));

  it('asks, because the reason is what tells the hiring team how to proceed', () => {
    expect(box()).toContain('Why, if you like?');
  });

  // Never required. A person exercising a right to stop being recorded must
  // not have to argue for it first, and the page says so beside the box rather
  // than only in a placeholder nobody reads.
  it('says plainly that it is optional', () => {
    expect(box()).toContain('You do not have to give a reason to stop');
  });
});

describe('the candidate consent page', () => {
  const base: CandidateConsentView = {
    status: 'AWAITING_CONSENT', organisation: 'Acme', stage: 'Gold', notice: NOTICE,
    consequence: 'If you would rather not be recorded, this round will not go ahead as booked.',
    decision: 'pending', canConsent: true, canDecline: true, canStop: false, listening: false,
    awaiting: ['candidate'], refusal: null,
  };
  const page = (v: Partial<CandidateConsentView> = {}) =>
    html(createElement(CandidateObserverConsent, {
      view: { ...base, ...v }, busy: false, reason: '', onReasonChange: noop,
      onConsent: noop, onDecline: noop, onStop: noop,
    }));

  it('shows the notice and asks for a decision', () => {
    expect(page()).toMatch(new RegExp(`${NOTICE}[\\s\\S]*I agree[\\s\\S]*I would rather not be recorded`));
  });

  // Said before the press, never discovered after it: declining here is not
  // like declining the AI round's microphone, and the difference matters.
  it('says what declining will mean before the candidate decides', () => {
    expect(page()).toContain('this round will not go ahead as booked');
  });

  it('lets the candidate stop it while it is recording, and says it is recording', () => {
    const out = page({ status: 'LISTENING', decision: 'consented', canConsent: false, canDecline: false, canStop: true, listening: true });

    expect(out).toContain('Stop recording');
    expect(out).toContain('Observer is listening');
  });

  it('offers nothing to press once declined', () => {
    expect(page({ status: 'DECLINED', decision: 'declined', canConsent: false, canDecline: false })).not.toContain('<button');
  });

  it('offers a place to say why, beside the decline', () => {
    expect(page()).toContain('observer-withdrawal-reason');
  });

  it('does not put it in front of somebody who has already decided', () => {
    expect(page({ status: 'DECLINED', decision: 'declined', canConsent: false, canDecline: false }))
      .not.toContain('observer-withdrawal-reason');
  });

  // Declining to be recorded is a legitimate choice, and this is the last thing
  // the candidate reads after making it. It is a fact about the round.
  it('does not blame the candidate for declining', () => {
    const out = page({ status: 'DECLINED', decision: 'declined', canConsent: false, canDecline: false });

    expect(out).toContain('the hiring team has been told');
    expect(out).not.toMatch(/refus|fault|unwilling/i);
  });
});
