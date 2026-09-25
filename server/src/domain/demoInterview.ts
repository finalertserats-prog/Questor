import type { DirectorSignal } from './types.js';

/**
 * The demo interview's time box, budget vocabulary and wording, as pure
 * functions. No database, no clock of its own, no model.
 *
 * TWO RULES SHAPE EVERYTHING HERE.
 *
 * 1. THE CAP IS HELD ON THIS SIDE. A countdown in the page is a courtesy, not
 *    a control: a prospect with the developer console open can clear an
 *    interval, and the interview — and the model spend behind it — would run
 *    for as long as they cared to leave the tab open.
 *
 * 2. THE INTERVIEWER NEVER BREAKS CHARACTER (owner, 2026-09-24). Every
 *    boundary the demo has — the fifteen minutes, the spend ceiling, a
 *    provider that has stopped answering — is expressed as something the
 *    interviewer SAYS, in its own voice, moving the conversation along. The
 *    visitor is told it is a timed demo BEFORE they start. After that nothing
 *    interrupts: no system message, no error, no countdown in the transcript,
 *    no "your limit has been reached". A prospect who is told mid-sentence
 *    that a quota ran out has been shown our billing, not our product.
 */

/** The two ways a visitor can take the demo. */
export const DEMO_MODES = ['candidate', 'observer'] as const;
export type DemoMode = (typeof DEMO_MODES)[number];

export function isDemoMode(value: unknown): value is DemoMode {
  return typeof value === 'string' && (DEMO_MODES as readonly string[]).includes(value);
}

export function modeLabel(mode: DemoMode): string {
  return mode === 'candidate' ? 'Be the candidate' : 'Watch one happen';
}

/** The whole sitting, from the first question to the assessment. */
export const DEMO_CAP_MS = 15 * 60_000;

/**
 * Held back inside the cap for the close: the interviewer's wrap-up, the
 * invitation to ask something, the sign-off.
 *
 * The first version of this stopped the interviewer AT the cap, which ended
 * the sitting three minutes past it — the close is itself a conversation. A
 * demo advertised as fifteen minutes has to finish in fifteen minutes, so the
 * questioning stops early enough for the ending to fit inside the box.
 */
export const DEMO_CLOSING_RESERVE_MS = 3 * 60_000;

/**
 * One extension, for anyone who asks, with no reason required.
 *
 * Offered to every visitor in both modes precisely so that taking it discloses
 * nothing. Someone who reads with a screen reader, types rather than speaks,
 * uses a switch device, or simply thinks at their own pace would otherwise be
 * given less interview for the same fifteen minutes; asking them to justify
 * the extra time would make the control a declaration of disability.
 *
 * It is offered on the way IN, on the choice screen, not as a rescue when the
 * clock is nearly out — a control that only appears under time pressure is one
 * nobody using assistive technology has time to find.
 */
export const DEMO_EXTENSION_MS = 10 * 60_000;

/** The clock a sitting carries. Matches the DemoInterviewRun columns. */
export interface DemoRunClock {
  readonly startedAt: Date;
  readonly capAt: Date;
  readonly extendedMs: number;
  readonly endedAt: Date | null;
}

export function capAtFor(startedAt: Date, extendedMs = 0): Date {
  return new Date(startedAt.getTime() + DEMO_CAP_MS + Math.max(0, extendedMs));
}

/** Past this, the server serves a close instead of another question. */
export function mustStopAsking(now: Date, run: DemoRunClock): boolean {
  if (run.endedAt) return false;
  return now.getTime() >= run.capAt.getTime() - DEMO_CLOSING_RESERVE_MS;
}

/** Past this, the sitting is finalised whether or not anyone is still there. */
export function mustFinalise(now: Date, run: DemoRunClock): boolean {
  if (run.endedAt) return false;
  return now.getTime() >= run.capAt.getTime();
}

export function msLeft(now: Date, run: DemoRunClock): number {
  return Math.max(0, run.capAt.getTime() - now.getTime());
}

export function mayExtend(run: DemoRunClock): boolean {
  return !run.endedAt && run.extendedMs <= 0;
}

/**
 * How far the visitor got, for the owner's console.
 *
 * Ordered, and only ever moved forward: a visitor who reaches the assessment
 * and then reloads the choice screen has still reached the assessment.
 */
export const DEMO_STAGES = [
  'chose_mode', 'consented', 'interviewing', 'closed', 'assessed', 'saw_status', 'gave_feedback',
] as const;
export type DemoStage = (typeof DEMO_STAGES)[number];

export function stageRank(stage: string): number {
  const at = (DEMO_STAGES as readonly string[]).indexOf(stage);
  return at < 0 ? 0 : at;
}

