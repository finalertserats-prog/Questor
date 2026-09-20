import { z } from 'zod';
import type { Proficiency } from './types.js';

/**
 * What a role's success profile may contain when a person edits it.
 *
 * The scorecard editor used to accept `z.any()` and store it, which meant one
 * click on Save could put a threshold of 6500, a weight of 40, a competency
 * with no id, or a red flag the length of a novel into the JSON every engine
 * reads afterwards. The bounds below are the shape those engines assume
 * (server/src/domain/types.ts): weights are fractions, the threshold is points
 * out of 100, proficiency is 0..5, and the lists are short because a person
 * has to read them during an interview.
 */

const shortText = (max: number) => z.string().trim().max(max);
const shortList = (max: number, itemMax: number) => z.array(shortText(itemMax)).max(max);

export const RED_FLAG_MAX_LENGTH = 160;
export const RED_FLAG_MAX_COUNT = 20;
export const COMPETENCY_MAX_COUNT = 40;

// Narrowed after the range check so a validated profile is a RoleSuccessProfile as typed.
const proficiency = z.number().int().min(0).max(5).transform((n) => n as Proficiency);

export const competencySchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  definition: shortText(1000).default(''),
  category: z.enum(['behavioral', 'technical', 'domain', 'situational', 'communication']),
  classification: z.enum(['essential', 'preferred', 'trainable', 'non_scoring']),
  weight: z.number().min(0).max(1),
  requiredLevel: proficiency,
  targetLevel: proficiency,
  indicators: shortList(20, 300).default([]),
  evidenceModes: shortList(10, 60).default([]),
  sourceText: shortText(2000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  retired: z.boolean().optional(),
});

/** Whether a competency still counts towards the score: not retired, not non-scoring. */
export function isScored(c: { readonly classification: string; readonly retired?: boolean }): boolean {
  return c.classification !== 'non_scoring' && c.retired !== true;
}

export const roleSuccessProfileSchema = z.object({
  roleContext: shortText(4000).default(''),
  outcomes: shortList(50, 500).default([]),
  responsibilities: shortList(50, 500).default([]),
  competencies: z.array(competencySchema).min(1).max(COMPETENCY_MAX_COUNT),
  scoringRules: z.object({
    mustPassCompetencyIds: z.array(z.string().trim().min(1).max(64)).max(COMPETENCY_MAX_COUNT).default([]),
    notEnoughEvidencePolicy: z.enum(['exclude', 'penalize']).default('exclude'),
    passThreshold: z.number().min(0).max(100),
  }),
  policyRules: z.object({
    prohibitedTopics: shortList(50, 100).default([]),
    requiredDisclosures: shortList(20, 500).default([]),
    accommodationsEnabled: z.boolean().default(true),
    proctoringEnabled: z.boolean().optional(),
    jurisdiction: shortText(8).default(''),
  }),
  redFlags: z.array(z.string().trim().min(1).max(RED_FLAG_MAX_LENGTH)).max(RED_FLAG_MAX_COUNT).default([]),
  seniority: shortText(60).default(''),
})
  .superRefine((profile, ctx) => {
    const ids = new Set<string>();
    for (const c of profile.competencies) {
      if (ids.has(c.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['competencies'], message: `Competency id "${c.id}" appears twice.` });
      }
      ids.add(c.id);
    }
    // A must-pass competency is a promise to assess it, so it has to be one
    // that is scored: a non-scoring or retired one would be "required" and
    // never checked.
    const scoredIds = new Set(profile.competencies.filter(isScored).map((c) => c.id));
    for (const id of profile.scoringRules.mustPassCompetencyIds) {
      if (!ids.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scoringRules', 'mustPassCompetencyIds'],
          message: `Must-pass competency "${id}" is not one of the competencies.`,
        });
      } else if (!scoredIds.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scoringRules', 'mustPassCompetencyIds'],
          message: `Must-pass competency "${profile.competencies.find((c) => c.id === id)?.name ?? id}" is not scored, so it cannot be must-pass.`,
        });
      }
    }
    // The engines treat weights as shares of one whole. The extractor
    // normalises them to sum to 1 (rounded to three places), and an editor that
    // saved 340% would have every later fit and assessment score wrong with no
    // visible symptom. Non-scoring competencies carry no weight and sit outside
    // the total, and so does a retired one.
    for (const c of profile.competencies) {
      if (c.retired === true && c.weight !== 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['competencies'], message: `Retired competency "${c.name}" carries no weight; set it to 0.` });
      }
    }
    if (!profile.competencies.some((c) => c.retired !== true)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['competencies'], message: 'A scorecard needs at least one competency that is not retired.' });
    }
    const scoredTotal = profile.competencies
      .filter(isScored)
      .reduce((sum, c) => sum + c.weight, 0);
    if (Math.abs(scoredTotal - 1) > WEIGHT_SUM_TOLERANCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['competencies'],
        message: `Weights of the scored competencies total ${Math.round(scoredTotal * 100)}%; they must total 100%.`,
      });
    }
  });

/** Room for three-decimal rounding across up to forty competencies. */
const WEIGHT_SUM_TOLERANCE = 0.02;

export type ValidatedRoleSuccessProfile = z.infer<typeof roleSuccessProfileSchema>;
