import { prisma } from '../db.js';
import { getLlm, llmHealthSummary } from '../providers/llm/index.js';
import { sttCapability, ttsCapability } from '../providers/speech.js';
import { DEMO_SPEND_PER_DAY, DEMO_SPEND_PER_RUN, spendDayKey } from '../domain/demoBudget.js';

/**
 * Whether the candidate-side demo interview can be delivered PROPERLY, right
 * now — decided before anything starts, never during.
 *
 * THE RULE (owner, 2026-09-24): when it cannot be delivered properly it is not
 * offered. Not greyed out, not offered with a note saying the questions are
 * real but the voice is not — simply absent. A disclaimer at the moment a
 * prospect is deciding is worse than useless: it undercuts the product using
 * our own words, and it asks them to evaluate something we have just told them
 * is below standard.
 *
 * So the whole of the "what if the model is down" design is this function and
 * the two places that consult it. Nothing downstream ever has to apologise,
 * because nothing below standard is served.
 *
 * Observer mode has no readiness question. It is written, it calls nothing,
 * and it is as good on a day with no provider at all as on any other. That is
 * what makes this rule affordable: there is always something excellent to
 * offer.
 */

export interface DemoReadiness {
  /** May "Be the candidate" be offered? */
  readonly candidate: boolean;
  /** Always true. A written interview needs nothing to be working. */
  readonly observer: true;
  /**
   * Why not, for the operator's log and the owner's console.
   *
   * NEVER SHOWN TO A VISITOR. The visitor is shown a demo with one option
   * instead of two, which tells them nothing is wrong because nothing is.
   */
  readonly reasons: readonly string[];
}

/**
 * Enough of the day's budget left for a WHOLE sitting, not merely one call.
 *
 * Checked as a sitting rather than a call because of the other rule: nothing
 * breaks character once an interview has started. An interview begun with
 * three units left would spend them and then quietly change voice halfway
 * through — which is exactly the degradation we decided to make impossible by
 * deciding before the start instead.
 */
function dayHasRoomForASitting(used: number): boolean {
  return DEMO_SPEND_PER_DAY - used >= DEMO_SPEND_PER_RUN;
}

export async function demoInterviewReadiness(now = new Date()): Promise<DemoReadiness> {
  const reasons: string[] = [];

  // A real provider has to be configured at all. With none, `getLlm()` hands
  // back the built-in writer, which is not what a prospect is here to judge.
  if (!getLlm().enabled) reasons.push('no_model_configured');

  // ...and it has to be answering. The serving layer already tracks a primary
  // that is resting after an auth or quota failure; a demo offered into that
  // rest would be a demo run by the built-in writer.
  const health = llmHealthSummary(now.getTime());
  if (health.coolingDown || health.layer !== 'primary') reasons.push(`model_${health.layer}`);

  const day = await prisma.demoSpendDay.findUnique({ where: { dayKey: spendDayKey(now) }, select: { calls: true } });
  if (!dayHasRoomForASitting(day?.calls ?? 0)) reasons.push('day_budget_spent');

  // The voice is half of what a first-round interview feels like. An interview
  // conducted in the browser's own robotic speech is the thing the owner
  // objected to being disclaimed, so it is the thing we decline to serve.
  // `configured` alone is not enough: the browser-native fallback reports
  // itself as configured (it needs no key), and it is precisely the voice we
  // are declining to serve. Server mode AND configured is the real question.
  const tts = ttsCapability();
  const stt = sttCapability();
  if (!(tts.mode === 'server' && tts.configured)) reasons.push('no_server_voice');
  if (!(stt.mode === 'server' && stt.configured)) reasons.push('no_server_transcription');

  return { candidate: reasons.length === 0, observer: true, reasons };
}
