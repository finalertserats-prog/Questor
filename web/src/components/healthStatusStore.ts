import { STATUS_WORD, type OverallStatus } from './systemHealthModel';

/**
 * The System health panel's overall verdict, shared with the Admin console's
 * tab strip so the System health tab can say "Problem" from whichever tab is
 * open. The panel publishes; the tab reads.
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

/** The status in words, so the marker never depends on its colour. */
export function navHealthWord(status: NavHealthStatus): string {
  if (status === 'unchecked') return 'Checking';
  if (status === 'unavailable') return 'Unknown';
  return STATUS_WORD[status === 'ok' ? 'ok' : status];
}

/** A healthy system reads calm; anything that needs a look says so on the tab. */
export function showsNavHealthWord(status: NavHealthStatus): boolean {
  return status === 'warn' || status === 'fail' || status === 'unavailable';
}
