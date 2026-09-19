
export interface LintHit { readonly term: string; readonly suggestion: string }
export type JdOrigin = 'draft' | 'described' | 'pasted' | 'ats' | '';

export type DraftPanelState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly attempt: number; readonly liveMessage: string }
  | { readonly kind: 'pending'; readonly attempt: number; readonly startedAt: number; readonly delayMs: number; readonly liveMessage?: string }
  | { readonly kind: 'ready'; readonly id: string; readonly text: string; readonly lint: readonly LintHit[]; readonly generator: string; readonly expanded: boolean; readonly liveMessage: string }
  | { readonly kind: 'failed'; readonly message: string; readonly liveMessage: string };

export type DraftPanelEvent =
  | { readonly type: 'request' }
  | { readonly type: 'pending'; readonly now?: number }
  | { readonly type: 'ready'; readonly id: string; readonly text: string; readonly lint: readonly LintHit[]; readonly generator: string }
  | { readonly type: 'failed'; readonly message?: string }
  | { readonly type: 'toggle' }
  | { readonly type: 'reset' };

const MAX_POLL_MS = 30_000;

export function nextDraftState(state: DraftPanelState, event: DraftPanelEvent): DraftPanelState {
  if (event.type === 'reset') return { kind: 'idle' };
  if (event.type === 'request') return { kind: 'loading', attempt: 0, liveMessage: 'Looking for a suggested job description.' };
  if (event.type === 'pending') {
    const priorAttempt = state.kind === 'pending' || state.kind === 'loading' ? state.attempt : 0;
    const startedAt = state.kind === 'pending' ? state.startedAt : event.now ?? Date.now();
    const attempt = priorAttempt + 1;
    return { kind: 'pending', attempt, startedAt, delayMs: pollDelayMs(attempt), liveMessage: priorAttempt === 0 ? 'Suggested job description is being prepared.' : undefined };
  }
  if (event.type === 'ready') return { kind: 'ready', id: event.id, text: event.text, lint: [...event.lint], generator: event.generator, expanded: false, liveMessage: 'Suggested job description is ready.' };
  if (event.type === 'failed') return { kind: 'failed', message: event.message ?? 'Try again, or paste your own job description.', liveMessage: 'The suggested job description is not ready.' };
  if (event.type === 'toggle' && state.kind === 'ready') return { ...state, expanded: !state.expanded };
  return state;
}

export function shouldPollDraft(state: DraftPanelState, elapsedMs: number): boolean {
  return state.kind === 'pending' && elapsedMs <= MAX_POLL_MS;
}

export function pollDelayMs(attempt: number): number {
  return Math.min(5_000, 750 * 2 ** Math.max(0, attempt - 1));
}

export function previewLines(text: string, expanded: boolean, maxLines = 12): string {
  const lines = text.split('\n');
  return expanded || lines.length <= maxLines ? text : lines.slice(0, maxLines).join('\n');
}

export function appendTechStack(text: string, techStack: readonly string[]): string {
  const stack = techStack.map((s) => s.trim()).filter(Boolean);
  if (!stack.length) return text;
  return `${text.trim()}\n\nTech stack: ${stack.join(', ')}.`;
}

export function jdOriginForSubmit(input: { readonly source: 'paste' | 'ats'; readonly sourceText: string; readonly draftText: string; readonly describedUsed: boolean }): JdOrigin {
  if (input.source === 'ats') return 'ats';
  if (input.draftText && input.sourceText.trim()) return 'draft';
  if (input.describedUsed && input.sourceText.trim()) return 'described';
  if (input.sourceText.trim()) return 'pasted';
  return '';
}
