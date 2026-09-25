import type { PipelineStage, StageKind } from './pipelineStages.js';

/**
 * The candidate journey: which part of it happens by itself, and which part
 * waits for a person.
 *
 * Two events still move a candidate without anyone pressing "Move to …":
 *
 *   candidate.onboarded   the candidate exists            → Participation
 *   candidate.profiled    their resume has been analysed  → Bronze
 *   candidate.finalized   a person finalised them         → Diamond
 *
 * Participation and Bronze are bookkeeping — the candidate exists, their CV
 * has been read — and neither is a judgement anybody makes. Silver, Gold and
 * Diamond are. So `interview.scheduled` and `interview.assessed` remain
 * events, and move nobody.
 *
 * WHY THEY STOPPED MOVING ANYONE. A tier is struck when a person promotes a
 * candidate OUT of it (services/candidateAwards.ts, awardOnPromotion), and
 * only the decision paths strike it. The assessment's own move struck nothing
 * and always arrived first: by the time a reviewer chose Proceed the candidate
 * was already at Gold, there was no move left, and no badge was minted. Five
 * candidates reached Gold in production and not one of them holds a
 * credential. Removing these two transitions is what makes the reviewer's
 * Proceed the move that mints Silver.
 *
 * The events are still RAISED, and deliberately: they start a pipeline for a
 * candidate who has none (services/pipelineAutonomy.ts, ensurePipeline), and
 * the routes that raise them write their own audit entries, so the trail still
 * records that an interview was booked and that an assessment landed. What
 * they no longer do is decide anything.
 *
 * WHAT TELLS ANYBODY. On its own this would strand every candidate at Bronze
 * in silence — there is an endpoint to move them and nothing that asks. The
 * "Needs you" queue's `stage_decision` row is the other half
 * (services/needsYouRows.ts): a candidate who is ready to move appears in
 * front of the people who may move them.
 *
 * Two rules hold for every event that still moves anyone. A candidate only
 * ever moves FORWARD, and nothing here demotes anyone. And the last stage is
 * never reached by an event the system raises on its own — only a person's
 * explicit finalisation gets there.
 *
 * Stage plans are per role, so events name the KIND of stage they reach
 * rather than a key; a plan without a stage of that kind simply ignores the
 * event.
 */

export const PIPELINE_EVENTS = [
  'candidate.onboarded', 'candidate.profiled', 'interview.scheduled', 'interview.assessed', 'candidate.finalized',
] as const;
export type PipelineEvent = (typeof PIPELINE_EVENTS)[number];

export interface StageTransition {
  readonly from: string;
  readonly to: string;
}

/**
 * The events that still carry a candidate somewhere, and where.
 *
 * Partial on purpose: `interview.scheduled` and `interview.assessed` are
 * absent, which is the whole of "the assessment should not move the candidate,
 * HR decides". An event with no entry here reaches no stage, so it resolves to
 * no transition and applies nothing — while remaining a perfectly good event
 * for the pipeline it starts and the trail it is recorded in.
 */
const KIND_OF_EVENT: Readonly<Partial<Record<PipelineEvent, StageKind>>> = {
  'candidate.onboarded': 'intake',
  'candidate.profiled': 'profile_review',
};

/**
 * The stage an event reaches in this plan, or null when it reaches none: the
 * event moves nobody, or the plan has no stage of its kind. The last stage
 * belongs to finalisation alone, so a plan whose only stage of a kind is also
 * its last one gives that event nowhere to go.
 */
export function targetStageKey(stages: readonly PipelineStage[], event: PipelineEvent): string | null {
  if (event === 'candidate.finalized') return stages.length > 0 ? stages[stages.length - 1].key : null;
  const kind = KIND_OF_EVENT[event];
  if (!kind) return null;
  return stages.slice(0, -1).find((stage) => stage.kind === kind)?.key ?? null;
}

/**
 * The forward move an event causes from `currentStageKey`, or null when it
 * causes none: the target is missing, already reached, or behind the
 * candidate. Applying the same event twice therefore resolves to nothing the
 * second time.
 */
