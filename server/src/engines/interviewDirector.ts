import type { DirectorSignal, InterviewPlan, PlanBlock, TurnRecord } from '../domain/types.js';
import { detectCandidateIntent } from './candidateIntent.js';
import { isAnswerInContext } from './conversationModel.js';

// Interview Director (BRD 14.2, 16.2). Authoritative controller of time,
// coverage and depth. It does NOT speak — it emits signals the Conversation
// Runtime turns into utterances. Decisions are based on evidence and time only,
// never on demographic or voice attributes.

/** Below this answer-quality score the candidate is probed once more before moving on. */
const WEAK_ANSWER_SCORE = 45;

/**
 * At or above this, the answer is good enough that the interesting information
 * lies past it — so it earns an extra turn to be pushed on, exactly as a weak
 * answer earns one to be rescued.
 */
const STRONG_ANSWER_SCORE = 65;

export function answersNeeded(block: PlanBlock): number {
  if (block.competencyId.startsWith('__')) return 1;
  return Math.max(1, Math.min(3, Math.round(block.targetMinutes / 2.5)));
}

/** Cheap answer-quality signal used to decide depth and which follow-up to ask. */
export function answerQuality(text: string): { score: number; hasSituation: boolean; hasAction: boolean; hasResult: boolean; specific: boolean } {
  const t = (text || '').toLowerCase();
  const words = t.split(/\s+/).filter(Boolean).length;
  const hasSituation = /\b(when|at|during|context|project|team|situation|faced|problem)\b/.test(t);
  const hasAction = /\b(i |we |built|designed|led|implemented|decided|created|managed|analyzed|migrated|fixed)\b/.test(t);
  const hasResult = /\b(result|reduced|increased|improved|delivered|outcome|impact|%|saved|grew|achieved)\b/.test(t);
  const specific = /\b(\d|percent|%|specific|for example|e\.g\.|such as|named|called)\b/.test(t) || words > 55;
  let score = 0;
  score += Math.min(40, words); // verbosity as weak proxy
  score += hasSituation ? 15 : 0;
  score += hasAction ? 20 : 0;
  score += hasResult ? 20 : 0;
  score += specific ? 15 : 0;
  return { score: Math.min(100, score), hasSituation, hasAction, hasResult, specific };
}

/**
 * A block the candidate could not or would not answer is marked covered so
 * the director moves on. One over the base quota, so the bonus turn a strong
 * earlier answer can earn does not reopen it.
 */
function skippedCoverage(block: PlanBlock | undefined): number {
  return block ? answersNeeded(block) + 1 : 1;
}

/**
 * How many answers each block has had.
 *
 * Only real answers count. "Pardon?", "are you an AI?", "Pause", "Oh", "No",
 * "Nothing" and a candidate's own question are the conversation, not answers
 * to the question: counting them closed blocks with nothing said — a
 * production transcript followed up "Oh" and "Welcome back" as if they were
 * answers — and put the candidate's first real answer against a question they
 * had not been asked.
 *
 * Two non-answers in a row to the same block, or an explicit "skip", mark the
 * block as done so the interview moves on rather than asking the same thing a
 * third time. The skipped turns are still not evidence (evidenceExtractor).
 */
export function coverageState(plan: InterviewPlan, turns: TurnRecord[]): Record<string, number> {
  const state: Record<string, number> = {};
  for (const b of plan.blocks) state[b.competencyId] = 0;
  const streak: Record<string, number> = {};
  const skipped = new Set<string>();
  for (const [i, t] of turns.entries()) {
    if (t.speaker !== 'candidate' || !t.competencyId) continue;
    const id = t.competencyId;
    // In context, because "Yes" is the whole answer to "did you write them
    // yourself?" and nothing at all to "walk me through how you QA a script".
    if (isAnswerInContext(turns, i)) {
      state[id] = (state[id] ?? 0) + 1;
      streak[id] = 0;
      continue;
    }
    const { intent } = detectCandidateIntent(t.text);
    if (id === '__candidate_questions__') continue;
    if (intent === 'skip') skipped.add(id);
    if (intent === 'non_answer') {
      streak[id] = (streak[id] ?? 0) + 1;
      if (streak[id] >= 2) skipped.add(id);
    }
  }
  for (const id of skipped) {
    state[id] = Math.max(state[id] ?? 0, skippedCoverage(plan.blocks.find((b) => b.competencyId === id)));
  }
  // The opening greets and asks the warm-up question in one turn, so the
  // answer to it IS the warm-up answer. Without this the warm-up question was
  // asked a second time straight after the candidate had answered it.
  if ('__warmup__' in state && (state.__process__ ?? 0) > 0) {
    state.__warmup__ = Math.max(state.__warmup__, state.__process__);
  }
  return state;
}

