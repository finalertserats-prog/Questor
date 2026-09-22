/**
 * Degraded mode on an assessment: which interviewer turns ran on the backup
 * local model or the built-in question bank while the AI provider was down.
 * Shown to the reviewer so thinner probes are not held against the candidate.
 */

export interface ServingModeView {
  degraded: boolean;
  turns: Array<{ index: number; layer: 'primary' | 'local' | 'built-in'; failure?: string }>;
  counts: { primary: number; local: number; builtIn: number };
}

function questions(n: number): string {
  return n === 1 ? '1 question was' : `${n} questions were`;
}

/** The note for the reviewer, or null when the interview ran fully on the primary model. */
export function servingModeSentence(mode: ServingModeView | undefined | null): string | null {
  if (!mode?.degraded) return null;
  const local = mode.turns.filter((t) => t.layer === 'local').length;
  const builtIn = mode.turns.filter((t) => t.layer === 'built-in').length;
  const which = local && builtIn
    ? `${questions(local)} worded by the backup local model and ${builtIn} by the built-in question bank`
    : local
      ? `${questions(local)} worded by the backup local model`
      : `${questions(builtIn)} asked from the built-in question bank`;
  const turnsWord = local + builtIn === 1 ? 'that turn' : 'those turns';
  return `The AI provider was unavailable for part of this interview: ${which}. Follow-up probes on ${turnsWord} may be plainer; weigh the answers with that in mind.`;
}
