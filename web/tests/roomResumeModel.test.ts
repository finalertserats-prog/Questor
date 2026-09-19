import { describe, it, expect } from 'vitest';
import { ANSWER_SAVED, WELCOME_BACK, roomOpening, type StartResponse } from '../src/components/roomResumeModel';

const turn = (over: Partial<StartResponse['turn']> = {}): StartResponse['turn'] =>
  ({ turnId: 't2', text: 'Tell me about a pipeline you built.', competencyId: 'c1', kind: 'question', done: false, ...over });

const opening = { speaker: 'agent' as const, text: 'Hello, I am the AI interviewer.' };
const answer = { speaker: 'candidate' as const, text: 'I moved batch jobs to streaming.' };
const question = { speaker: 'agent' as const, text: 'Tell me about a pipeline you built.' };

describe('roomOpening on a fresh start', () => {
  const fresh: StartResponse = { turn: turn({ text: opening.text }), resumed: false, history: [opening], awaitingReply: false, elapsedMs: 0 };

  it('speaks the opening', () => {
    expect(roomOpening(fresh).mode).toBe('speak');
  });

  it('shows no welcome-back line', () => {
    expect(roomOpening(fresh).captionPrefix).toBe('');
  });

  it('shows the opening as the transcript', () => {
    expect(roomOpening(fresh).messages).toEqual([opening]);
  });

  it('starts the clock from zero', () => {
    expect(roomOpening(fresh).clockOffsetMs).toBe(0);
  });
});

describe('roomOpening on a rejoin', () => {
  const rejoin: StartResponse = { turn: turn(), resumed: true, history: [opening, answer, question], awaitingReply: false, elapsedMs: 95_000 };

  it('speaks the pending question', () => {
    expect(roomOpening(rejoin).turn.turnId).toBe('t2');
  });

  it('speaks rather than waiting silently', () => {
    expect(roomOpening(rejoin).mode).toBe('speak');
  });

  it('prefixes the caption with the same short welcome every time', () => {
    expect(roomOpening(rejoin).captionPrefix).toBe(WELCOME_BACK);
  });

  it('restores the conversation so far', () => {
    expect(roomOpening(rejoin).messages).toEqual([opening, answer, question]);
  });

  it('sets the clock back by how far in the interview already is', () => {
    expect(roomOpening(rejoin).clockOffsetMs).toBe(95_000);
  });

  it('ignores a negative elapsed time', () => {
    expect(roomOpening({ ...rejoin, elapsedMs: -5 }).clockOffsetMs).toBe(0);
  });

  it('ignores an elapsed time that is not a number', () => {
    expect(roomOpening({ ...rejoin, elapsedMs: Number.NaN }).clockOffsetMs).toBe(0);
  });
});

describe('roomOpening when the last answer has no reply yet', () => {
  const pending: StartResponse = { turn: turn({ turnId: 't0', text: opening.text }), resumed: true, history: [opening, answer], awaitingReply: true, elapsedMs: 40_000 };

  it('listens without asking the answered question again', () => {
    expect(roomOpening(pending).mode).toBe('listen');
  });

  it('tells the candidate their answer was saved', () => {
    expect(roomOpening(pending).captionPrefix).toBe(ANSWER_SAVED);
  });

  it('shows their stored answer last', () => {
    expect(roomOpening(pending).messages.at(-1)).toEqual(answer);
  });
});

describe('roomOpening against an older server', () => {
  const legacy: StartResponse = { turn: turn({ text: opening.text }) };

  it('shows the turn alone as the transcript', () => {
    expect(roomOpening(legacy).messages).toEqual([opening]);
  });

  it('treats it as a fresh start', () => {
    expect(roomOpening(legacy).captionPrefix).toBe('');
  });

  it('never trusts awaitingReply without resumed', () => {
    expect(roomOpening({ ...legacy, awaitingReply: true }).mode).toBe('speak');
  });
});
