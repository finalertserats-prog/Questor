import { randomInt as cryptoRandomInt } from 'node:crypto';
import { prisma, parseJsonOptional } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { HttpError } from '../middleware/index.js';
import type { VoiceSelection } from '../providers/speech.js';
import {
  INTERVIEWER_CATALOGUE,
  VOICE_PROFILE_CATALOGUE,
  composeDisclosure,
  defaultVoiceFor,
  needsInterviewerBackfill,
  pickInterviewer,
  voiceOverridesFromEnv,
} from '../domain/interviewerModel.js';

/** What HR and the candidate may see of an interviewer. No provider data, ever. */
export interface PublicInterviewer {
  id: string;
  name: string;
  avatarUrl: string;
  sortOrder: number;
}

/** What a session records about who interviews: stored in personaJson beside the untouched tone. */
export interface AssignedInterviewer {
  interviewerId: string;
  name: string;
}

type RandomInt = (max: number) => number;

/**
 * Insert whatever is missing from the catalogue; never touch an existing row.
 *
 * Upserts with an empty update, so an operator who renamed an avatar or turned
 * an interviewer off keeps that on every boot. New voice profiles take the
 * default voices of the TTS provider configured at the time.
 */
export async function seedInterviewers(provider: string = config.tts.provider): Promise<void> {
  for (const voice of VOICE_PROFILE_CATALOGUE) {
    await prisma.voiceProfile.upsert({
      where: { id: voice.id },
      update: {},
      create: { ...voice, provider, providerVoiceId: defaultVoiceFor(voice.id, provider) },
    });
  }
  for (const interviewer of INTERVIEWER_CATALOGUE) {
    await prisma.aIInterviewer.upsert({ where: { id: interviewer.id }, update: {}, create: { ...interviewer } });
  }
}

/** Seed only when rows are missing, so request paths pay a count, not ten upserts. */
export async function ensureInterviewers(): Promise<void> {
  if (await prisma.aIInterviewer.count() < INTERVIEWER_CATALOGUE.length) await seedInterviewers();
}

/**
 * VOICE_PROFILE_01..05 (`provider:voiceId`) onto the voice profiles.
 *
 * Unlike seeding this DOES overwrite: an environment variable is an explicit
 * operator decision, and it is how a voice moves providers with no code change.
 */
export async function applyVoiceProfileOverrides(env: Readonly<Record<string, string | undefined>> = process.env): Promise<{ applied: number; invalid: string[] }> {
  const { overrides, invalid } = voiceOverridesFromEnv(env);
  if (invalid.length) logger.warn({ variables: invalid }, 'Ignoring malformed voice profile override (expected provider:voiceId)');
  let applied = 0;
  for (const override of overrides) {
    const { count } = await prisma.voiceProfile.updateMany({
      where: { id: override.profileId },
      data: { provider: override.provider, providerVoiceId: override.voiceId },
    });
    applied += count;
  }
  return { applied, invalid };
}

export async function listActiveInterviewers(): Promise<PublicInterviewer[]> {
  await ensureInterviewers();
  return prisma.aIInterviewer.findMany({
    where: { active: true },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, name: true, avatarUrl: true, sortOrder: true },
  });
}

/**
 * The interviewer for a new session: the one HR chose, or uniformly at random
 * among the active ones. Called once, at creation; the result is stored and
 * never re-drawn.
 */
export async function assignInterviewer(choice: string, randomInt: RandomInt = cryptoRandomInt): Promise<AssignedInterviewer> {
  const active = await listActiveInterviewers();
  if (choice === 'random') {
    if (active.length === 0) throw new HttpError(409, 'No AI interviewer is available right now. Ask an administrator to turn one on.');
    const picked = pickInterviewer(active, randomInt);
    return { interviewerId: picked.id, name: picked.name };
  }
  const chosen = active.find((i) => i.id === choice);
  if (!chosen) throw new HttpError(400, 'Choose one of the listed AI interviewers, or Random.');
  return { interviewerId: chosen.id, name: chosen.name };
}

async function interviewerWithVoice(interviewerId: string | null | undefined) {
  if (!interviewerId) return null;
  return prisma.aIInterviewer.findUnique({ where: { id: interviewerId }, include: { voiceProfile: true } });
}

/** The provider voice for an interviewer, or null when it has none enabled (the default voice then speaks). */
export async function voiceForInterviewer(interviewerId: string | null | undefined): Promise<VoiceSelection | null> {
  const row = await interviewerWithVoice(interviewerId);
  if (!row || !row.voiceProfile.enabled) return null;
  return { provider: row.voiceProfile.provider, voiceId: row.voiceProfile.providerVoiceId };
}

