import { z } from 'zod';

/**
 * The medallion pipeline's stage vocabulary.
 *
 * Only one stage is conducted by the AI: the AI interview (Silver by default),
 * which HR may silently observe. Every other interview stage is conducted by a
 * person, with the AI as a silent observer that, when both parties agree,
 * transcribes and quotes (never summarises or judges; services/roundObserver.ts).
 * HR decides every advancement and every final outcome.
 */

export const STAGE_KINDS = ['intake', 'profile_review', 'ai_interview', 'human_interview'] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export interface PipelineStage {
  readonly key: string;
  readonly label: string;
  readonly kind: StageKind;
}

export const DEFAULT_STAGES: readonly PipelineStage[] = [
  { key: 'participation', label: 'Participation', kind: 'intake' },
  { key: 'bronze', label: 'Bronze', kind: 'profile_review' },
  { key: 'silver', label: 'Silver', kind: 'ai_interview' },
  { key: 'gold', label: 'Gold', kind: 'human_interview' },
  { key: 'platinum', label: 'Platinum', kind: 'human_interview' },
  { key: 'diamond', label: 'Diamond', kind: 'human_interview' },
];

export const stagesSchema = z
  .array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/, 'Stage keys are lowercase letters, numbers, - or _.'),
    // Labels reach email subjects and bodies; a line break could forge headers or text.
    label: z.string().trim().min(1).max(40).regex(/^[^\x00-\x1f\x7f]+$/, 'Stage labels cannot contain line breaks or control characters.'),
    kind: z.enum(STAGE_KINDS),
  }))
  .min(2)
  .max(12)
  .refine((stages) => new Set(stages.map((s) => s.key)).size === stages.length, 'Stage keys must be unique.')
  .refine((stages) => stages[0]?.kind === 'intake', 'The first stage must be the intake stage.')
  .refine((stages) => stages.filter((s) => s.kind === 'ai_interview').length <= 1, 'Only one stage can be the AI-conducted interview.');

/** Parse a stored stage plan, falling back to the defaults if it is missing or invalid. */
export function parseStages(json: string): PipelineStage[] {
  try {
    const parsed = stagesSchema.safeParse(JSON.parse(json));
    if (parsed.success) return parsed.data;
  } catch {
    // Unparseable JSON is treated the same as no configuration.
  }
  return DEFAULT_STAGES.map((stage) => ({ ...stage }));
}

/** The key of the stage after `current`, or null at the last stage. */
export function nextStageKey(stages: readonly PipelineStage[], current: string): string | null {
  const index = stages.findIndex((stage) => stage.key === current);
  return index >= 0 && index < stages.length - 1 ? stages[index + 1].key : null;
}

export interface RoundRoles {
  readonly conductedBy: 'AI' | 'HUMAN';
  readonly aiObserver: boolean;
  readonly hrMayObserve: boolean;
}

/** Who runs an interview round at a stage of this kind; null when the stage is not an interview. */
export function roundRolesFor(kind: StageKind): RoundRoles | null {
  if (kind === 'ai_interview') return { conductedBy: 'AI', aiObserver: false, hrMayObserve: true };
  if (kind === 'human_interview') return { conductedBy: 'HUMAN', aiObserver: true, hrMayObserve: false };
  return null;
}
