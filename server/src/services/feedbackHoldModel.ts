import { detectCandidateIntent, type CandidateIntent } from '../engines/candidateIntent.js';

/**
 * When the candidate's automatic feedback email waits for a person instead of
 * going on its own (owner, 2026-09-22).
 *
 * The letter is written from the AI's reading of the interview. When that
 * reading is shaky — the evaluator itself says it is unsure, or the audio and
 * transcript it read were poor — the candidate would be told things about
 * themselves that nobody can stand behind. Those letters are HELD: the hiring
 * team sees why, and sends or keeps holding it.
 *
 * Pure, so each rule is tested on its own (tests/feedbackHoldModel.test.ts);
 * services/autoFeedback.ts applies it. Every threshold is a named constant and
 * every reason has a plain sentence, because "held" with no why is a black box
 * the hiring team cannot act on.
 */

/**
 * The evaluator's confidence is the graders' mean confidence (0.35–0.95 each)
 * times the share of competencies with evidence times the share attempted;
 * 0.2 is its floor, meaning nothing could be graded. Under 0.35 means that,
 * even with graders fairly sure of what they saw, around half the role had no
 * evidence at all — too much of the letter would be guesswork.
 */
export const MIN_AI_CONFIDENCE = 0.35;

/** Fewer replies than this is too few to call a transcript poor from its share of empty ones. */
export const MIN_REPLIES_TO_JUDGE = 4;

/**
 * Replies with nothing in them — blank, or only "no", "oh", "hmm" — at this
 * share or more mean the transcript lost the candidate's words (a dead mic,
 * recognition dropping out) or the candidate was not really there. Either way
 * the reading is built on too little.
 */
export const MAX_UNUSABLE_REPLY_SHARE = 0.4;

/**
 * Asking for the question again, or saying "that's not what I said", is what
 * a candidate does when they cannot hear the interviewer or the transcript is
 * getting them wrong. Once or twice is ordinary; three times is a pattern.
 */
export const MAX_MISHEARD_TURNS = 3;

/**
 * Times the candidate rejoined a live interview (audited as
 * 'interview.rejoined', one per reconnect). One drop happens to anybody;
 * three means the conversation was broken up enough to lose its thread.
 */
export const MAX_RECONNECTS = 3;

export type HoldReason = 'SCORING_UNAVAILABLE' | 'LOW_AI_CONFIDENCE' | 'UNUSABLE_REPLIES' | 'MISHEARD' | 'RECONNECTS';

/** What the decision was made on, kept with the held letter as the record of why. */
export interface TrustSignals {
  readonly recommendation: string;
  /** 0..1, as the evaluator stored it. */
  readonly aiConfidence: number;
  /** Candidate turns in the transcript. */
  readonly replies: number;
  /** Of those, blank or content-free ones. */
  readonly unusableReplies: number;
  /** Requests to repeat, and corrections of what was heard. */
  readonly misheardTurns: number;
  readonly reconnects: number;
}

export interface FeedbackHold {
  readonly reasons: readonly HoldReason[];
  readonly signals: TrustSignals;
}

const UNUSABLE: ReadonlySet<CandidateIntent> = new Set(['non_answer']);
const MISHEARD: ReadonlySet<CandidateIntent> = new Set(['repeat', 'correction']);

/** The signals, read from the stored assessment, the transcript and the reconnect count. */
export function trustSignals(
  assessment: { readonly recommendation: string; readonly confidence: number },
  turns: ReadonlyArray<{ readonly speaker: string; readonly text: string }>,
  reconnects: number,
): TrustSignals {
  let replies = 0;
  let unusableReplies = 0;
  let misheardTurns = 0;
  for (const turn of turns) {
    if (turn.speaker !== 'candidate') continue;
    replies += 1;
    const intent = turn.text.trim() ? detectCandidateIntent(turn.text).intent : 'non_answer';
    if (UNUSABLE.has(intent)) unusableReplies += 1;
    if (MISHEARD.has(intent)) misheardTurns += 1;
  }
  return {
    recommendation: assessment.recommendation, aiConfidence: assessment.confidence,
    replies, unusableReplies, misheardTurns, reconnects,
  };
}

/** Why this letter should wait for a person, or null when it may go on its own. */
export function feedbackHold(signals: TrustSignals): FeedbackHold | null {
  const reasons: HoldReason[] = [];
  if (signals.recommendation === 'SCORING_UNAVAILABLE') reasons.push('SCORING_UNAVAILABLE');
  else if (signals.aiConfidence < MIN_AI_CONFIDENCE) reasons.push('LOW_AI_CONFIDENCE');
  if (signals.replies >= MIN_REPLIES_TO_JUDGE && signals.unusableReplies / signals.replies >= MAX_UNUSABLE_REPLY_SHARE) {
    reasons.push('UNUSABLE_REPLIES');
  }
  if (signals.misheardTurns >= MAX_MISHEARD_TURNS) reasons.push('MISHEARD');
  if (signals.reconnects >= MAX_RECONNECTS) reasons.push('RECONNECTS');
  return reasons.length ? { reasons, signals } : null;
}

const percent = (x: number) => `${Math.round(x * 100)}%`;
const times = (n: number) => (n === 1 ? 'once' : `${n} times`);

const REASON_TEXT: Readonly<Record<HoldReason, (s: TrustSignals) => string>> = {
  SCORING_UNAVAILABLE: () => 'Automated scoring did not complete, so the feedback would not be based on a real assessment.',
  LOW_AI_CONFIDENCE: (s) => `The AI was only ${percent(s.aiConfidence)} confident in its assessment `
    + `(the email is held below ${percent(MIN_AI_CONFIDENCE)}).`,
  UNUSABLE_REPLIES: (s) => `${s.unusableReplies} of ${s.replies} of the candidate's replies were empty or had no real content, `
    + 'which usually means the microphone or transcription lost their words.',
  MISHEARD: (s) => `The candidate asked for a question to be repeated, or said they had been misheard, ${times(s.misheardTurns)}.`,
  RECONNECTS: (s) => `The candidate's connection dropped and they rejoined ${times(s.reconnects)}.`,
};

/** One plain sentence per reason, for the assessment page. Unknown codes are left out rather than shown raw. */
export function holdReasonTexts(reasons: readonly string[], signals: TrustSignals): string[] {
  return reasons
    .filter((r): r is HoldReason => r in REASON_TEXT)
    .map((r) => REASON_TEXT[r](signals));
}
