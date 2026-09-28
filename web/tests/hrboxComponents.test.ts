import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { NeedsYouQueue, NeedsYouSkeleton } from '../src/components/hrbox/NeedsYouQueue';
import { Crew } from '../src/components/hrbox/Crew';
import { NeedsYouBell } from '../src/components/hrbox/NeedsYouBell';
import type { NeedsYouRow } from '../src/components/hrbox/needsYouModel';

beforeAll(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined); });

const NOW = Date.parse('2026-09-22T06:30:00.000Z');
const inRouter = (el: ReactElement) => renderToStaticMarkup(createElement(MemoryRouter, null, el));

function row(overrides: Partial<NeedsYouRow> = {}): NeedsYouRow {
  return {
    id: 'review:s1', kind: 'review', urgent: false, since: new Date(NOW - 3 * 3_600_000).toISOString(),
    candidate: { id: 'c1', name: 'Arjun Mehta' }, role: { id: 'r1', title: 'Senior Backend Engineer' },
    subject: null, sessionId: 's1', assessmentId: 'a1', facts: {}, openedBy: [],
    action: { label: 'Review', to: '/assessments/a1' },
    ...overrides,
  };
}

describe('NeedsYouQueue', () => {
  it('draws an urgent row with the urgent rule', () => {
    const html = inRouter(createElement(NeedsYouQueue, { rows: [row({ kind: 'human_request', urgent: true })], now: NOW }));
    expect(html).toContain('class="hb-row hb-row--urgent"');
  });

  it('gives an urgent row the primary button', () => {
    const html = inRouter(createElement(NeedsYouQueue, { rows: [row({ kind: 'human_request', urgent: true, action: { label: 'Get in touch', to: '/candidates/c1' } })], now: NOW }));
    expect(html).toContain('class="btn sm" aria-label="Get in touch: Arjun Mehta" href="/candidates/c1"');
  });

  it('shows the initials of colleagues who opened it', () => {
    const html = inRouter(createElement(NeedsYouQueue, { rows: [row({ openedBy: [{ userId: 'u', name: 'Rahul Verma', initials: 'RV' }] })], now: NOW }));
    expect(html).toContain('<i>RV</i>');
  });

  it('offers no link for a row decided from an email', () => {
    const html = inRouter(createElement(NeedsYouQueue, {
      rows: [row({ kind: 'demo_request', candidate: null, role: null, subject: 'Asha · Acme', action: { label: 'Decide from the email', to: null } })], now: NOW,
    }));
    expect(html).not.toContain('class="btn');
  });

  it('staggers rows through a variable, not inline timing', () => {
    const html = inRouter(createElement(NeedsYouQueue, { rows: [row({ id: 'a' }), row({ id: 'b' })], now: NOW }));
    expect(html).toContain('style="--hb-i:1"');
  });
});

describe('NeedsYouSkeleton', () => {
  it('announces the wait once and hides the shapes', () => {
    const html = renderToStaticMarkup(createElement(NeedsYouSkeleton));
    expect([html.includes('role="status"'), html.includes('aria-hidden="true"')]).toEqual([true, true]);
  });
});

describe('Crew', () => {
  it('rings the interviewer who is live', () => {
    const html = renderToStaticMarkup(createElement(Crew, {
      crew: [{ id: 'maya', name: 'Maya', status: 'live', candidateFirstName: 'Priya', at: null }, { id: 'theo', name: 'Theo', status: 'idle', candidateFirstName: null, at: null }],
      timeZone: 'Asia/Kolkata',
    }));
    expect(html.match(/is-live/g)?.length).toBe(1);
  });
});

describe('NeedsYouBell', () => {
  it('opens Home and names the count', () => {
    const html = inRouter(createElement(NeedsYouBell, { total: 5 }));
    expect([html.includes('href="/?tab=home"'), html.includes('aria-label="5 things need you"')]).toEqual([true, true]);
  });

  it('draws the bell without the unread dot when nothing waits', () => {
    const quiet = inRouter(createElement(NeedsYouBell, { total: 0 }));
    expect(quiet).not.toContain('hb-bell-count');
  });
});
