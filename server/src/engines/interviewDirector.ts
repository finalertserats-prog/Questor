import type { DirectorSignal, InterviewPlan, PlanBlock, TurnRecord } from '../domain/types.js';

// Interview Director (BRD 14.2, 16.2). Authoritative controller of time,
// coverage and depth. It does NOT speak — it emits signals the Conversation
// Runtime turns into utterances. Decisions are based on evidence and time only,
// never on demographic or voice attributes.

/** Below this answer-quality score the candidate is probed once more before moving on. */
const WEAK_ANSWER_SCORE = 45;

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

export function coverageState(plan: InterviewPlan, turns: TurnRecord[]): Record<string, number> {
  const state: Record<string, number> = {};
  for (const b of plan.blocks) state[b.competencyId] = 0;
  for (const t of turns) {
    if (t.speaker === 'candidate' && t.competencyId) {
      state[t.competencyId] = (state[t.competencyId] ?? 0) + 1;
    }
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

  // Find the first block whose answer quota is not yet met.
  const assessableBlocks = plan.blocks.filter((b) => b.competencyId !== '__candidate_questions__');
  let current: PlanBlock | undefined;
  for (const b of assessableBlocks) {
    if ((cover[b.competencyId] ?? 0) < answersNeeded(b)) { current = b; break; }
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
  const lastCandidate = [...turns].reverse().find((t) => t.speaker === 'candidate');
  const lastWasThisBlock = lastCandidate?.competencyId === current.competencyId;
  const q = lastCandidate ? answerQuality(lastCandidate.text) : { score: 0, hasSituation: false, hasAction: false, hasResult: false, specific: false };

  // A weak answer earns one probing turn beyond the block's quota. Without this
  // a block whose quota is 1 (short blocks, or many competencies in a fixed
  // budget) always falls straight through to move_on, so a vague answer is
  // silently accepted and the follow-up ladder below is never reached.
  const needed = answersNeeded(current);
  const allowance = lastWasThisBlock && q.score < WEAK_ANSWER_SCORE ? needed + 1 : needed;

  let action: DirectorSignal['action'];
  let depth: DirectorSignal['depthInstruction'] = 'hold';
  if (answersHere === 0 || !lastWasThisBlock) {
    action = 'ask';
  } else if (answersHere < allowance && q.score < 65) {
    action = 'followup';
    depth = 'hold';
  } else if (answersHere < allowance && q.score >= 65) {
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