export function furtherStage(a: string, b: string): DemoStage {
  return DEMO_STAGES[Math.max(stageRank(a), stageRank(b))];
}

const STAGE_LABELS: Record<DemoStage, string> = {
  chose_mode: 'Chose a mode',
  consented: 'Agreed to the disclosure',
  interviewing: 'In the interview',
  closed: 'Interview closed',
  assessed: 'Assessment produced',
  saw_status: 'Saw the candidate status page',
  gave_feedback: 'Left feedback',
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage as DemoStage] ?? 'Started the demo';
}

export type DemoEndReason = 'cap' | 'completed' | 'withdrawn' | 'abandoned' | 'demo_ended' | 'engine_unavailable';

const END_REASON_LABELS: Record<DemoEndReason, string> = {
  cap: 'Reached the 15-minute demo limit',
  completed: 'Finished the interview',
  withdrawn: 'Ended it themselves',
  abandoned: 'Closed the tab part-way',
  demo_ended: 'Pressed End demo',
  engine_unavailable: 'The interviewer could not run',
};

export function endReasonLabel(reason: string): string {
  return END_REASON_LABELS[reason as DemoEndReason] ?? 'Ended';
}

/**
 * What the visitor is told BEFORE they choose, on the choice screen.
 *
 * This is the only place the demo's bounds are stated as a fact about the
 * demo. Saying it here is what buys the right to say nothing during.
 */
export function beforeYouStartLine(mode: DemoMode): string {
  return mode === 'candidate'
    ? 'This demo interview runs for up to 15 minutes. The interviewer will bring it to a close within that time and you will get the assessment it produces from your answers. You can take longer if you need it.'
    : 'This demo interview runs for about 15 minutes, and plays out at the pace a real one does. You will see the assessment it produces at the end.';
}

/**
 * The interviewer's own words for moving to the close.
 *
 * THIS IS THE ONLY THING THE VISITOR HEARS ABOUT THE BOUND, AND IT IS HEARD
 * FROM THE INTERVIEWER, NOT FROM US. It carries no reason beyond the demo
 * being short — not a limit, not a quota, not a fault. It is written to work
 * whether it arrives at minute twelve or minute two, because the same line
 * carries a spend ceiling and a provider outage as well as the clock.
 */
export function movingToCloseLine(): string {
  return 'Since this is a demo interview we keep it short, so let me start bringing us towards the close.';
}

/**
 * Wording that must never reach the room, in either mode.
 *
 * The guard is a list rather than a judgement because the failure it prevents
 * is a careless edit, not a subtle one: somebody adding "the demo limit has
 * been reached" to a close because it is true. It is true and it is ours to
 * know.
 */
export const SYSTEM_SHAPED_WORDING: readonly RegExp[] = [
  /\blimit (?:has been |is |was )?reached\b/i,
  /\bquota\b/i,
  /\bbudget\b/i,
  /\bcredit(?:s)?\b/i,
  /\bbilling\b/i,
  /\bunavailable\b/i,
  /\bunable to\b/i,
  /\berror\b/i,
  /\bfailed\b/i,
  /\btimed? ?out\b/i,
  /\bprovider\b/i,
  /\bmodel\b/i,
  /\bserver\b/i,
  /\bsystem\b/i,
  /\bsorry[, ]/i,
  /\bsomething went wrong\b/i,
  /\bplease try again\b/i,
];

/** The patterns an interviewer line trips, or none. Empty means it may be said. */
export function systemShapedMatches(text: string): string[] {
  return SYSTEM_SHAPED_WORDING.filter((re) => re.test(text)).map((re) => re.source);
}

export function staysInCharacter(text: string): boolean {
  return systemShapedMatches(text).length === 0;
}

/**
 * Turn the director's decision into the close it already knows how to make.
 *
 * Deliberately NOT a new kind of ending. `directorDecide` already returns this
 * exact shape when it runs out of time budget, and the conversation engine
 * already knows how to speak it — so the demo's cap produces the interviewer's
 * ordinary close, a whole utterance, rather than a truncation. Nothing is ever
 * cut mid-sentence: the server declines to produce the NEXT turn, it never
 * interrupts one that is being produced or spoken.
 */
export function signalClosedForTimeBox(signal: DirectorSignal): DirectorSignal {
  if (signal.action === 'close') return signal;
  return {
    ...signal,
    nextCompetencyId: '__candidate_questions__',
    action: 'close',
    depthInstruction: 'hold',
    timeRemainingMinutes: 0,
    reason: 'Demo time box reached; moving to close.',
  };
}
