import type { PipelineStage } from './pipelineStages.js';
import { resolveDecision, resolveTransition, type DecisionOutcome } from './pipelineAutonomy.js';
import { decisionOfVerdict, VERDICTS, type Verdict } from './verdict.js';

/**
 * What a verdict will do to the candidate's journey, worked out before the
 * reviewer commits to it.
 *
 * The owner's rule for the redesigned page is that each choice says what it
 * will do BEFORE it does it. A sentence like that is worth nothing unless it
 * is the same arithmetic the submit then performs, so this predicts both
 * steps the submit takes, in the order it takes them:
 *
 *   1. a reviewed interview is an assessed one, which carries the candidate
 *      to the human round (Silver → Gold) whatever the verdict says;
 *   2. the verdict is then the decision on the AI round — Proceed approves it,
 *      Do not progress ends the journey where the candidate now stands, and
 *      Consider decides nothing.
 *
 * Predicting only step 2 is how a preview comes to promise that a candidate
 * will stay at Silver, when reviewing them is precisely what moves them.
 *
 * Pure, and the route both previews and acts through it, so the promise and
 * the act cannot drift (tests/verdictConsequence.test.ts, and
 * tests/assessmentVerdictFlow.test.ts holds the preview to what actually
 * happened).
 */

export interface VerdictConsequence {
  readonly verdict: Verdict;
  readonly fromStageKey: string;
  readonly fromStageLabel: string;
  readonly toStageKey: string;
  readonly toStageLabel: string;
  /** True when the candidate changes stage. */
  readonly moves: boolean;
  /** The stored decision the journey ends with, or null when it stays open. */
  readonly closes: DecisionOutcome | null;
  /** True when the journey was over before this verdict: nothing it says moves anyone. */
  readonly alreadyDecided: boolean;
}

const ACTIVE = 'ACTIVE';

function labelOf(stages: readonly PipelineStage[], key: string): string {
  return stages.find((stage) => stage.key === key)?.label ?? key;
}

/** The stage the verdict is about: the one the AI conducted. */
function aiStageKey(stages: readonly PipelineStage[]): string | null {
  return stages.find((stage) => stage.kind === 'ai_interview')?.key ?? null;
}

export function verdictConsequence(
  stages: readonly PipelineStage[], currentStageKey: string, status: string, verdict: Verdict,
): VerdictConsequence {
  const from = { fromStageKey: currentStageKey, fromStageLabel: labelOf(stages, currentStageKey) };
  const stay: VerdictConsequence = {
    verdict, ...from, toStageKey: currentStageKey, toStageLabel: from.fromStageLabel,
    moves: false, closes: null, alreadyDecided: status !== ACTIVE,
  };
  if (status !== ACTIVE) return stay;

  // Step 1: reviewing the interview assesses it.
  const assessed = resolveTransition(stages, currentStageKey, 'interview.assessed');
  const afterEvent = assessed ? assessed.to : currentStageKey;

  // Step 2: the verdict, as the decision on the AI round.
  const outcome = decisionOfVerdict(verdict);
  const about = aiStageKey(stages);
  const effect = outcome && about ? resolveDecision(stages, afterEvent, outcome, about) : null;

  const landed = effect?.kind === 'advance' ? effect.to : effect?.kind === 'close' ? effect.atStageKey : afterEvent;
  return {
    ...stay,
    toStageKey: landed,
    toStageLabel: labelOf(stages, landed),
    moves: landed !== currentStageKey,
    closes: effect?.kind === 'close' ? effect.outcome : null,
  };
}

/** Every verdict's consequence, in the order the control offers them. */
export function verdictConsequences(
  stages: readonly PipelineStage[], currentStageKey: string, status: string,
): VerdictConsequence[] {
  return VERDICTS.map((verdict) => verdictConsequence(stages, currentStageKey, status, verdict));
}
