import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api/client';

/**
 * The download path is the one call whose body is never JSON, so it is also the
 * one that can quietly hand someone a "file" containing the word "Forbidden".
 * These cases pin the two halves of that: a refusal stays an ApiError and saves
 * nothing, and a real answer is saved under the name the server chose.
 */

interface FakeAnchor { href: string; download: string; clicks: number; removed: boolean }

const anchors: FakeAnchor[] = [];

function stubDom(): void {
  anchors.length = 0;
  vi.stubGlobal('document', {
    createElement: () => {
      const anchor: FakeAnchor & { click: () => void; remove: () => void } = {
        href: '', download: '', clicks: 0, removed: false,
        click() { this.clicks += 1; },
        remove() { this.removed = true; },
      };
      anchors.push(anchor);
      return anchor;
    },
    body: { appendChild: () => undefined },
  });
}

function answer(body: string, init: { status?: number; disposition?: string }): Response {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    statusText: 'OK',
    headers: { get: (name: string) => (name === 'Content-Disposition' ? init.disposition ?? null : null) },
    blob: async () => new Blob([body], { type: 'application/pdf' }),
    text: async () => body,
  } as unknown as Response;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('downloading a generated file', () => {
  it('saves it under the name the server chose', async () => {
    stubDom();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer('%PDF-1.3', { disposition: 'attachment; filename="Data-Engineer-scorecard-v2.pdf"' })));

    await api.download('/roles/r1/export.pdf', 'fallback.pdf');

    expect(anchors[0]?.download).toBe('Data-Engineer-scorecard-v2.pdf');
  });

  it('falls back to the caller\'s name when the server named nothing', async () => {
    stubDom();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer('%PDF-1.3', {})));

    await api.download('/roles/r1/export.pdf', 'fallback.pdf');

    expect(anchors[0]?.download).toBe('fallback.pdf');
  });

  it('clicks the link exactly once', async () => {
    stubDom();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer('%PDF-1.3', {})));

    await api.download('/roles/r1/export.pdf', 'fallback.pdf');

    expect(anchors[0]?.clicks).toBe(1);
  });

  it('raises the server\'s refusal instead of saving it', async () => {
    stubDom();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer(JSON.stringify({ error: 'Only an approved scorecard can be exported.', code: 'scorecard_not_approved' }), { status: 409 })));

    const err = await api.download('/roles/r1/export.pdf', 'fallback.pdf').then(() => null, (e: unknown) => e);

    expect([err instanceof ApiError, (err as ApiError).status, (err as ApiError).code, anchors.length])
      .toEqual([true, 409, 'scorecard_not_approved', 0]);
  });

  it('sends no CSRF header, because a GET changes nothing', async () => {
    stubDom();
    const fetchMock = vi.fn().mockResolvedValue(answer('%PDF-1.3', {}));
    vi.stubGlobal('fetch', fetchMock);

    await api.download('/roles/r1/export.pdf', 'fallback.pdf');

    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty('headers');
  });
});
