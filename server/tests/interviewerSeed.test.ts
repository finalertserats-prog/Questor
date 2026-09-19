import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../src/db.js';
import {
  seedInterviewers,
  applyVoiceProfileOverrides,
  listActiveInterviewers,
  assignInterviewer,
  voiceForInterviewer,
  sharedVoices,
} from '../src/services/interviewers.js';
import { HttpError } from '../src/middleware/index.js';

// The interviewer catalogue is seeded on boot: missing rows are inserted, edits
// are never overwritten, and provider voice ids come from backend config.

async function clearCatalogue(): Promise<void> {
  await prisma.aIInterviewer.deleteMany();
  await prisma.voiceProfile.deleteMany();
}

beforeEach(clearCatalogue);

describe('seedInterviewers', () => {
  it('creates the five interviewers', async () => {
    await seedInterviewers('webspeech');
    expect(await prisma.aIInterviewer.count()).toBe(5);
  });

  it('creates one voice profile per interviewer', async () => {
    await seedInterviewers('webspeech');
    expect(await prisma.voiceProfile.count()).toBe(5);
  });

  it('is idempotent', async () => {
    await seedInterviewers('webspeech');
    await seedInterviewers('webspeech');
    expect([await prisma.aIInterviewer.count(), await prisma.voiceProfile.count()]).toEqual([5, 5]);
  });

  it('never overwrites an edit', async () => {
    await seedInterviewers('webspeech');
    await prisma.aIInterviewer.update({ where: { id: 'maya' }, data: { avatarUrl: '/avatars/maya.png', active: false } });
    await seedInterviewers('webspeech');
    const maya = await prisma.aIInterviewer.findUniqueOrThrow({ where: { id: 'maya' } });
    expect([maya.avatarUrl, maya.active]).toEqual(['/avatars/maya.png', false]);
  });

  it('assigns the configured provider default voices', async () => {
    await seedInterviewers('openai');
    const voice = await prisma.voiceProfile.findUniqueOrThrow({ where: { id: 'voice_02' } });
    expect([voice.provider, voice.providerVoiceId]).toEqual(['openai', 'marin']);
  });

  it('stores the display name, language and locale', async () => {
    await seedInterviewers('openai');
    const voice = await prisma.voiceProfile.findUniqueOrThrow({ where: { id: 'voice_02' } });
    expect([voice.displayName, voice.language, voice.locale]).toEqual(['Maya Voice', 'English', 'en-US']);
  });
});

describe('applyVoiceProfileOverrides', () => {
  it('points a voice profile at the provider voice from the environment', async () => {
    await seedInterviewers('openai');
    await applyVoiceProfileOverrides({ VOICE_PROFILE_02: 'elevenlabs:envVoice123' });
    const voice = await prisma.voiceProfile.findUniqueOrThrow({ where: { id: 'voice_02' } });
    expect([voice.provider, voice.providerVoiceId]).toEqual(['elevenlabs', 'envVoice123']);
  });

  it('records the configured provider default for profiles without an override', async () => {
    await seedInterviewers('openai');
    await applyVoiceProfileOverrides({ VOICE_PROFILE_02: 'elevenlabs:envVoice123' }, 'openai');
    const voice = await prisma.voiceProfile.findUniqueOrThrow({ where: { id: 'voice_03' } });
    expect([voice.provider, voice.providerVoiceId]).toEqual(['openai', 'cedar']);
  });

  it('reverts a profile to the configured default once its override is unset', async () => {
    await seedInterviewers('openai');
    await applyVoiceProfileOverrides({ VOICE_PROFILE_02: 'elevenlabs:envVoice123' }, 'openai');
    await applyVoiceProfileOverrides({}, 'openai');
    const voice = await prisma.voiceProfile.findUniqueOrThrow({ where: { id: 'voice_02' } });
    expect([voice.provider, voice.providerVoiceId]).toEqual(['openai', 'marin']);
  });

  it('follows a later switch of the configured provider, not the seed', async () => {
    await seedInterviewers('webspeech');
    await applyVoiceProfileOverrides({}, 'openai');
    const voice = await prisma.voiceProfile.findUniqueOrThrow({ where: { id: 'voice_04' } });
    expect([voice.provider, voice.providerVoiceId]).toEqual(['openai', 'coral']);
  });

  it('ignores a malformed value and names the variable', async () => {
    await seedInterviewers('openai');
    const result = await applyVoiceProfileOverrides({ VOICE_PROFILE_04: 'not-a-voice' });
    expect(result.invalid).toEqual(['VOICE_PROFILE_04']);
  });
});

