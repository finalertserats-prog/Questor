import type { DemoBeat } from './demoScript';

/**
 * The guided demo's decisions, free of React and of the DOM so they can be
 * tested in the node environment (web/tests/demoTourModel.test.ts).
 *
 * The rule inherited from the product tour still holds: a beat plays only over
 * an element that is on the page. What is new is that the page is navigated
 * to first, and that a beat may also depend on the sandbox (the story's
 * records) or on what the demo offers (a way of sitting the interview).
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

export type DemoPhase = 'loading' | 'ready' | 'playing' | 'paused' | 'ended';

export interface DemoTourState {
  readonly phase: DemoPhase;
  /** Index into the offered beats; -1 outside a run. */
  readonly index: number;
  /** How the run ended, for the hand-over event. */
  readonly ending: 'finished' | 'skipped' | null;
}

export const LOADING_TOUR: DemoTourState = { phase: 'loading', index: -1, ending: null };
export const READY_TOUR: DemoTourState = { phase: 'ready', index: -1, ending: null };

export function startDemoTour(total: number): DemoTourState {
  return total === 0 ? { phase: 'ended', index: -1, ending: 'finished' } : { phase: 'playing', index: 0, ending: null };
}

/** Forward: past the last beat the tour has finished. A beat whose anchor is missing calls this too. */
export function nextBeat(state: DemoTourState, total: number): DemoTourState {
  if (state.phase !== 'playing' && state.phase !== 'paused') return state;
  const index = state.index + 1;
  return index >= total ? { phase: 'ended', index: state.index, ending: 'finished' } : { phase: 'playing', index, ending: null };
}

/** Back: on the first beat, it replays. */
export function previousBeat(state: DemoTourState): DemoTourState {
  if (state.phase !== 'playing' && state.phase !== 'paused') return state;
  return { phase: 'playing', index: Math.max(0, state.index - 1), ending: null };
}

export function pauseDemoTour(state: DemoTourState): DemoTourState {
  return state.phase === 'playing' ? { ...state, phase: 'paused' } : state;
}

export function resumeDemoTour(state: DemoTourState): DemoTourState {
  return state.phase === 'paused' ? { ...state, phase: 'playing' } : state;
}

export function skipDemoTour(state: DemoTourState): DemoTourState {
  return state.phase === 'playing' || state.phase === 'paused' ? { phase: 'ended', index: state.index, ending: 'skipped' } : state;
}

export function isRunning(state: DemoTourState): boolean {
  return state.phase === 'playing' || state.phase === 'paused';
}

export type DemoKeyAction = 'toggle-pause' | 'replay' | 'next' | 'back' | 'skip-tour';

/** Space pauses and resumes, R replays the line, the arrows step, Escape skips the tour. */
export function demoKeyAction(key: string): DemoKeyAction | null {
  switch (key) {
    case ' ': case 'Spacebar': return 'toggle-pause';
    case 'r': case 'R': return 'replay';
    case 'ArrowRight': return 'next';
    case 'ArrowLeft': return 'back';
    case 'Escape': return 'skip-tour';
    default: return null;
  }
}

export interface DemoProgress { readonly current: number; readonly total: number; readonly percent: number }

export function demoProgress(state: DemoTourState, total: number): DemoProgress {
  const current = isRunning(state) ? state.index + 1 : state.phase === 'ended' ? total : 0;
  return { current, total, percent: total === 0 ? 0 : Math.round((current / total) * 100) };
}

/** What a screen reader hears as a beat begins; the caption follows in the same region. */
export function beatAnnouncement(beat: DemoBeat, progress: DemoProgress): string {
  return `Beat ${progress.current} of ${progress.total}: ${beat.title}.`;
}

/** The narration manifest, as generated with the audio: durations by beat id. */
export type NarrationManifest = Readonly<Record<string, { readonly durationMs: number }>>;

export function hasNarration(manifest: NarrationManifest | null, beatId: string): boolean {
  return manifest !== null && Object.prototype.hasOwnProperty.call(manifest, beatId);
}

/** How long a beat holds the screen when it runs on its caption alone. */
export function captionDurationMs(beat: DemoBeat): number {
  return beat.seconds * 1000;
}

/** The two closing cards ask the visitor to choose: the narration ends, the card stays until they do. */
export function waitsForChoice(beat: DemoBeat): boolean {
  return beat.card === 'explore' || beat.card === 'interview';
}

/** How long to wait for a page to produce the beat's element before giving the beat up. */
export const ANCHOR_WAIT_MS = 6000;

/**
 * The start card is shown once per browser session: a visitor who reloads
 * the page while exploring is not asked to start the story again.
 */
export const DEMO_TOUR_SEEN_KEY = 'questor-demo-tour-seen';

export interface SessionStore { getItem(key: string): string | null; setItem(key: string, value: string): void }

export function tourAlreadySeen(store: SessionStore | null): boolean {
  try { return store?.getItem(DEMO_TOUR_SEEN_KEY) === '1'; } catch { return false; }
}

export function rememberTourSeen(store: SessionStore | null): void {
  try { store?.setItem(DEMO_TOUR_SEEN_KEY, '1'); } catch { /* a private window; the card shows again next load */ }
}

export type InterviewChoice = 'candidate' | 'observer';

/** The event the tour raises as it hands over, for the demo-interview lane and the demo bar. */
export const DEMO_TOUR_FINISHED_EVENT = 'demo:tour-finished';

export interface DemoTourFinishedDetail {
  readonly ending: 'finished' | 'skipped';
  readonly choice: InterviewChoice | 'explore' | 'new-role' | null;
}

/** The buttons the interview card offers: exactly what the server says is on, and nothing else. */
export function interviewChoices(modes: DemoInterviewModes): readonly InterviewChoice[] {
  const choices: InterviewChoice[] = [];
  if (modes.candidate) choices.push('candidate');
  if (modes.observer) choices.push('observer');
  return choices;
}

/** The caps line on the explore card, from the server's numbers. */
export function capsSentence(caps: DemoStatus['caps']): string {
  return `In the demo you can add up to ${caps.roles} roles, ${caps.candidates} candidates and ${caps.interviews} interviews.`;
}
