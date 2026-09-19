import { describe, it, expect } from 'vitest';
import {
  isNearBottom, fromTranscript, aiStatus, candidateStatus, avatarInitial, initials,
} from '../src/components/room/roomConversationModel';

describe('isNearBottom', () => {
  it('follows new messages when the reader is at the bottom', () => {
    expect(isNearBottom({ scrollTop: 500, clientHeight: 300, scrollHeight: 800 })).toBe(true);
  });

  it('allows a little slack for rounding and a line in progress', () => {
    expect(isNearBottom({ scrollTop: 460, clientHeight: 300, scrollHeight: 800 })).toBe(true);
  });

  it('stops following when the reader has scrolled up', () => {
    expect(isNearBottom({ scrollTop: 100, clientHeight: 300, scrollHeight: 800 })).toBe(false);
  });
});

describe('fromTranscript', () => {
  const lines = [
    { speaker: 'agent' as const, text: 'Tell me about your role.' },
    { speaker: 'candidate' as const, text: 'I lead a data team.' },
  ];

  it('keeps the conversation in order', () => {
    expect(fromTranscript(lines, { fresh: false }).map((m) => `${m.speaker}:${m.text}`)).toEqual([
      'agent:Tell me about your role.', 'candidate:I lead a data team.',
    ]);
  });

  it('gives every message a distinct id', () => {
    expect(new Set(fromTranscript(lines, { fresh: false }).map((m) => m.id)).size).toBe(2);
  });

  it('stamps nothing on a rejoin, where the record carries no times', () => {
    expect(fromTranscript(lines, { fresh: false }).every((m) => m.atMs === null)).toBe(true);
  });

  it('stamps the opening at zero on a fresh start', () => {
    expect(fromTranscript([lines[0]], { fresh: true })[0].atMs).toBe(0);
  });
});

describe('aiStatus', () => {
  it('says the interviewer is waiting while the candidate has paused', () => {
    expect(aiStatus('listening', true)).toBe('Waiting for you');
  });

  it('says listening on the candidate turn', () => {
    expect(aiStatus('listening', false)).toBe('Listening');
  });
});

describe('candidateStatus', () => {
  it('says typing in a typed mode', () => {
    expect(candidateStatus({ phase: 'listening', textMode: true, speakingNow: false })).toBe('Typing');
  });

  it('says speaking when the mic hears them on their turn', () => {
    expect(candidateStatus({ phase: 'listening', textMode: false, speakingNow: true })).toBe('Speaking');
  });

  it('invites them to speak on a quiet turn', () => {
    expect(candidateStatus({ phase: 'listening', textMode: false, speakingNow: false })).toBe('Your turn — speak now');
  });

  it('says the mic is ready while the interviewer talks', () => {
    expect(candidateStatus({ phase: 'speaking', textMode: false, speakingNow: false })).toBe('Mic ready');
  });
});

describe('avatarInitial', () => {
  it('is the first letter of the name', () => {
    expect(avatarInitial('maya')).toBe('M');
  });

  it('falls back to AI when there is no name', () => {
    expect(avatarInitial(null)).toBe('AI');
  });
});

describe('initials', () => {
  it('takes the first two names', () => {
    expect(initials('Priya Anand Sharma')).toBe('PA');
  });
});
