import { generateJson } from '../providers/llm/index.js';
import { logger } from '../logger.js';
import {
  chooseFeedbackContent, feedbackPromptInput, modelFeedbackSchema,
  type FeedbackContent, type FeedbackContentSource, type FeedbackInput, type ModelFeedback,
} from './feedbackContentModel.js';

export const FEEDBACK_PROMPT_VERSION = 'candidate-feedback-v2';

// The model is told the rules, but the rules are not trusted to the model:
// whatever it returns goes through the same guardrails as every other wording
// (feedbackContentModel.ts), and fails over to wording built from the evidence.
const SYSTEM = [
  'You write warm, specific interview feedback addressed directly to a job candidate ("you"), for a letter that has',
  'a SWOT, a section per competency, and three next steps.',
  'Return JSON {"swot":{"strengths":[2-3],"weaknesses":[2-3],"opportunities":[2-3],"watchOuts":[2-3]},',
  '"notes":[{"competencyId","whatWeHeard","toGoFurther"}],"nextSteps":[3 strings]}.',
  'Use only the competencies, coverage words and quoted answers you are given. Never invent an example or a quote.',
  'Coverage "Not covered" means the subject never came up: say so kindly and never treat it as a failing.',
  '"whatWeHeard" describes what the candidate actually said; "toGoFurther" is one concrete, practical improvement.',
  'Write each next step as an action they can take this week.',
  'Never mention scores, marks, levels, ratings, percentages, rankings, weightings, thresholds, pass or fail, a',
  'recommendation, other candidates, or any hiring decision, outcome, next round or promise.',
  'Never mention age, gender, nationality, accent, family, health, religion or any other personal characteristic.',
  'Do not mention AI, automation or how the feedback was produced. Write as the hiring team.',
].join(' ');

export interface GeneratedFeedback {
  readonly content: FeedbackContent;
  readonly source: FeedbackContentSource;
}

/**
 * The letter for one assessment. Never throws for a model problem: no model, a
 * demo interview (generateJson refuses to spend on those), a timeout, bad JSON
 * or a guardrail failure all end in wording built without it — over the same
 * facts either way.
 */
export async function generateFeedbackContent(input: FeedbackInput, sessionId: string): Promise<GeneratedFeedback> {
  const prompt = feedbackPromptInput(input);
  const covered = prompt.competencies.some((c) => c.theirWords.length > 0);
  // With nothing evidenced the model has nothing true to say; skip the call.
  const model = covered
    ? await generateJson<ModelFeedback>({
      fn: 'candidate_feedback',
      system: SYSTEM,
      user: JSON.stringify({ ...prompt, promptVersion: FEEDBACK_PROMPT_VERSION }),
      validate: (raw) => modelFeedbackSchema.parse(raw),
      sessionId,
      temperature: 0.3,
      maxTokens: 1800,
      timeoutMs: 30_000,
    })
    : null;
  const chosen = chooseFeedbackContent({ model, input });
  if (chosen.rejected.length) {
    // Which rule tripped, never the text: the text quotes the candidate.
    logger.warn({ sessionId, rejected: chosen.rejected, used: chosen.source }, 'Feedback wording failed a check; used the fallback');
  }
  return { content: chosen.content, source: chosen.source };
}
