import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INTERVIEWER_CHOICE,
  interviewerChoices,
  isInterviewerChoice,
  interviewRoomHeader,
  pickBrowserVoice,
  roomAiFact,
  splitDisclosure,
  aiAcknowledgement,
  whatHappensFirst,
  type PublicInterviewer,
} from '../src/components/interviewerModel';

const LIST: PublicInterviewer[] = [
  { id: 'theo', name: 'Theo', avatarUrl: '', sortOrder: 5 },
  { id: 'avery', name: 'Avery', avatarUrl: '', sortOrder: 1 },
  { id: 'maya', name: 'Maya', avatarUrl: '', sortOrder: 2 },
  { id: 'elena', name: 'Elena', avatarUrl: '', sortOrder: 4 },
  { id: 'adrian', name: 'Adrian', avatarUrl: '', sortOrder: 3 },
];

describe('interviewer selector model', () => {
  it('defaults to Random', () => {
    expect(DEFAULT_INTERVIEWER_CHOICE).toBe('random');
  });

  it('offers Random first, then the interviewers in their order', () => {
    expect(interviewerChoices(LIST).map((c) => c.label)).toEqual(['Random — Recommended', 'Avery', 'Maya', 'Adrian', 'Elena', 'Theo']);
  });

  it('marks only the named interviewers as previewable', () => {
    expect(interviewerChoices(LIST).map((c) => c.previewable)).toEqual([false, true, true, true, true, true]);
  });

  it('carries no personality description on any option', () => {
    const text = JSON.stringify(interviewerChoices(LIST)).toLowerCase();
    expect(text).not.toMatch(/warm|professional|friendly|strict|technical|formal|neutral|calm|tough|gentle/);
  });

  it('offers only Random before the list has loaded', () => {
    expect(interviewerChoices([]).map((c) => c.value)).toEqual(['random']);
  });

  it('accepts Random and a listed interviewer', () => {
    expect([isInterviewerChoice('random', LIST), isInterviewerChoice('maya', LIST)]).toEqual([true, true]);
  });

  it('rejects an interviewer that is not listed', () => {
    expect(isInterviewerChoice('nobody', LIST)).toBe(false);
  });
});

describe('interviewRoomHeader', () => {
  it('shows just the interviewer name, like a real call', () => {
    expect(interviewRoomHeader({ name: 'Maya' })).toEqual({ name: 'Maya', initial: 'M' });
  });

  it('falls back to "Your interviewer" when the session records no name', () => {
    expect(interviewRoomHeader({ name: null })).toEqual({ name: 'Your interviewer', initial: 'Y' });
  });
});

describe('roomAiFact', () => {
  it('keeps the AI fact reachable in the room', () => {
    expect(roomAiFact('Maya')).toBe('Maya is an AI interviewer. A person on the hiring team reviews the interview.');
  });

  it('still states it without a name', () => {
    expect(roomAiFact(null)).toBe('Your interviewer is an AI interviewer. A person on the hiring team reviews the interview.');
  });
});

describe('consent screen wording', () => {
  const DISCLOSURE = 'Your interviewer today is Maya, an AI interviewer from Questor. A person on the hiring team reviews the interview. Your voice is transcribed as we talk.';

  it('lifts the interviewer introduction out of the disclosure so it can be shown prominently', () => {
    expect(splitDisclosure(DISCLOSURE)).toEqual({
      intro: 'Your interviewer today is Maya, an AI interviewer from Questor. A person on the hiring team reviews the interview.',
      rest: 'Your voice is transcribed as we talk.',
    });
  });

  it('leaves a disclosure without the introduction whole', () => {
    expect(splitDisclosure('Tenant wording only.')).toEqual({ intro: '', rest: 'Tenant wording only.' });
  });

  it('names the interviewer in the AI acknowledgement', () => {
    expect(aiAcknowledgement('Maya')).toBe('I understand this first round is conducted by Maya, an AI interviewer, and reviewed by a person on the hiring team, and I agree to proceed.');
  });

  it('keeps the acknowledgement meaningful without a name', () => {
    expect(aiAcknowledgement(null)).toBe('I understand this first round is conducted by an AI interviewer and reviewed by a person on the hiring team, and I agree to proceed.');
  });

  it('says what happens when the interview starts', () => {
    expect(whatHappensFirst('Maya')).toBe('When you join, Maya will greet you, say briefly what the role is mainly looking for, and start with a question about your current work.');
  });
});

describe('pickBrowserVoice', () => {
  const voices = [
    { name: 'Microsoft David - English (United States)', lang: 'en-US' },
    { name: 'Microsoft Zira - English (United States)', lang: 'en-US' },
    { name: 'Google UK English Male', lang: 'en-GB' },
    { name: 'Google US English', lang: 'en-US' },
    { name: 'Microsoft Aria Online (Natural)', lang: 'en-US' },
    { name: 'Thomas', lang: 'fr-FR' },
  ];

  it('picks the first female English voice for female:0', () => {
    expect(pickBrowserVoice(voices, 'female:0')?.name).toBe('Microsoft Zira - English (United States)');
  });

  it('picks a different female voice for female:1', () => {
    expect(pickBrowserVoice(voices, 'female:1')?.name).toBe('Google US English');
  });

  it('picks a male English voice for male:0', () => {
    expect(pickBrowserVoice(voices, 'male:0')?.name).toBe('Microsoft David - English (United States)');
  });

  it('wraps round when there are fewer matching voices than the ordinal', () => {
    expect(pickBrowserVoice(voices, 'male:3')?.name).toBe('Google UK English Male');
  });

  it('falls back to any English voice for an unknown hint', () => {
    expect(pickBrowserVoice(voices, '')?.lang).toMatch(/^en/);
  });

  it('returns null when the browser has no voices', () => {
    expect(pickBrowserVoice([], 'female:0')).toBe(null);
  });
});
