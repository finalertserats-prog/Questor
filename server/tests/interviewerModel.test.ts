import { describe, it, expect } from 'vitest';
import {
  INTERVIEWER_CATALOGUE,
  VOICE_PROFILE_CATALOGUE,
  composeDisclosure,
  consentIntro,
  defaultVoiceFor,
  duplicateVoices,
  hasConsentIntro,
  needsInterviewerBackfill,
  otherInterviewerNamed,
  resolveProfileVoice,
  parseVoiceOverride,
  pickInterviewer,
  voiceOverridesFromEnv,
} from '../src/domain/interviewerModel.js';

// The five interviewers differ in name and voice and in nothing else. These
// tests pin the catalogue, the consent-screen introduction built from the name, and the
// parsing of the backend-only voice configuration.

const RETIRED = ['Schr', 'anders'].join('');

describe('interviewer catalogue', () => {
  it('lists Avery, Maya, Adrian, Elena and Theo in that order', () => {
    expect(INTERVIEWER_CATALOGUE.map((i) => i.name)).toEqual(['Avery', 'Maya', 'Adrian', 'Elena', 'Theo']);
  });

  it('maps each interviewer to its own numbered voice profile', () => {
    expect(INTERVIEWER_CATALOGUE.map((i) => `${i.id}:${i.voiceProfileId}`)).toEqual([
      'avery:voice_01', 'maya:voice_02', 'adrian:voice_03', 'elena:voice_04', 'theo:voice_05',
    ]);
  });

  it('names every voice profile after its interviewer', () => {
    expect(VOICE_PROFILE_CATALOGUE.map((v) => v.displayName)).toEqual([
      'Avery Voice', 'Maya Voice', 'Adrian Voice', 'Elena Voice', 'Theo Voice',
    ]);
  });

  it('gives each interviewer a distinct default OpenAI voice', () => {
    const voices = VOICE_PROFILE_CATALOGUE.map((v) => defaultVoiceFor(v.id, 'openai'));
    expect(new Set(voices).size).toBe(5);
  });

  it('only uses voices OpenAI documents for gpt-4o-mini-tts', () => {
    // https://developers.openai.com/api/docs/guides/text-to-speech (voice options)
    const documented = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
    const voices = VOICE_PROFILE_CATALOGUE.map((v) => defaultVoiceFor(v.id, 'openai'));
    expect(voices.every((v) => documented.includes(v))).toBe(true);
  });

  it('leaves the voice empty for a provider with no documented default', () => {
    expect(defaultVoiceFor('voice_01', 'elevenlabs')).toBe('');
  });

  it('carries no personality words anywhere in the catalogue', () => {
    const text = JSON.stringify([INTERVIEWER_CATALOGUE, VOICE_PROFILE_CATALOGUE]).toLowerCase();
    expect(text).not.toMatch(/warm|friendly|strict|formal|technical|professional|tough|gentle|energetic|calm/);
  });
});

describe('parseVoiceOverride', () => {
  it('reads provider:voiceId', () => {
    expect(parseVoiceOverride('openai:marin')).toEqual({ provider: 'openai', voiceId: 'marin' });
  });

  it('accepts an ElevenLabs voice id', () => {
    expect(parseVoiceOverride('elevenlabs:AbCdEf123456')).toEqual({ provider: 'elevenlabs', voiceId: 'AbCdEf123456' });
  });

  it('rejects an unknown provider', () => {
    expect(parseVoiceOverride('acme:voice')).toBe(null);
  });

  it('rejects a value without a voice id', () => {
    expect(parseVoiceOverride('openai:')).toBe(null);
  });

  it('rejects a voice id carrying path or query characters', () => {
    expect(parseVoiceOverride('elevenlabs:../../v1/admin?x=1')).toBe(null);
  });
});

describe('voiceOverridesFromEnv', () => {
  it('maps VOICE_PROFILE_0N onto voice_0N', () => {
    const { overrides } = voiceOverridesFromEnv({ VOICE_PROFILE_02: 'openai:coral', VOICE_PROFILE_05: 'elevenlabs:xyz789' });
    expect(overrides).toEqual([
      { profileId: 'voice_02', provider: 'openai', voiceId: 'coral' },
      { profileId: 'voice_05', provider: 'elevenlabs', voiceId: 'xyz789' },
    ]);
  });

  it('reports malformed values by variable name only', () => {
    const { invalid } = voiceOverridesFromEnv({ VOICE_PROFILE_03: 'nonsense' });
    expect(invalid).toEqual(['VOICE_PROFILE_03']);
  });

  it('ignores unset variables', () => {
    expect(voiceOverridesFromEnv({}).overrides).toEqual([]);
  });
});

describe('consentIntro', () => {
  it('names the interviewer as an AI interviewer and says a person reviews the interview', () => {
    expect(consentIntro('Maya')).toBe('Your interviewer today is Maya, an AI interviewer from Questor. A person on the hiring team reviews the interview.');
  });

  it('still says it is an AI interviewer when the record has no name', () => {
    expect(consentIntro(null)).toBe('Your interviewer today is an AI interviewer from Questor. A person on the hiring team reviews the interview.');
  });
});

