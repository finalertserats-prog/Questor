import { logger } from '../logger.js';
import { platformSection, backupsSection } from './systemHealthPlatform.js';
import { jobsSection } from './systemHealthJobs.js';
import { deliverySection, accountsSection } from './systemHealthDelivery.js';
import { tenantSection } from './systemHealthTenant.js';
import {
  defaultHealthDeps,
  type CheckDef, type CheckStatus, type HealthCheck, type HealthDeps, type HealthReport,
  type HealthSection, type OverallStatus, type SectionDef,
} from './systemHealthTypes.js';

/**
 * "Is Questor healthy?", answered in one request for the Admin console.
 *
 * Scope is the security boundary. The deployment's own state (disk, backups,
 * jobs, provider configuration) belongs to the operator, the same person the
 * signup queue belongs to. Every other admin sees only checks about their own
 * organisation. Neither ever sees a setting's value, an internal address or an
 * error's stack: checks write their own words.
 *
 * Checks run in parallel, each under its own deadline, so one hung dependency
 * shows as one failed check instead of a page that never loads.
 */

export interface HealthScope {
  readonly operator: boolean;
  readonly tenantId: string;
}

const OPERATOR_SECTIONS: readonly SectionDef[] = [platformSection, backupsSection, jobsSection, deliverySection, accountsSection];

const RANK: Readonly<Record<CheckStatus, number>> = { info: 0, ok: 0, warn: 1, fail: 2 };

/** The worst non-info status; a report of nothing but facts is healthy. */
export function rollupStatus(checks: readonly Pick<HealthCheck, 'status'>[]): OverallStatus {
  const worst = checks.reduce((max, c) => Math.max(max, RANK[c.status]), 0);
  return worst === 2 ? 'fail' : worst === 1 ? 'warn' : 'ok';
}

class CheckTimeout extends Error {}

export async function runCheck(def: CheckDef, deps: HealthDeps, tenantId: string): Promise<HealthCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CheckTimeout()), deps.timeoutMs);
  });
  try {
    const outcome = await Promise.race([def.run({ deps, tenantId }), deadline]);
    return { id: def.id, label: def.label, ...outcome };
  } catch (err) {
    const timedOut = err instanceof CheckTimeout;
    // The reason stays in the server log; the page gets a plain sentence.
    logger.warn({ check: def.id, timedOut, err: err instanceof Error ? err.message : String(err) }, 'System health check could not complete');
    return {
      id: def.id, label: def.label, status: 'fail',
      summary: timedOut ? `Could not be checked: no answer within ${Math.round(deps.timeoutMs / 100) / 10} s.` : 'Could not be checked: the check itself failed.',
      action: 'Refresh in a minute. If it persists, read the server log for "System health check".',
    };
  } finally {
    clearTimeout(timer);
  }
}

export function sectionsFor(scope: HealthScope): readonly SectionDef[] {
  return scope.operator ? [...OPERATOR_SECTIONS, tenantSection] : [tenantSection];
}

export async function buildHealthReport(scope: HealthScope, deps: HealthDeps = defaultHealthDeps()): Promise<HealthReport> {
  const sections: HealthSection[] = await Promise.all(sectionsFor(scope).map(async (section) => ({
    id: section.id,
    title: section.title,
    checks: await Promise.all(section.checks.map((def) => runCheck(def, deps, scope.tenantId))),
  })));
  return {
    status: rollupStatus(sections.flatMap((s) => s.checks)),
    checkedAt: deps.now().toISOString(),
    commit: deps.commit(),
    scope: scope.operator ? 'operator' : 'tenant',
    sections,
  };
}

/** Long enough that a room full of open Admin tabs costs one run, short enough to feel live. */
export const HEALTH_CACHE_MS = 15_000;

const cache = new Map<string, { expiresAt: number; report: Promise<HealthReport> }>();
let depsOverride: HealthDeps | null = null;

/**
 * The cached report for a scope. The promise itself is cached, so requests
 * arriving while a run is in flight share it rather than starting their own.
 */
export function getSystemHealth(scope: HealthScope): Promise<HealthReport> {
  const deps = depsOverride ?? defaultHealthDeps();
  const now = deps.now().getTime();
  const key = `${scope.operator ? 'operator' : 'tenant'}:${scope.tenantId}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.report;
  for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
  const report = buildHealthReport(scope, deps);
  cache.set(key, { expiresAt: now + HEALTH_CACHE_MS, report });
  // A run that blew up must not be served for the next 15 seconds.
  report.catch(() => cache.delete(key));
  return report;
}

/** Test hook: replace the injected dependencies (null restores the real ones) and forget cached reports. */
export function _setSystemHealthDepsForTest(deps: HealthDeps | null): void {
  depsOverride = deps;
  cache.clear();
}
