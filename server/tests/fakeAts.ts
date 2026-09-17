import { vi } from 'vitest';

/**
 * A pretend ATS for every host a test names, behind a mocked fetch. Nothing
 * leaves the machine. Each host holds its own requisitions and candidates, so
 * a test can prove which organisation's ATS a call went to.
 */

export interface FakeAtsHost {
  readonly requisitions?: Record<string, { title: string; description: string }>;
  readonly candidates?: Record<string, { fullName?: string; email?: string; phone?: string }>;
  /** Every call answers with this status (a rejected key, an outage). */
  readonly failWith?: number;
}

export interface RecordedCall {
  readonly url: URL;
  readonly method: string;
  readonly authorization: string;
  readonly body: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function installFakeAts(hosts: Record<string, FakeAtsHost>) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init.method ?? 'GET', authorization: headers.authorization ?? '', body: String(init.body ?? '') });
    const host = hosts[url.host];
    if (!host) throw new TypeError('fetch failed');
    if (host.failWith) return json(host.failWith, { error: 'nope' });
    const parts = url.pathname.split('/').filter(Boolean).slice(-3);
    if (parts.at(-1) === 'requisitions') return json(200, { requisitions: [] });
    if (parts.at(-2) === 'requisitions') {
      const found = host.requisitions?.[decodeURIComponent(parts.at(-1) ?? '')];
      return found ? json(200, found) : json(404, { error: 'not found' });
    }
    if (parts.at(-1) === 'assessments' && parts.at(-3) === 'candidates') {
      return host.candidates?.[decodeURIComponent(parts[1])] ? json(201, { ok: true }) : json(404, {});
    }
    if (parts.at(-2) === 'candidates') {
      const found = host.candidates?.[decodeURIComponent(parts.at(-1) ?? '')];
      return found ? json(200, found) : json(404, { error: 'not found' });
    }
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    fetchMock,
    hostsCalled: () => [...new Set(calls.map((c) => c.url.host))],
  };
}