describe('composeDisclosure', () => {
  const body = 'Your voice is transcribed as we talk — no audio recording is kept, but the written transcript is, and a person on the hiring team reads it.';

  it('puts the named introduction before the disclosure', () => {
    expect(composeDisclosure('Theo', body)).toBe(`${consentIntro('Theo')} ${body}`);
  });

  it('replaces a legacy spoken self-introduction instead of introducing twice', () => {
    const legacy = `Hello, I'm ${RETIRED}, an AI interviewer for this first-round conversation. ${body}`;
    expect(composeDisclosure('Elena', legacy)).toBe(`${consentIntro('Elena')} ${body}`);
  });

  it('replaces the unnamed retake introduction', () => {
    const legacy = `Hello, I'm an AI interviewer for this first-round conversation. ${body}`;
    expect(composeDisclosure('Adrian', legacy)).toBe(`${consentIntro('Adrian')} ${body}`);
  });

  it('replaces the short-lived spoken opening introduction', () => {
    const legacy = `Hi, I'm Maya, your AI interviewer from Questor. I'll be conducting your first-round interview today. ${body}`;
    expect(composeDisclosure('Maya', legacy)).toBe(`${consentIntro('Maya')} ${body}`);
  });

  it('is idempotent, so re-composing never stacks introductions', () => {
    const once = composeDisclosure('Maya', body);
    expect(composeDisclosure('Maya', once)).toBe(once);
  });

  it('swaps one interviewer for another in an already composed disclosure', () => {
    expect(composeDisclosure('Avery', composeDisclosure('Maya', body))).toBe(`${consentIntro('Avery')} ${body}`);
  });

  it('keeps every word of the disclosure after the introduction', () => {
    expect(composeDisclosure('Maya', body).endsWith(body)).toBe(true);
  });
});

describe('pickInterviewer', () => {
  const active = [{ id: 'maya' }, { id: 'theo' }];

  it('picks the entry the random index names', () => {
    expect(pickInterviewer(active, (max) => max - 1)).toEqual({ id: 'theo' });
  });

  it('draws over exactly the active list', () => {
    let seenMax = 0;
    pickInterviewer(active, (max) => { seenMax = max; return 0; });
    expect(seenMax).toBe(2);
  });

  it('refuses to pick from an empty list', () => {
    expect(() => pickInterviewer([], () => 0)).toThrow();
  });
});

describe('needsInterviewerBackfill', () => {
  it('flags the retired default name', () => {
    expect(needsInterviewerBackfill({ name: 'Schranders', tone: 'warm' })).toBe(true);
  });

  it('flags a persona with no interviewer id', () => {
    expect(needsInterviewerBackfill({ name: 'Alex', tone: 'warm' })).toBe(true);
  });

  it('leaves an assigned interviewer alone', () => {
    expect(needsInterviewerBackfill({ interviewerId: 'maya', name: 'Maya', tone: 'formal' })).toBe(false);
  });
});

describe('resolveProfileVoice', () => {
  it('uses the configured provider default when there is no override', () => {
    expect(resolveProfileVoice('voice_03', {}, 'openai')).toEqual({ provider: 'openai', voiceId: 'cedar' });
  });

  it('follows a switch of the configured provider, whatever was seeded', () => {
    expect(resolveProfileVoice('voice_03', {}, 'elevenlabs')).toEqual({ provider: 'elevenlabs', voiceId: '' });
  });

  it('honours an explicit VOICE_PROFILE_0N override, even for another provider', () => {
    expect(resolveProfileVoice('voice_03', { VOICE_PROFILE_03: 'elevenlabs:abc123' }, 'openai')).toEqual({ provider: 'elevenlabs', voiceId: 'abc123' });
  });

  it('ignores a malformed override and falls back to the configured default', () => {
    expect(resolveProfileVoice('voice_03', { VOICE_PROFILE_03: 'nonsense' }, 'openai')).toEqual({ provider: 'openai', voiceId: 'cedar' });
  });
});

describe('duplicateVoices', () => {
  it('names profiles that resolve to the same provider voice', () => {
    expect(duplicateVoices([
      { profileId: 'voice_01', provider: 'elevenlabs', voiceId: '' },
      { profileId: 'voice_02', provider: 'elevenlabs', voiceId: '' },
      { profileId: 'voice_03', provider: 'openai', voiceId: 'cedar' },
    ])).toEqual([['voice_01', 'voice_02']]);
  });

  it('is empty when every profile has its own voice', () => {
    expect(duplicateVoices([
      { profileId: 'voice_01', provider: 'openai', voiceId: 'sage' },
      { profileId: 'voice_02', provider: 'openai', voiceId: 'marin' },
    ])).toEqual([]);
  });
});

describe('hasConsentIntro', () => {
  it('recognises a disclosure that names the AI interviewer up front', () => {
    expect(hasConsentIntro(composeDisclosure('Maya', 'Your voice is transcribed.'))).toBe(true);
  });

  it('refuses an empty disclosure', () => {
    expect(hasConsentIntro('')).toBe(false);
  });

  it('refuses a disclosure that never says who the interviewer is', () => {
    expect(hasConsentIntro('Your voice is transcribed.')).toBe(false);
  });
});

describe('otherInterviewerNamed', () => {
  it('flags tenant wording that introduces a different interviewer mid-text', () => {
    expect(otherInterviewerNamed(composeDisclosure('Maya', "So you know: I'm Alex and I'll ask the questions."), 'Maya')).toBe('Alex');
  });

  it('is null when the only name is the session interviewer', () => {
    expect(otherInterviewerNamed(composeDisclosure('Maya', "I'm Maya, and I'll ask about your experience."), 'Maya')).toBe(null);
  });
});
