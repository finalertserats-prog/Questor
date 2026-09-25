import type { TourChoice, TourStep } from '../tourModel';
import type { DemoBeat } from './demoScript';

/**
 * What the sandbox decides about the demo's beats, free of React and of the
 * DOM so it can be tested in the node environment (web/tests/demoTourModel.test.ts).
 *
 * The tour itself — stepping, keys, placement — is the product tour's
 * (tourModel.ts). What is the demo's own: a beat may depend on the sandbox
 * (the story's records) or on what the demo offers (a way of sitting the
 * interview), its screen carries the sandbox's ids, and the closing cards
 * offer exactly what is on.
 */

export interface DemoStory {
  readonly orgSlug: string | null;
  readonly roleId: string;
  readonly candidateId: string;
  readonly sessionId: string;
  readonly assessmentId: string;
}

export interface DemoInterviewModes { readonly candidate: boolean; readonly observer: boolean }

export interface DemoStatus {
  readonly visitor: { readonly name: string; readonly firstName: string };
  readonly caps: { readonly roles: number; readonly candidates: number; readonly interviews: number };
  readonly modes: DemoInterviewModes;
  readonly story: DemoStory | null;
}

export function anyInterviewMode(modes: DemoInterviewModes): boolean {
  return modes.candidate || modes.observer;
}

/** Whether the sandbox can show this beat at all; the page's own anchor is checked later, on arrival. */
export function beatOffered(beat: DemoBeat, status: DemoStatus): boolean {
  if (beat.needsStory && status.story === null) return false;
  if (beat.needsInterviewMode && !anyInterviewMode(status.modes)) return false;
  // The door needs an address to open.
  if (beat.route.includes('{orgSlug}') && !status.story?.orgSlug) return false;
  return true;
}

/** The route with the sandbox's own ids in it. */
export function resolveRoute(beat: DemoBeat, status: DemoStatus): string {
  const story = status.story;
  return beat.route
    .replace('{roleId}', story?.roleId ?? '')
    .replace('{candidateId}', story?.candidateId ?? '')
    .replace('{sessionId}', story?.sessionId ?? '')
    .replace('{assessmentId}', story?.assessmentId ?? '')
    .replace('{orgSlug}', story?.orgSlug ?? '');
}

/** The offered beats, in order: what the progress counts and the arrows step through. */
export function offeredBeats(beats: readonly DemoBeat[], status: DemoStatus): readonly DemoBeat[] {
  return beats.filter((beat) => beatOffered(beat, status));
}

export type InterviewChoice = 'candidate' | 'observer';

/** The ways of sitting the interview: exactly what the server says is on, and nothing else. */
export function interviewChoices(modes: DemoInterviewModes): readonly InterviewChoice[] {
  const choices: InterviewChoice[] = [];
  if (modes.candidate) choices.push('candidate');
  if (modes.observer) choices.push('observer');
  return choices;
}

const INTERVIEW_CHOICE: Record<InterviewChoice, TourChoice> = {
  candidate: { id: 'candidate', label: 'Take the interview as the candidate — about 15 minutes', icon: 'ai-interview' },
  observer: { id: 'observer', label: 'Watch an interview from the hiring team’s side', icon: 'eye', emphasis: 'secondary' },
};

const NEW_ROLE_CHOICE: TourChoice = { id: 'new-role', label: 'New role', icon: 'job-description' };

/** The buttons on a closing card; an ordinary beat has none. */
export function closingChoices(beat: DemoBeat, status: DemoStatus): readonly TourChoice[] | undefined {
  if (beat.closing === 'explore') return [NEW_ROLE_CHOICE];
  if (beat.closing === 'interview') return interviewChoices(status.modes).map((choice) => INTERVIEW_CHOICE[choice]);
  return undefined;
}

/** The caps line on the explore card, from the server's numbers. */
export function capsSentence(caps: DemoStatus['caps']): string {
  return `In the demo you can add up to ${caps.roles} roles, ${caps.candidates} candidates and ${caps.interviews} interviews.`;
}

/**
 * The beats this sandbox can show, as the tour's own steps: each on its
 * screen, the welcome addressed to the visitor by name, the closing cards
 * carrying what is on offer.
 */
export function demoSteps(beats: readonly DemoBeat[], status: DemoStatus): readonly TourStep[] {
  return offeredBeats(beats, status).map((beat, index) => ({
    id: beat.id,
    title: index === 0 && status.visitor.firstName ? `Hello, ${status.visitor.firstName}.` : beat.title,
    body: index === 0 && status.visitor.firstName ? `Welcome to Questor. ${beat.body}` : beat.body,
    anchor: beat.anchor,
    anchorSettledBy: beat.anchorSettledBy,
    route: resolveRoute(beat, status),
    choices: closingChoices(beat, status),
    note: beat.closing === 'explore' ? `${capsSentence(status.caps)} Sample data only; the sandbox is deleted afterwards.` : undefined,
  }));
}

/**
 * The story begins by itself once per browser session: a visitor who reloads
 * the page while exploring is not walked through it again.
 */
export const DEMO_TOUR_SEEN_KEY = 'questor-demo-tour-seen';

export interface SessionStore { getItem(key: string): string | null; setItem(key: string, value: string): void }

export function tourAlreadySeen(store: SessionStore | null): boolean {
  try { return store?.getItem(DEMO_TOUR_SEEN_KEY) === '1'; } catch { return false; }
}

export function rememberTourSeen(store: SessionStore | null): void {
  try { store?.setItem(DEMO_TOUR_SEEN_KEY, '1'); } catch { /* a private window; the story begins again next load */ }
}
