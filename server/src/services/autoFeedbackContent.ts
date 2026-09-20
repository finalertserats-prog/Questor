import { generateJson } from '../providers/llm/index.js';
import type { AssessmentResult } from '../domain/types.js';
import { logger } from '../logger.js';
import {
  chooseFeedbackContent, feedbackContentSchema, feedbackPromptInput,
  type FeedbackContent, type FeedbackContentSource,
} from './feedbackContentModel.js';

export const FEEDBACK_PROMPT_VERSION = 'candidate-feedback-v1';

// The model is told the rules, but the rules are not trusted to the model:
// whatever it returns goes through the same guardrails as every other wording
// (feedbackContentModel.ts), and fails over to wording built from the evidence.
const SYSTEM = [
  'You write short, warm, specific interview feedback addressed directly to a job candidate ("you").',
  'Return JSON {"strengths": [2-3 strings], "develop": [2-3 strings], "suggestions": [1-2 strings]}, one or two sentences each.',
  'Base every point only on the competencies and the candidate\'s own quoted words you are given. You may quote them briefly.',
  '"clearlyShown" are things that came across well; "roomToGrow" are areas to develop. Never describe anything not listed as a weakness.',
  'Be constructive and practical: say what would make an answer stronger next time.',
  'Never mention scores, marks, levels, ratings, percentages, rankings, weightings, thresholds, pass or fail, a recommendation, other candidates, or any hiring decision, outcome, next round or promise.',
  'Never mention age, gender, nationality, accent, family, health, religion or any other personal characteristic.',
  'Do not mention AI, automation or how the feedback was produced. Write as the hiring team.',
].join(' ');

export interface GeneratedFeedback {
  readonly content: FeedbackContent;
  readonly source: FeedbackContentSource;
}

/**
 * The feedback points for one assessment. Never throws for a model problem:
 * no model, a demo interview (generateJson refuses to spend on those), a
 * timeout, bad JSON or a guardrail failure all end in wording built without it.
 */
export async function generateFeedbackContent(result: AssessmentResult, sessionId: string): Promise<GeneratedFeedback> {
  const input = feedbackPromptInput(result);
  const evidenced = input.clearlyShown.length + input.roomToGrow.length > 0;
  // With nothing evidenced the model has nothing true to say; skip the call.
  const model = evidenced
    ? await generateJson<FeedbackContent>({
      fn: 'candidate_feedback',
      system: SYSTEM,
      user: JSON.stringify({ ...input, promptVersion: FEEDBACK_PROMPT_VERSION }),
      validate: (raw) => feedbackContentSchema.parse(raw),
      sessionId,
      temperature: 0.3,
      maxTokens: 900,
      timeoutMs: 30_000,
    })
    : null;
  const chosen = chooseFeedbackContent({ model, result });
  if (chosen.rejected.length) {
    // Which rule tripped, never the text: the text quotes the candidate.
    logger.warn({ sessionId, rejected: chosen.rejected, used: chosen.source }, 'Feedback wording failed a check; used the fallback');
  }
  return { content: chosen.content, source: chosen.source };
}
