/**
 * Pure helpers for the owner's library screen: what the API returns and how
 * it reads on the page. No React, so every rule here is unit-tested.
 */

export type WorkerState = 'running' | 'idle' | 'paused' | 'waiting_for_credits' | 'critic_unavailable' | 'stopped';
export type PoolHealth = 'empty' | 'thin' | 'ready';
export type Tone = 'ok' | 'warn' | 'stop' | 'muted';

export interface WorkerStatusView {
  readonly state: WorkerState;
  readonly reason: string;
  readonly since: string;
  readonly lastBatchAt: string | null;
  readonly lastError: string;
}

export interface BudgetView {
  readonly day: string;
  readonly callsUsedToday: number;
  readonly dailyCap: number;
  readonly tokens30d: number;
  readonly monthlyCap: number;
  readonly tokensToday: number;
}

export interface CriticView {
  readonly provider: string;
  readonly model: string;
  readonly configured: boolean;
}

export interface LibraryOverview {
  readonly enabled: boolean;
  readonly workerEnabled: boolean;
  readonly critic: CriticView;
  readonly worker: WorkerStatusView;
  readonly budget: BudgetView;
  readonly counts: Partial<Record<'draft' | 'probational' | 'live' | 'retired' | 'rejected', number>>;
  readonly queueTotal: number;
}

export interface PoolRow {
  readonly roleSlug: string;
  readonly competencyKey: string;
  readonly band: string;
  readonly target: number;
  readonly live: number;
  readonly probational: number;
  readonly queued: number;
  readonly rejected: number;
  readonly retired: number;
  readonly health: PoolHealth;
  readonly formMix: Readonly<Record<string, number>>;
  readonly formMixOk: boolean;
}

export interface CriticVerdictView {
  readonly realQuestion: boolean;
  readonly rightBand: boolean;
  readonly answerable: boolean;
  readonly formCorrect: boolean;
  readonly anchorsLeaked: boolean;
  readonly roleSpecific: boolean;
  readonly confidence: number;
  readonly notes: string;
}

export interface EntryView {
  readonly id: string;
  readonly scope: string;
  readonly roleSlug: string;
  readonly competencyKey: string;
  readonly band: string;
  readonly form: string;
  readonly questionText: string;
  readonly anchors: readonly string[];
  readonly rationale: string;
  readonly status: string;
  readonly gateOutcome: string;
  readonly gateReasons: readonly string[];
  readonly stratumKey: string;
  readonly difficultyTag: number;
  readonly supersedesId: string | null;
  readonly generatorPromptVersion: string;
  readonly generatorModel: string;
  readonly criticModel: string;
  readonly criticVerdict: CriticVerdictView | null;
  readonly sampledOn: string;
  readonly createdAt: string;
}

export interface HistoryRow {
  readonly id: string;
  readonly actor: string;
  readonly action: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly reason: string;
  readonly at: string;
}

export interface StratumRow {
  readonly stratumKey: string;
  readonly total: number;
  readonly probational: number;
  readonly live: number;
  readonly rejected: number;
  readonly queued: number;
  readonly cleanApprovals: number;
  readonly tightenedRemaining: number;
  readonly promotionRate: number;
  readonly rejectionRate: number;
}

const WORKER_LABELS: Readonly<Record<WorkerState, string>> = {
  running: 'Running',
  idle: 'Idle',
  paused: 'Paused',
  waiting_for_credits: 'Waiting for credits',
  critic_unavailable: 'Critic not configured',
  stopped: 'Stopped',
};

export function workerStateLabel(state: WorkerState): string {
  return WORKER_LABELS[state] ?? state;
}

export function workerStateTone(state: WorkerState): Tone {
  if (state === 'running' || state === 'idle') return 'ok';
  if (state === 'paused') return 'warn';
  if (state === 'stopped') return 'muted';
  return 'stop';
}

/** What the owner must do, or nothing when the worker can run. */
export function workerAdvice(overview: Pick<LibraryOverview, 'workerEnabled' | 'critic' | 'worker'>): string {
  if (!overview.workerEnabled) return 'The worker is switched off (LIBRARY_WORKER_ENABLED). Nothing is being generated.';
  if (!overview.critic.configured) {
    return overview.critic.provider === 'anthropic'
      ? 'The critic is not configured: set ANTHROPIC_API_KEY for the Anthropic critic. The worker will not fill without an independent critic.'
      : 'The critic is not configured: set OPENAI_API_KEY for the OpenAI critic. The worker will not fill without an independent critic.';
  }
  if (overview.worker.state === 'waiting_for_credits') return 'The model provider reported no credit left. The worker retries every hour; top up the account to resume.';
  if (overview.worker.state === 'critic_unavailable') return `The critic cannot run (${overview.worker.reason}). Fix the key or the provider setting; the worker retries every hour.`;
  return '';
}

