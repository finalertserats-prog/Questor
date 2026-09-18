import { useEffect, useSyncExternalStore } from 'react';
import { api } from '../api/client';
import {
  claimHealth, healthOwner, isStale, publishHealth, readHealth, subscribeHealth, verdictFor, type NavHealth,
} from './healthStatusStore';
import type { HealthReportView } from './systemHealthModel';

// The report runs database queries, so the sidebar asks far less often than
// the open System health tab does (every minute). When that tab has answered
// recently, the sidebar reuses its answer instead of asking again.
const SIDEBAR_REFRESH_MS = 5 * 60_000;

async function checkHealth(owner: string): Promise<void> {
  let next: NavHealth;
  try {
    const report = await api.get<HealthReportView>('/admin/health');
    next = { status: report.status, checkedAt: Date.now() };
  } catch {
    // The marker says "Unknown" rather than keeping an old green: a check that
    // could not run is not a healthy system.
    next = { status: 'unavailable', checkedAt: Date.now() };
  }
  // A sign-out while the check was in flight: the answer belongs to nobody now.
  if (healthOwner() === owner) publishHealth(next);
}

/** The overall verdict for the sidebar; only polls for an admin (`userId` set). */
export function useNavHealth(userId: string | null): NavHealth {
  const health = useSyncExternalStore(subscribeHealth, readHealth, readHealth);

  useEffect(() => {
    claimHealth(userId);
    if (!userId) return undefined;
    const checkIfStale = () => {
      if (!document.hidden && isStale(readHealth(), Date.now(), SIDEBAR_REFRESH_MS)) void checkHealth(userId);
    };
    checkIfStale();
    const timer = setInterval(checkIfStale, SIDEBAR_REFRESH_MS);
    document.addEventListener('visibilitychange', checkIfStale);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', checkIfStale);
    };
  }, [userId]);

  return verdictFor(health, userId);
}
