import { describe, it, expect } from 'vitest';
import {
  STATUS_WORD, countByStatus, healthyToggleLabel, overallHeadline, splitChecks,
  type HealthCheckView, type HealthReportView,
} from '../src/components/systemHealthModel';

/**
 * The panel's wording and order. A healthy system must read calm and a sick
 * one loud, and every state must be readable without its colour.
 */

function check(overrides: Partial<HealthCheckView> & Pick<HealthCheckView, 'id' | 'status'>): HealthCheckView {
  return { label: `Check ${overrides.id}`, summary: 'Summary.', ...overrides };
}

function report(checks: HealthCheckView[], status: HealthReportView['status'] = 'ok'): HealthReportView {
  return {
    status, checkedAt: '2026-09-17T09:00:00Z', commit: 'abc123', scope: 'operator',
    sections: [{ id: 's', title: 'Section', checks }],
  };
}

describe('the headline', () => {
  it('says all is well when nothing is wrong', () => {
    expect(overallHeadline(report([check({ id: 'a', status: 'ok' }), check({ id: 'b', status: 'info' })]))).toBe('All systems healthy');
  });

  it('counts a single warning in the singular', () => {
    expect(overallHeadline(report([check({ id: 'a', status: 'warn' })], 'warn'))).toBe('1 warning');
  });

  it('counts several warnings', () => {
    expect(overallHeadline(report([check({ id: 'a', status: 'warn' }), check({ id: 'b', status: 'warn' })], 'warn'))).toBe('2 warnings');
  });

  it('counts a single problem in the singular', () => {
    expect(overallHeadline(report([check({ id: 'a', status: 'fail' })], 'fail'))).toBe('1 problem needs attention');
  });

  it('leads with problems even when warnings outnumber them', () => {
    const checks = [check({ id: 'a', status: 'warn' }), check({ id: 'b', status: 'warn' }), check({ id: 'c', status: 'fail' })];

    expect(overallHeadline(report(checks, 'fail'))).toBe('1 problem needs attention');
  });

  it('says it is still checking before the first answer', () => {
    expect(overallHeadline(null)).toBe('Checking…');
  });
});

describe('counting', () => {
  it('counts each status across every section', () => {
    const counts = countByStatus(report([
      check({ id: 'a', status: 'ok' }), check({ id: 'b', status: 'ok' }),
      check({ id: 'c', status: 'warn' }), check({ id: 'd', status: 'info' }), check({ id: 'e', status: 'fail' }),
    ]));

    expect(counts).toEqual({ ok: 2, warn: 1, info: 1, fail: 1 });
  });
});

describe('the order checks are shown in', () => {
  const mixed = [
    check({ id: 'ok1', status: 'ok' }), check({ id: 'note', status: 'info' }),
    check({ id: 'warn1', status: 'warn' }), check({ id: 'fail1', status: 'fail' }),
  ];

  it('puts problems first, then warnings, then notes', () => {
    expect(splitChecks(mixed).shown.map((c) => c.id)).toEqual(['fail1', 'warn1', 'note']);
  });

  it('holds healthy checks back', () => {
    expect(splitChecks(mixed).healthy.map((c) => c.id)).toEqual(['ok1']);
  });

  it('shows nothing up front when everything is healthy', () => {
    expect(splitChecks([check({ id: 'a', status: 'ok' })]).shown).toEqual([]);
  });
});

describe('the healthy toggle', () => {
  it('names one healthy check in the singular', () => {
    expect(healthyToggleLabel(1)).toBe('Show 1 healthy check');
  });

  it('counts several', () => {
    expect(healthyToggleLabel(4)).toBe('Show 4 healthy checks');
  });
});

describe('reading a status without colour', () => {
  it('gives every status its own word', () => {
    expect(Object.values(STATUS_WORD)).toEqual(['Problem', 'Watch', 'Healthy', 'Note']);
  });
});
