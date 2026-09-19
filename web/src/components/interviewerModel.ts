/**
 * The AI interviewer choice, kept free of React so it can be unit tested (see
 * web/tests/interviewerModel.test.ts).
 *
 * The five interviewers differ in name and voice and nothing else, so the
 * selector offers names and a voice sample — never a description. Tone is a
 * separate setting on the same form and is not connected to this one.
 */

/** What the server lists about an interviewer. It never carries provider data. */
export interface PublicInterviewer {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl: string;
  readonly sortOrder: number;
}

export const RANDOM_INTERVIEWER = 'random';
export const DEFAULT_INTERVIEWER_CHOICE = RANDOM_INTERVIEWER;

export interface InterviewerChoice {
  readonly value: string;
  readonly label: string;
  readonly previewable: boolean;
}

/** Random first (the recommended default), then each interviewer in its order. */
export function interviewerChoices(list: readonly PublicInterviewer[]): InterviewerChoice[] {
  const ordered = [...list].sort((a, b) => a.sortOrder - b.sortOrder);
  return [
    { value: RANDOM_INTERVIEWER, label: 'Random — Recommended', previewable: false },
    ...ordered.map((i) => ({ value: i.id, label: i.name, previewable: true })),
  ];
}

export function isInterviewerChoice(value: string, list: readonly PublicInterviewer[]): boolean {
  return value === RANDOM_INTERVIEWER || list.some((i) => i.id === value);
}

export interface RoomHeader {
  readonly name: string;
  readonly initial: string;
}

function nameOf(name: string | null | undefined): string {
  return typeof name === 'string' && name.trim() ? name.trim() : '';
}

/**
 * The interview room's heading: just who is speaking, as on a real call. The
 * candidate was told this is an AI interviewer on the consent screen before
 * the interview (and the fact stays in the room's details, roomAiFact), so the
 * name is not labelled on screen.
 */
export function interviewRoomHeader(persona: { readonly name?: string | null } | null | undefined): RoomHeader {
  const name = nameOf(persona?.name) || 'Your interviewer';
  return { name, initial: name.charAt(0).toUpperCase() };
}

/** The AI fact, kept reachable in the room beside what is captured. */
export function roomAiFact(name: string | null | undefined): string {
  return `${nameOf(name) || 'Your interviewer'} is an AI interviewer. A person on the hiring team reviews the interview.`;
}

// The introduction the server puts at the start of the disclosure
// (server/src/domain/interviewerModel.ts consentIntro).
const CONSENT_INTRO = /^\s*(Your interviewer today is [^.]*\.(?:\s*A person on the hiring team reviews the interview\.)?)\s*/;

/**
 * The disclosure split so its first lines — who the interviewer is, that it is
 * an AI, that a person reviews it — can be shown prominently. Nothing is
 * dropped: intro and rest together are the text the consent record stores.
 */
export function splitDisclosure(text: string): { intro: string; rest: string } {
  const match = CONSENT_INTRO.exec(text);
  if (!match) return { intro: '', rest: text };
  return { intro: match[1], rest: text.slice(match[0].length) };
}

/** The required acknowledgement on the consent step, naming the interviewer. */
export function aiAcknowledgement(name: string | null | undefined): string {
  const who = nameOf(name) ? `${nameOf(name)}, an AI interviewer,` : 'an AI interviewer';
  return `I understand this first round is conducted by ${who} and reviewed by a person on the hiring team, and I agree to proceed.`;
}

/** What the start of the interview will be like, so it is not a surprise. */
export function whatHappensFirst(name: string | null | undefined): string {
  return `When you join, ${nameOf(name) || 'your interviewer'} will greet you, say briefly what the role is mainly looking for, and start with a question about your current work.`;
}

/** The minimum of a SpeechSynthesisVoice this needs, so it can be tested without a browser. */
export interface BrowserVoiceLike {
  readonly name: string;
  readonly lang: string;
}

const FEMALE_VOICE = /female|zira|aria|jenny|samantha|karen|moira|tessa|victoria|susan|hazel|libby|sonia|serena|allison|\bava\b|google us english/i;
const MALE_VOICE = /\bmale\b|david|\bguy\b|\bmark\b|daniel|\balex\b|\bfred\b|george|ryan|\btom\b|aaron|arthur|christopher|\beric\b/i;

/**
 * The browser voice for an interviewer when there is no server voice.
 *
 * `hint` is `<female|male>:<n>`: the n-th English system voice of that kind,
 * wrapping round when the machine has fewer. Distinct ordinals keep two
 * interviewers from sharing one voice wherever the machine has enough.
 */
export function pickBrowserVoice<T extends BrowserVoiceLike>(voices: readonly T[], hint: string): T | null {
  const english = voices.filter((v) => /^en/i.test(v.lang));
  const pool = english.length ? english : [...voices];
  if (!pool.length) return null;
  const [kind, ordinalText] = hint.split(':');
  const ordinal = Number.parseInt(ordinalText ?? '0', 10) || 0;
  const matching = kind === 'female'
    ? pool.filter((v) => FEMALE_VOICE.test(v.name))
    : kind === 'male'
      ? pool.filter((v) => MALE_VOICE.test(v.name) && !/female/i.test(v.name))
      : [];
  if (!matching.length) return pool[0];
  return matching[ordinal % matching.length];
}