export function percent(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function budgetBurn(budget: BudgetView): { readonly dailyShare: number; readonly monthlyShare: number; readonly dailyLabel: string; readonly monthlyLabel: string } {
  const dailyShare = budget.dailyCap > 0 ? Math.min(1, budget.callsUsedToday / budget.dailyCap) : 0;
  const monthlyShare = budget.monthlyCap > 0 ? Math.min(1, budget.tokens30d / budget.monthlyCap) : 0;
  return {
    dailyShare, monthlyShare,
    dailyLabel: `${budget.callsUsedToday.toLocaleString()} of ${budget.dailyCap.toLocaleString()} calls today`,
    monthlyLabel: `${compactTokens(budget.tokens30d)} of ${compactTokens(budget.monthlyCap)} tokens in 30 days`,
  };
}

export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

const HEALTH_LABELS: Readonly<Record<PoolHealth, string>> = { empty: 'Empty', thin: 'Below target', ready: 'At target' };

export function healthLabel(health: PoolHealth): string {
  return HEALTH_LABELS[health];
}

export function healthTone(health: PoolHealth): Tone {
  return health === 'ready' ? 'ok' : health === 'thin' ? 'warn' : 'stop';
}

export function depthLabel(pool: Pick<PoolRow, 'live' | 'probational' | 'target'>): string {
  return `${pool.live} live · ${pool.probational} probational · target ${pool.target}`;
}

export function formMixLabel(mix: Readonly<Record<string, number>>): string {
  const parts = Object.entries(mix).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return parts.length === 0 ? 'no forms yet' : parts.map(([form, n]) => `${form.replace('_', ' ')} ${n}`).join(' · ');
}

const HEALTH_ORDER: Readonly<Record<PoolHealth, number>> = { empty: 0, thin: 1, ready: 2 };

/** Worst first, so what needs the owner's eye is at the top. */
export function sortPools(pools: readonly PoolRow[]): PoolRow[] {
  return [...pools].sort((a, b) => HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] || a.roleSlug.localeCompare(b.roleSlug) || a.competencyKey.localeCompare(b.competencyKey) || a.band.localeCompare(b.band));
}

export function humanSlug(slug: string): string {
  return slug.split('-').filter((part) => part.length > 0).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ');
}

export function stratumLabel(stratumKey: string): string {
  const [scope, roleSlug, band, form, version] = stratumKey.split('|');
  return `${humanSlug(roleSlug ?? '')} · ${band ?? ''} · ${(form ?? '').replace('_', ' ')} · ${version ?? ''}${scope === 'org' ? ' · private' : ''}`;
}

export function gateLabel(entry: Pick<EntryView, 'status' | 'gateOutcome' | 'gateReasons'>): string {
  if (entry.status === 'draft' && entry.gateOutcome === 'unsure') return entry.gateReasons.length ? `Needs a look: ${entry.gateReasons.join(', ')}` : 'Needs a look';
  if (entry.status === 'rejected') return entry.gateReasons.length ? `Rejected: ${entry.gateReasons.join(', ')}` : 'Rejected';
  return entry.status;
}

/** The critic's checks that failed, in plain words; empty when all passed. */
export function verdictProblems(verdict: CriticVerdictView | null): string[] {
  if (!verdict) return ['no critic verdict'];
  const problems: string[] = [];
  if (!verdict.realQuestion) problems.push('not a real question');
  if (!verdict.rightBand) problems.push('wrong band');
  if (!verdict.answerable) problems.push('not answerable in 3–5 minutes');
  if (!verdict.formCorrect) problems.push('form tag wrong');
  if (verdict.anchorsLeaked) problems.push('anchors leaked');
  if (!verdict.roleSpecific) problems.push('generic, not role-specific');
  return problems;
}

export function decisionMessage(action: 'approve' | 'reject' | 'edit' | 'retire', ok: boolean, code?: string): string {
  if (ok) {
    if (action === 'approve') return 'Approved. The entry is probational and can be asked in the sandbox.';
    if (action === 'reject') return 'Rejected. The reason is kept for the generator.';
    if (action === 'edit') return 'Saved as a new draft. It waits in the queue; the old wording is retired.';
    return 'Retired. Transcripts that asked it still resolve.';
  }
  if (code === 'invalid_transition') return 'That entry has moved on since you loaded it. Reload the queue.';
  if (code === 'lint') return 'The edited question fails the linter. Fix the wording and try again.';
  return 'The decision could not be recorded. Try again.';
}
