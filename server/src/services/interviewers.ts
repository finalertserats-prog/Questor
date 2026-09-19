import { randomInt as cryptoRandomInt } from 'node:crypto';
import { prisma, parseJsonOptional } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { HttpError } from '../middleware/index.js';
import type { VoiceSelection } from '../providers/speech.js';
import {
  INTERVIEWER_CATALOGUE,
  VOICE_PROFILE_CATALOGUE,
  DEFAULT_DISCLOSURE_BODY,
  composeDisclosure,
  defaultVoiceFor,
  duplicateVoices,
  needsInterviewerBackfill,
  pickInterviewer,
  resolveProfileVoice,
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

type Env = Readonly<Record<string, string | undefined>>;

/** Where voices are resolved from; the process environment and config unless a caller says otherwise. */
export interface VoiceContext {
  readonly env?: Env;
  readonly provider?: string;
}

/**
 * Record on each voice profile the voice it will actually use: the
 * VOICE_PROFILE_0N override when set, otherwise the configured provider's
 * default. Rewritten on every boot, so unsetting an override or switching
 * TTS_PROVIDER takes effect; the rows are a record for operators, and speech
 * itself resolves at run time (voiceForInterviewer), never from what was
 * seeded.
 */
export async function applyVoiceProfileOverrides(env: Env = process.env, provider: string = config.tts.provider): Promise<{ applied: number; invalid: string[] }> {
  const { overrides, invalid } = voiceOverridesFromEnv(env);
  if (invalid.length) logger.warn({ variables: invalid }, 'Ignoring malformed voice profile override (expected provider:voiceId)');
  for (const profile of VOICE_PROFILE_CATALOGUE) {
    const resolved = resolveProfileVoice(profile.id, env, provider);
    await prisma.voiceProfile.updateMany({
      where: { id: profile.id },
      data: { provider: resolved.provider, providerVoiceId: resolved.voiceId },
    });
  }
  return { applied: overrides.length, invalid };
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
export async function voiceForInterviewer(interviewerId: string | null | undefined, ctx: VoiceContext = {}): Promise<VoiceSelection | null> {
  const row = await interviewerWithVoice(interviewerId);
  if (!row || !row.voiceProfile.enabled) return null;
  // Resolved now, from the environment and the configured provider — not
  // read back from the row, which would freeze whatever provider was
  // configured the first time the catalogue was seeded.
  return resolveProfileVoice(row.voiceProfileId, ctx.env ?? process.env, ctx.provider ?? config.tts.provider);
}

/** Groups of active interviewers' voice profiles that would sound identical. */
export async function sharedVoices(ctx: VoiceContext = {}): Promise<string[][]> {
  const active = await prisma.aIInterviewer.findMany({ where: { active: true, voiceProfile: { enabled: true } }, select: { voiceProfileId: true } });
  const env = ctx.env ?? process.env;
  const provider = ctx.provider ?? config.tts.provider;
  return duplicateVoices(active.map((a) => ({ profileId: a.voiceProfileId, ...resolveProfileVoice(a.voiceProfileId, env, provider) })));
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
  const consent = parseJsonOptional<Record<string, unknown>>(session.consentJson, {}, { model: 'InterviewSession', id: session.id, field: 'consentJson' });
  // Consent does not always move the state on, so the consent record — not
  // the state — decides: a candidate who agreed to be interviewed under a name
  // keeps that name.
  if (consent.consentedAt) return false;
  const assigned = await assignInterviewer('random', randomInt);
  // Tone is carried over exactly as stored; the interviewer never sets it.
  const nextPersona = { ...persona, interviewerId: assigned.interviewerId, name: assigned.name };

  // The disclosure the candidate will consent to is introduced with the new
  // name; a session that never had one (an older demo sandbox) gets the
  // standard one, since consent is refused without it.
  const existing = typeof consent.disclosureText === 'string' ? consent.disclosureText : '';
  const nextConsent = { ...consent, disclosureText: composeDisclosure(assigned.name, existing || DEFAULT_DISCLOSURE_BODY) };

  // Conditional on the row being exactly as read, persona AND consent, so a
  // consent recorded between the read and this write is never overwritten.
  const { count } = await prisma.interviewSession.updateMany({
    where: { id: session.id, state: session.state, personaJson: session.personaJson, consentJson: session.consentJson },
    data: { personaJson: JSON.stringify(nextPersona), consentJson: JSON.stringify(nextConsent) },
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
    // Rows that already name an interviewer are left out at the query, so a
    // boot does not read every session ever created.
    where: { state: { in: NOT_STARTED_STATES }, NOT: { personaJson: { contains: '"interviewerId"' } } },
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
  // Only meaningful with a server voice: in the browser each interviewer gets
  // a different system voice from its hint instead.
  if (config.tts.provider === 'openai' || config.tts.provider === 'elevenlabs') {
    const shared = await sharedVoices();
    if (shared.length) {
      logger.warn({ profiles: shared }, 'AI interviewers share a voice; set VOICE_PROFILE_0N=provider:voiceId so each sounds different');
    }
  }
  const changed = await backfillLegacyInterviewers();
  if (changed) logger.info({ sessions: changed }, 'Assigned AI interviewers to sessions created before the interviewer catalogue');
}