export function directorDecide(opts: {
  plan: InterviewPlan;
  turns: TurnRecord[];
  elapsedMinutes: number;
}): DirectorSignal {
  const { plan, turns, elapsedMinutes } = opts;
  const timeRemaining = Math.max(0, plan.durationMinutes - elapsedMinutes);
  const cover = coverageState(plan, turns);

  // The last real answer: depth and follow-ups are decided on what the
  // candidate said, never on "Pause" or "Oh".
  const lastCandidate = [...turns].reverse().find((t, i) => t.speaker === 'candidate' && isAnswerInContext(turns, turns.length - 1 - i));
  const q = lastCandidate ? answerQuality(lastCandidate.text) : { score: 0, hasSituation: false, hasAction: false, hasResult: false, specific: false };

  // One bonus turn on the block the candidate just answered, when the answer was
  // either weak enough to be worth rescuing or strong enough to be worth pushing.
  //
  // This has to be applied HERE, in block selection, not only when choosing an
  // action inside the selected block. The loop below picks the first block that
  // has not met `answersNeeded`, so a block already at quota is never selected
  // as current at all — and the action logic that grants the extra turn is never
  // reached. That made the pre-existing weak-answer allowance dead code, and it
  // is why answering a one-answer block well used to buy an immediate change of
  // subject: the candidate's best material ended the block.
  //
  // Scoped to competency blocks, and self-limiting: once the bonus answer lands,
  // coverage equals the raised quota and the block closes.
  const bonusBlockId =
    lastCandidate?.competencyId &&
    !lastCandidate.competencyId.startsWith('__') &&
    (q.score < WEAK_ANSWER_SCORE || q.score >= STRONG_ANSWER_SCORE)
      ? lastCandidate.competencyId
      : undefined;
  const quotaFor = (b: PlanBlock): number => answersNeeded(b) + (b.competencyId === bonusBlockId ? 1 : 0);

  // Find the first block whose answer quota is not yet met.
  const assessableBlocks = plan.blocks.filter((b) => b.competencyId !== '__candidate_questions__');
  let current: PlanBlock | undefined;
  for (const b of assessableBlocks) {
    if ((cover[b.competencyId] ?? 0) < quotaFor(b)) { current = b; break; }
  }

  // Out of time (reserve the candidate-questions block) or everything covered -> close.
  const candidateQBlock = plan.blocks.find((b) => b.competencyId === '__candidate_questions__');
  if (!current || timeRemaining <= (candidateQBlock?.targetMinutes ?? 3)) {
    return {
      nextCompetencyId: '__candidate_questions__',
      action: 'close',
      depthInstruction: 'hold',
      timeRemainingMinutes: timeRemaining,
      coverageState: cover,
      reason: !current ? 'All planned competencies covered.' : 'Time budget reached; moving to close.',
    };
  }

  // Determine action within the current block.
  const answersHere = cover[current.competencyId] ?? 0;
  const lastWasThisBlock = lastCandidate?.competencyId === current.competencyId;
  const allowance = quotaFor(current);

  let action: DirectorSignal['action'];
  let depth: DirectorSignal['depthInstruction'] = 'hold';
  if (answersHere === 0 || !lastWasThisBlock) {
    action = 'ask';
  } else if (answersHere < allowance && q.score < STRONG_ANSWER_SCORE) {
    action = 'followup';
    depth = 'hold';
  } else if (answersHere < allowance) {
    action = 'followup';
    depth = 'increase'; // strong answer -> push deeper
  } else {
    action = 'move_on';
    depth = 'hold';
  }
  // If the candidate is clearly struggling, ease difficulty.
  if (q.score < 25 && answersHere >= 1) depth = 'decrease';

  return {
    nextCompetencyId: current.competencyId,
    action,
    depthInstruction: depth,
    timeRemainingMinutes: timeRemaining,
    coverageState: cover,
    reason: `Block "${current.competencyName}" (${answersHere}/${answersNeeded(current)} answers, last quality ${q.score}).`,
  };
}