/** The browser-voice hint for an interviewer; '' when unknown. Safe to send to a browser. */
export async function voiceHintForInterviewer(interviewerId: string | null | undefined): Promise<string> {
  const row = await interviewerWithVoice(interviewerId);
  return row?.voiceProfile.fallbackHint ?? '';
}

/** The interviewer id a stored persona names, if any. */
export function interviewerIdOf(personaJson: string, sessionId: string): string | null {
  const persona = parseJsonOptional<{ interviewerId?: unknown }>(personaJson, {}, { model: 'InterviewSession', id: sessionId, field: 'personaJson' });
  return typeof persona.interviewerId === 'string' && persona.interviewerId ? persona.interviewerId : null;
}

/**
 * States in which the candidate has not yet met the interviewer. Only these
 * are backfilled: a completed, closed or in-progress interview keeps the name
 * it was conducted under, because rewriting who conducted a finished
 * interview would falsify the record.
 */
const NOT_STARTED_STATES = [
  'PROVISIONED', 'INVITED', 'ACCEPTED', 'READY_CHECK', 'WAITING',
  'CONNECTING', 'DISCLOSURE', 'CONSENTED', 'WARMUP', 'RESCHEDULE_REQUIRED',
];

interface BackfillCandidate { id: string; state: string; personaJson: string; consentJson: string }

/**
 * Give one not-yet-started session from before the catalogue a real
 * interviewer. Idempotent, and conditional on the row being unchanged since it
 * was read, so a concurrent write is never overwritten.
 */
async function backfillSession(session: BackfillCandidate, randomInt: RandomInt): Promise<boolean> {
  if (!NOT_STARTED_STATES.includes(session.state)) return false;
  const persona = parseJsonOptional<Record<string, unknown>>(session.personaJson, {}, { model: 'InterviewSession', id: session.id, field: 'personaJson' });
  if (!needsInterviewerBackfill(persona)) return false;
  const assigned = await assignInterviewer('random', randomInt);
  // Tone is carried over exactly as stored; the interviewer never sets it.
  const nextPersona = { ...persona, interviewerId: assigned.interviewerId, name: assigned.name };

  const consent = parseJsonOptional<Record<string, unknown>>(session.consentJson, {}, { model: 'InterviewSession', id: session.id, field: 'consentJson' });
  // A disclosure the candidate has not yet agreed to is re-introduced with the
  // new name. One they HAVE agreed to is left as the record of what they
  // agreed to; the spoken opening is composed from the name at speaking time.
  const rewriteDisclosure = typeof consent.disclosureText === 'string' && consent.disclosureText.length > 0 && !consent.consentedAt;
  const nextConsent = rewriteDisclosure ? { ...consent, disclosureText: composeDisclosure(assigned.name, consent.disclosureText as string) } : null;

  const { count } = await prisma.interviewSession.updateMany({
    where: { id: session.id, state: session.state, personaJson: session.personaJson },
    data: { personaJson: JSON.stringify(nextPersona), ...(nextConsent ? { consentJson: JSON.stringify(nextConsent) } : {}) },
  });
  return count === 1;
}

/** Backfill one session by id, the first time it is read for the interview. */
export async function ensureSessionInterviewer(sessionId: string, randomInt: RandomInt = cryptoRandomInt): Promise<void> {
  const session = await prisma.interviewSession.findUnique({ where: { id: sessionId }, select: { id: true, state: true, personaJson: true, consentJson: true } });
  if (session) await backfillSession(session, randomInt);
}

/** Every not-yet-started session from before the catalogue. Returns how many changed. */
export async function backfillLegacyInterviewers(randomInt: RandomInt = cryptoRandomInt): Promise<number> {
  const sessions = await prisma.interviewSession.findMany({
    where: { state: { in: NOT_STARTED_STATES } },
    select: { id: true, state: true, personaJson: true, consentJson: true },
  });
  let changed = 0;
  for (const session of sessions) {
    if (await backfillSession(session, randomInt)) changed++;
  }
  return changed;
}

/** Boot: seed, apply env voice overrides, backfill. Each step is idempotent. */
export async function initInterviewers(): Promise<void> {
  await seedInterviewers();
  await applyVoiceProfileOverrides();
  const changed = await backfillLegacyInterviewers();
  if (changed) logger.info({ sessions: changed }, 'Assigned AI interviewers to sessions created before the interviewer catalogue');
}