export function resolveTransition(stages: readonly PipelineStage[], currentStageKey: string, event: PipelineEvent): StageTransition | null {
  const target = targetStageKey(stages, event);
  if (!target) return null;
  const fromIndex = stages.findIndex((stage) => stage.key === currentStageKey);
  const toIndex = stages.findIndex((stage) => stage.key === target);
  if (fromIndex < 0 || toIndex <= fromIndex) return null;
  return { from: currentStageKey, to: target };
}

/**
 * Decisions. A person records one — as the verdict on an assessment review, or
 * on the pipeline itself — and the pipeline follows it without anyone pressing
 * "Move to …" afterwards:
 *
 *   APPROVED at a stage    → the stage after it (Silver → Gold, Gold → Diamond);
 *                            at the last stage, the pipeline closes approved
 *   APPROVED ahead of them → one stage on, and no further; the rest of the way
 *                            takes as many decisions as there are stages
 *   REJECTED / WITHDRAWN   → the pipeline closes with that outcome, where it is
 *
 * Approval is now the ONLY thing that moves anyone past Bronze, and it obeys
 * the same rules as the events above: forward only, one stage at a time, and
 * approving a stage the candidate has already left changes nothing. It is also
 * how the last stage is reached without the Finalise button — still a person's
 * decision, only recorded once.
 */

export const DECISION_OUTCOMES = ['APPROVED', 'REJECTED', 'WITHDRAWN'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export type DecisionEffect =
  | { readonly kind: 'advance'; readonly from: string; readonly to: string; readonly final: boolean }
  | { readonly kind: 'close'; readonly outcome: DecisionOutcome; readonly atStageKey: string };

/**
 * What a decision about `aboutStageKey` does to a candidate at
 * `currentStageKey`, or null when it does nothing. A rejection or withdrawal
 * closes the pipeline at the stage the candidate is actually at — the decision
 * may be about an earlier round, but nobody is moved back to it.
 */
export function resolveDecision(
  stages: readonly PipelineStage[], currentStageKey: string, outcome: DecisionOutcome, aboutStageKey: string,
): DecisionEffect | null {
  if (outcome !== 'APPROVED') return { kind: 'close', outcome, atStageKey: currentStageKey };
  const currentIndex = stages.findIndex((stage) => stage.key === currentStageKey);
  const aboutIndex = stages.findIndex((stage) => stage.key === aboutStageKey);
  if (currentIndex < 0 || aboutIndex < 0) return null;
  const lastIndex = stages.length - 1;
  if (aboutIndex === lastIndex) {
    return currentIndex === lastIndex ? { kind: 'close', outcome, atStageKey: currentStageKey } : null;
  }
  // One stage. Never two, whatever the decision was about.
  //
  // This matters now in a way it did not before. While the assessment moved
  // people, a candidate was always already standing at the round being judged,
  // so "the stage after the one the decision is about" and "the stage after the
  // one they are at" were the same stage. With the assessment moving nobody, a
  // candidate can be interviewed while their pipeline still says Participation,
  // and `aboutIndex + 1` would then carry them from Participation to Silver in
  // one go — over Bronze, which nobody had said anything about.
  //
  // Stages run in order. The Advance button says so in as many words when it
  // refuses a key that is not the next one, and a decision that could leapfrog
  // what the button cannot would make the two person-paths disagree about the
  // same pipeline. It also keeps every tier on the journey reachable: a tier is
  // struck by the move that LEAVES it (domain/candidateAwards.ts,
  // awardsForPromotion), so a candidate vaulted over a stage can never earn
  // what that stage was worth.
  const toIndex = Math.min(aboutIndex, currentIndex) + 1;
  if (toIndex <= currentIndex) return null;
  return { kind: 'advance', from: currentStageKey, to: stages[toIndex].key, final: toIndex === lastIndex };
}

/*
 * The decision a reviewer's verdict amounts to lives in domain/verdict.ts
 * (decisionOfVerdict). There is one vocabulary for that judgement and one
 * place the two stored enums are allowed to meet; it is not here.
 */
