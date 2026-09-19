import { describe, it, expect } from 'vitest';
import {
  INTERVIEWER_CATALOGUE,
  VOICE_PROFILE_CATALOGUE,
  composeOpening,
  defaultVoiceFor,
  interviewerIntro,
  needsInterviewerBackfill,
  parseVoiceOverride,
  pickInterviewer,
  voiceOverridesFromEnv,
} from '../src/domain/interviewerModel.js';

// The five interviewers differ in name and voice and in nothing else. These
// tests pin the catalogue, the opening line built from the name, and the
// parsing of the backend-only voice configuration.

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

describe('interviewerIntro', () => {
  it('introduces the interviewer by name', () => {
    expect(interviewerIntro('Maya')).toBe("Hi, I'm Maya, your AI interviewer from Questor. I'll be conducting your first-round interview today.");
  });

  it('still says it is an AI interviewer when the record has no name', () => {
    expect(interviewerIntro(null)).toBe("Hi, I'm your AI interviewer from Questor. I'll be conducting your first-round interview today.");
  });
});

describe('composeOpening', () => {
  const body = 'Your voice is transcribed as we talk — no audio recording is kept, but the written transcript is, and a person on the hiring team reads it.';

  it('puts the named introduction before the disclosure', () => {
    expect(composeOpening('Theo', body)).toBe(`${interviewerIntro('Theo')} ${body}`);
  });

  it('replaces a legacy self-introduction instead of introducing twice', () => {
    const legacy = `Hello, I'm Schranders, an AI interviewer for this first-round conversation. ${body}`;
    expect(composeOpening('Elena', legacy)).toBe(`${interviewerIntro('Elena')} ${body}`);
  });

  it('replaces the unnamed retake introduction', () => {
    const legacy = `Hello, I'm an AI interviewer for this first-round conversation. ${body}`;
    expect(composeOpening('Adrian', legacy)).toBe(`${interviewerIntro('Adrian')} ${body}`);
  });

  it('is idempotent, so re-composing never stacks introductions', () => {
    const once = composeOpening('Maya', body);
    expect(composeOpening('Maya', once)).toBe(once);
  });

  it('swaps one interviewer for another in an already composed opening', () => {
    expect(composeOpening('Avery', composeOpening('Maya', body))).toBe(`${interviewerIntro('Avery')} ${body}`);
  });

  it('keeps every word of the disclosure after the introduction', () => {
    expect(composeOpening('Maya', body).endsWith(body)).toBe(true);
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
