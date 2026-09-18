import { STATUS_WORD, type OverallStatus } from './systemHealthModel';

/**
 * The one overall health verdict the sidebar shows on every page, shared with
 * the System health panel so the two can never disagree: whichever of them
 * checks last publishes here, and the other reads it.
 *
 * Kept free of React so the wording is tested on its own
 * (web/tests/healthStatusStore.test.ts).
 */

/** `unchecked` before the first answer; `unavailable` when the check itself failed. */
export type NavHealthStatus = OverallStatus | 'unchecked' | 'unavailable';

export interface NavHealth {
  readonly status: NavHealthStatus;
  /** Epoch ms of the answer; 0 until there is one. */
  readonly checkedAt: number;
}

const INITIAL: NavHealth = { status: 'unchecked', checkedAt: 0 };

let current: NavHealth = INITIAL;
const listeners = new Set<() => void>();
// Whose verdict this is. The operator's report covers the whole deployment and
// anyone else's only their organisation, so a verdict never outlives the
// session it was checked for.
let owner: string | null = null;

export function readHealth(): NavHealth {
  return current;
}

export function publishHealth(next: NavHealth): void {
  current = next;
  listeners.forEach((listener) => listener());
}

export function subscribeHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** For tests: forget every answer and its owner. */
export function resetHealth(): void {
  owner = null;
  publishHealth(INITIAL);
}

export function healthOwner(): string | null {
  return owner;
}

/** Hands the store to this session; a different user starts from no answer. */
export function claimHealth(userId: string | null): void {
  if (userId === owner) return;
  owner = userId;
  publishHealth(INITIAL);
}

/**
 * The verdict as this user may see it. Checked during render, so the first
 * paint after a change of user never shows the previous user's answer.
 */
export function verdictFor(health: NavHealth, userId: string | null): NavHealth {
  return userId !== null && userId === owner ? health : INITIAL;
}

/** Whether an answer this old should be asked again. */
export function isStale(health: NavHealth, now: number, maxAgeMs: number): boolean {
  return health.checkedAt === 0 || now - health.checkedAt >= maxAgeMs;
}

/** The status in words, so the marker never depends on its colour. */
export function navHealthWord(status: NavHealthStatus): string {
  if (status === 'unchecked') return 'Checking';
  if (status === 'unavailable') return 'Unknown';
  return STATUS_WORD[status === 'ok' ? 'ok' : status];
}

/** The link's accessible name and tooltip: what it is, then how it is. */
export function navHealthLabel(status: NavHealthStatus): string {
  return `System health: ${navHealthWord(status)}`;
}

/**
 * A healthy system reads calm — only a dot. Anything that needs a look also
 * says so in words beside the link, so it is seen without hovering.
 */
export function showsNavHealthWord(status: NavHealthStatus): boolean {
  return status === 'warn' || status === 'fail' || status === 'unavailable';
}
