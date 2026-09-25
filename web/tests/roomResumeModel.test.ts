import { describe, it, expect } from 'vitest';
import {
  ANSWER_SAVED, MAX_CLOCK_OFFSET_MS, PICKING_UP, REPLY_POLL_BUDGET_MS, WELCOME_BACK,
  keepWaitingForReply, roomOpening, roomRefusal, type StartResponse,
} from '../src/components/roomResumeModel';

const turn = (over: Partial<StartResponse['turn']> = {}): StartResponse['turn'] =>
  ({ turnId: 't2', text: 'Tell me about a pipeline you built.', done: false, ...over });

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

  it('sets the clock back to where the record leaves off', () => {
    expect(roomOpening(rejoin).clockOffsetMs).toBe(95_000);
  });

  it('ignores a negative elapsed time', () => {
    expect(roomOpening({ ...rejoin, elapsedMs: -5 }).clockOffsetMs).toBe(0);
  });

  it('ignores an elapsed time that is not a number', () => {
    expect(roomOpening({ ...rejoin, elapsedMs: Number.NaN }).clockOffsetMs).toBe(0);
  });

  it('caps an absurd elapsed time so later answers stay within the server limit', () => {
    expect(roomOpening({ ...rejoin, elapsedMs: 23 * 60 * 60 * 1000 }).clockOffsetMs).toBe(MAX_CLOCK_OFFSET_MS);
  });
});

describe('roomOpening when the last answer has no reply yet', () => {
  const pending = (ageMs?: number): StartResponse => ({
    turn: turn({ turnId: 't0', text: opening.text }), resumed: true, history: [opening, answer],
    awaitingReply: true, pendingAnswerAgeMs: ageMs, elapsedMs: 40_000,
  });

  it('waits for the reply when the answer was sent moments ago', () => {
    expect(roomOpening(pending(3_000)).mode).toBe('wait');
  });

  it('says it is picking up where it left off while waiting', () => {
    expect(roomOpening(pending(3_000)).captionPrefix).toBe(PICKING_UP);
  });

  it('stops waiting once the wait is used up', () => {
    expect(roomOpening(pending(3_000), { allowWait: false }).mode).toBe('listen');
  });

  it('does not wait for a reply to an answer from long ago', () => {
    expect(roomOpening(pending(10 * 60_000)).mode).toBe('listen');
  });

  it('does not wait when the server gives no age', () => {
    expect(roomOpening(pending(undefined)).mode).toBe('listen');
  });

  it('tells the candidate their answer was saved and they can continue', () => {
    expect(roomOpening(pending(10 * 60_000)).captionPrefix).toBe(ANSWER_SAVED);
  });

  it('shows their stored answer last', () => {
    expect(roomOpening(pending(3_000)).messages.at(-1)).toEqual(answer);
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

describe('keepWaitingForReply', () => {
  it('keeps waiting inside the budget', () => {
    expect(keepWaitingForReply(REPLY_POLL_BUDGET_MS - 1)).toBe(true);
  });

  it('stops at the budget', () => {
    expect(keepWaitingForReply(REPLY_POLL_BUDGET_MS)).toBe(false);
  });
});

describe('roomRefusal', () => {
  it('reads a completed interview as finished, not as something to retry', () => {
    expect(roomRefusal(410, undefined, 'This interview has already been completed. Our team will be in touch.')).toBe('finished');
  });

  it('reads a stale question as stale', () => {
    expect(roomRefusal(409, 'stale_question', 'The interviewer has already moved on to the next question.')).toBe('stale');
  });

  it('does not read another conflict as stale', () => {
    expect(roomRefusal(409, undefined, 'This interview is no longer accepting answers.')).toBe('error');
  });

  it('leaves an expired invitation as an error', () => {
    expect(roomRefusal(410, undefined, 'This invitation has expired')).toBe('error');
  });

  it('leaves a network failure as an error', () => {
    expect(roomRefusal(undefined, undefined, 'Failed to fetch')).toBe('error');
  });
});