describe('listActiveInterviewers', () => {
  it('returns only the public fields, in order', async () => {
    await seedInterviewers('openai');
    const list = await listActiveInterviewers();
    expect(list.map((i) => Object.keys(i).sort().join(','))).toEqual(Array(5).fill('avatarUrl,id,name,sortOrder'));
  });

  it('leaves out an inactive interviewer', async () => {
    await seedInterviewers('openai');
    await prisma.aIInterviewer.update({ where: { id: 'elena' }, data: { active: false } });
    expect((await listActiveInterviewers()).map((i) => i.id)).toEqual(['avery', 'maya', 'adrian', 'theo']);
  });

  it('seeds an empty catalogue before listing it', async () => {
    expect((await listActiveInterviewers()).map((i) => i.name)).toEqual(['Avery', 'Maya', 'Adrian', 'Elena', 'Theo']);
  });
});

describe('assignInterviewer', () => {
  it('assigns an explicit choice', async () => {
    await seedInterviewers('openai');
    expect(await assignInterviewer('adrian')).toEqual({ interviewerId: 'adrian', name: 'Adrian' });
  });

  it('picks randomly among active interviewers only', async () => {
    await seedInterviewers('openai');
    await prisma.aIInterviewer.updateMany({ where: { id: { not: 'theo' } }, data: { active: false } });
    expect(await assignInterviewer('random', (max) => max - 1)).toEqual({ interviewerId: 'theo', name: 'Theo' });
  });

  it('draws uniformly over the active list', async () => {
    await seedInterviewers('openai');
    const seen: number[] = [];
    await assignInterviewer('random', (max) => { seen.push(max); return 0; });
    expect(seen).toEqual([5]);
  });

  it('refuses an unknown interviewer with a 400', async () => {
    await seedInterviewers('openai');
    await expect(assignInterviewer('schroedinger')).rejects.toMatchObject({ status: 400 });
  });

  it('refuses an inactive interviewer with a 400', async () => {
    await seedInterviewers('openai');
    await prisma.aIInterviewer.update({ where: { id: 'maya' }, data: { active: false } });
    const err = await assignInterviewer('maya').catch((e: unknown) => e);
    expect(err instanceof HttpError && err.status === 400).toBe(true);
  });
});

describe('voiceForInterviewer', () => {
  it('resolves the interviewer to its voice profile', async () => {
    await seedInterviewers('openai');
    expect(await voiceForInterviewer('adrian', { provider: 'openai', env: {} })).toEqual({ provider: 'openai', voiceId: 'cedar' });
  });

  it('gives each interviewer its own voice after a first boot on browser speech and a later switch to OpenAI', async () => {
    await seedInterviewers('webspeech');
    const voices = await Promise.all(['avery', 'maya', 'adrian', 'elena', 'theo'].map((id) => voiceForInterviewer(id, { provider: 'openai', env: {} })));
    expect(new Set(voices.map((v) => v?.voiceId)).size).toBe(5);
  });

  it('follows a switch to ElevenLabs instead of keeping the seeded OpenAI voice', async () => {
    await seedInterviewers('openai');
    expect(await voiceForInterviewer('adrian', { provider: 'elevenlabs', env: {} })).toEqual({ provider: 'elevenlabs', voiceId: '' });
  });

  it('honours an explicit override for another provider', async () => {
    await seedInterviewers('openai');
    expect(await voiceForInterviewer('adrian', { provider: 'openai', env: { VOICE_PROFILE_03: 'elevenlabs:adrianVoice1' } })).toEqual({ provider: 'elevenlabs', voiceId: 'adrianVoice1' });
  });

  it('warns about active interviewers that would share one voice', async () => {
    await seedInterviewers('elevenlabs');
    expect((await sharedVoices({ provider: 'elevenlabs', env: {} })).length).toBeGreaterThan(0);
  });

  it('finds no shared voices with the OpenAI defaults', async () => {
    await seedInterviewers('openai');
    expect(await sharedVoices({ provider: 'openai', env: {} })).toEqual([]);
  });

  it('returns null for a disabled voice profile', async () => {
    await seedInterviewers('openai');
    await prisma.voiceProfile.update({ where: { id: 'voice_03' }, data: { enabled: false } });
    expect(await voiceForInterviewer('adrian')).toBe(null);
  });

  it('returns null for a session with no interviewer', async () => {
    expect(await voiceForInterviewer(undefined)).toBe(null);
  });
});
