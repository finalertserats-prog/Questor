import { describe, it, expect } from 'vitest';
import { entryFromRefusal, portalEntry } from '../src/components/portalEntryModel';

// Copied from server/src/domain/stateMachine.ts (SESSION_STATES then
// EXCEPTION_STATES). The web cannot import the server, so the list lives here;
// a state added there without a screen here falls through to the safe
// "not open right now" card rather than the consent form.
const SESSION_STATES = [
  'PROVISIONED', 'INVITED', 'ACCEPTED', 'READY_CHECK', 'WAITING', 'CONNECTING',
  'DISCLOSURE', 'CONSENTED', 'WARMUP', 'ASSESSING', 'CANDIDATE_QUESTIONS',
  'CLOSING', 'PROCESSING', 'REVIEW_READY', 'HUMAN_REVIEWED', 'CLOSED',
];
const EXCEPTION_STATES = [
  'RESCHEDULE_REQUIRED', 'NO_SHOW', 'CANDIDATE_WITHDREW', 'TECHNICAL_FAILURE',
  'POLICY_STOP', 'MANUAL_HANDOFF', 'CANCELLED', 'INCOMPLETE',
];
const ALL_STATES = [...SESSION_STATES, ...EXCEPTION_STATES];

// Consent on record unless a test says otherwise: it only changes the answer
// for the three states between consent and the interview going live.
const kindOf = (state: string, consented = true) => portalEntry(state, consented).kind;
const textOf = (state: string, consented = true) => {
  const entry = portalEntry(state, consented);
  return entry.kind === 'journey' ? '' : `${entry.title} ${entry.message}`;
};

describe('portalEntry before the interview', () => {
  it.each(['PROVISIONED', 'INVITED', 'ACCEPTED', 'READY_CHECK', 'DISCLOSURE', 'CONSENTED'])(
    'opens the consent journey in %s',
    (state) => { expect(kindOf(state)).toBe('journey'); },
  );
});

describe('portalEntry while the interview is live', () => {
  it.each(['ASSESSING', 'CANDIDATE_QUESTIONS'])('offers to rejoin in %s', (state) => {
    expect(kindOf(state)).toBe('rejoin');
  });

  it('labels the live button "Rejoin interview"', () => {
    const entry = portalEntry('ASSESSING');
    expect(entry.kind === 'rejoin' && entry.action).toBe('Rejoin interview');
  });

  it('tells the candidate the interview is in progress', () => {
    expect(textOf('CANDIDATE_QUESTIONS')).toMatch(/in progress/);
  });

  // Startable by the engine but past the consent step: entering the room is the
  // only thing left to do, so the form the server would refuse is not offered.
  it.each(['WAITING', 'CONNECTING', 'WARMUP'])('lets a candidate who consented go straight in from %s', (state) => {
    expect(kindOf(state)).toBe('rejoin');
  });

  // The room refuses to start without consent and sends them back here; a
  // button into it would be a loop.
  it.each(['WAITING', 'CONNECTING', 'WARMUP'])('offers no way in from %s when consent is not on record', (state) => {
    expect(kindOf(state, false)).toBe('closed');
  });

  it('still offers to rejoin a live interview whatever the consent flag says', () => {
    expect(kindOf('ASSESSING', false)).toBe('rejoin');
  });

  it('defaults to consent not being on record', () => {
    expect(portalEntry('WAITING').kind).toBe('closed');
  });

  it('labels a not-yet-begun room "Join interview"', () => {
    const entry = portalEntry('WAITING', true);
    expect(entry.kind === 'rejoin' && entry.action).toBe('Join interview');
  });
});

describe('portalEntry after the interview', () => {
  it.each(['CLOSING', 'PROCESSING', 'REVIEW_READY', 'HUMAN_REVIEWED', 'CLOSED'])('shows the finished card in %s', (state) => {
    expect(kindOf(state)).toBe('finished');
  });

  it('thanks the candidate and says the team will be in touch', () => {
    expect(textOf('REVIEW_READY')).toMatch(/Thank you — the hiring team will be in touch\./);
  });
});

describe('portalEntry for an interview that is not open', () => {
  it.each(EXCEPTION_STATES)('shows a closed card in %s', (state) => {
    expect(kindOf(state)).toBe('closed');
  });

  it('explains an interview stopped part-way without assigning blame', () => {
    expect(textOf('INCOMPLETE')).toMatch(/stopped before it finished\. The hiring team will contact you about next steps\./);
  });

  it('describes a safety stop in the same neutral words as an incomplete one', () => {
    expect(portalEntry('POLICY_STOP')).toEqual(portalEntry('INCOMPLETE'));
  });

  it('confirms a handoff request is with a person', () => {
    expect(textOf('MANUAL_HANDOFF')).toMatch(/interviewed by a person/);
  });

  it('says a rescheduled interview will get a new time', () => {
    expect(textOf('RESCHEDULE_REQUIRED')).toMatch(/new time/);
  });

  it('says a cancelled interview is cancelled', () => {
    expect(textOf('CANCELLED')).toMatch(/cancelled/);
  });

  it('says a technical failure was on our side', () => {
    expect(textOf('TECHNICAL_FAILURE')).toMatch(/on our side/);
  });

  // TECHNICAL_FAILURE is also where a finished interview lands when our
  // processing of it fails, so it must not say the interview was cut short.
  it('does not tell a candidate who finished that their interview was cut short', () => {
    expect(textOf('TECHNICAL_FAILURE')).not.toMatch(/interrupted|stopped|before it finished/);
  });

  it('does not tell a candidate who stopped that they failed to show up', () => {
    expect(textOf('CANDIDATE_WITHDREW')).not.toMatch(/passed|missed/);
  });

  it('gives every exception state its own explanation rather than the fallback', () => {
    const fallback = textOf('SOMETHING_NEW');
    expect(EXCEPTION_STATES.filter((s) => textOf(s) === fallback)).toEqual([]);
  });
});

describe('portalEntry for a state it does not know', () => {
  it('never falls back to the consent journey', () => {
    expect(kindOf('SOMETHING_NEW')).toBe('closed');
  });

  it('points the candidate at their invitation email', () => {
    expect(textOf('SOMETHING_NEW')).toMatch(/reply to your invitation email/);
  });

  it('handles an empty state the same way', () => {
    expect(kindOf('')).toBe('closed');
  });
});

describe('portalEntry wording', () => {
  // An internal state name on this page reads as a crash, and some read as a
  // verdict on the candidate.
  it.each(ALL_STATES)('never shows an internal state name in %s', (state) => {
    expect(textOf(state)).not.toMatch(/\b[A-Z]{3,}(_[A-Z]+)*\b/);
  });

  it('covers every known state with a deliberate screen', () => {
    const unknown = textOf('SOMETHING_NEW');
    expect(ALL_STATES.filter((s) => kindOf(s) === 'closed' && textOf(s) === unknown)).toEqual([]);
  });
});

describe('entryFromRefusal', () => {
  it('reads the server\'s "already been completed" 410 as the finished card', () => {
    const entry = entryFromRefusal(410, 'This interview has already been completed. Our team will be in touch.');
    expect(entry?.kind).toBe('finished');
  });

  it('leaves an expired invitation as an error', () => {
    expect(entryFromRefusal(410, 'This invitation has expired')).toBeNull();
  });

  it('leaves any other refusal as an error', () => {
    expect(entryFromRefusal(400, 'Consent to proceed is required.')).toBeNull();
  });

  it('leaves a network failure with no status as an error', () => {
    expect(entryFromRefusal(undefined, 'already been completed')).toBeNull();
  });
});
