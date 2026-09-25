// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * The verification page as it actually renders.
 *
 * It is the only Questor page an employer will ever judge the product by, and
 * the only one a candidate reaches without being invited to anything. What is
 * held to here is what a screenshot cannot prove: that the four facts the
 * owner chose are on the page, that nothing else about the assessment is, that
 * a link that does not resolve says nothing about whether it once did, and
 * that a page carrying a person's name tells a crawler to leave it alone.
 */

const server = vi.hoisted(() => ({
  record: null as unknown,
  error: null as null | { status: number },
  downloads: [] as string[],
  downloadFails: false,
}));

class FakeApiError extends Error {
  status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

vi.mock('../src/api/client', () => ({
  api: {
    get: () => (server.error ? Promise.reject(new FakeApiError(server.error.status)) : Promise.resolve(server.record)),
    download: (path: string) => {
      server.downloads.push(path);
      return server.downloadFails ? Promise.reject(new FakeApiError(429)) : Promise.resolve();
    },
  },
  ApiError: FakeApiError,
}));

const { Verify } = await import('../src/pages/Verify');

const TOKEN = 'a'.repeat(43);

function record(over: Record<string, unknown> = {}) {
  return {
    tier: 'silver',
    candidateName: 'Priya Sharma',
    roleTitle: 'Senior Marketing Manager',
    issuedAt: '2026-09-24T00:00:00.000Z',
    issuedOn: '24 September 2026',
    claim: { lead: 'Completed Questor’s ', tier: 'Silver', middle: ' assessment for ', role: 'Senior Marketing Manager' },
    footnote: '* Evidence of process, not a recommendation.',
    ...over,
  };
}

function show() {
  return render(createElement(
    MemoryRouter,
    { initialEntries: [`/v/${TOKEN}`] },
    createElement(Routes, null, createElement(Route, { path: '/v/:token', element: createElement(Verify) })),
  ));
}

beforeEach(() => {
  server.record = record();
  server.error = null;
  server.downloads = [];
  server.downloadFails = false;
  document.head.innerHTML = '';
});

afterEach(cleanup);

describe('the four facts an employer came for', () => {
  it('says plainly that Questor issued the certificate', async () => {
    show();

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toContain('Questor issued this certificate');
  });

  /**
   * The owner's reasoning for the name: an employer holding the link has to be
   * able to match the certificate to the person standing in front of them.
   * Without it the page verifies a document and identifies nobody.
   */
  it('names the candidate', async () => {
    show();

    expect(await screen.findByText('Priya Sharma')).toBeTruthy();
  });

  it('gives the tier, the role and the date it was issued', async () => {
    show();

    await screen.findByText('Priya Sharma');
    expect(screen.getByText(/Completed Questor’s/)).toBeTruthy();
    expect(screen.getAllByText(/Senior Marketing Manager/).length).toBeGreaterThan(0);
    expect(screen.getByText(/24 September 2026/)).toBeTruthy();
  });

  /**
   * The date is a machine-readable instant as well as a printed one, so that
   * the words on screen are the certificate's rendering of it and nothing has
   * to reformat a date the document already fixed.
   */
  it('marks the issue date up as a date', async () => {
    const { container } = show();

    await screen.findByText('Priya Sharma');
    expect(container.querySelector('time')?.getAttribute('dateTime') ?? container.querySelector('time')?.getAttribute('datetime'))
      .toBe('2026-09-24T00:00:00.000Z');
  });

  /**
   * The footnote is the sentence that stops an employer reading this as a
   * reference. It is on the paper and it has to be on the page.
   */
  it('carries the certificate’s own footnote', async () => {
    show();

    expect(await screen.findByText(/Evidence of process, not a recommendation/)).toBeTruthy();
  });

  it('puts the page inside a main landmark', async () => {
    show();

    await screen.findByText('Priya Sharma');
    expect(screen.getByRole('main')).toBeTruthy();
  });
});

describe('the download, with no account and no login', () => {
  it('offers the certificate and asks the public route for it', async () => {
    show();

    (await screen.findByRole('button', { name: /Download the certificate/ })).click();

    await waitFor(() => expect(server.downloads).toEqual([`/v/${TOKEN}/certificate.pdf`]));
  });

  it('says so when the file cannot be prepared, rather than doing nothing', async () => {
    server.downloadFails = true;
    show();

    (await screen.findByRole('button', { name: /Download the certificate/ })).click();

    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

describe('a link that does not resolve', () => {
  /**
   * An erased candidate's awards are deleted outright, so their token lands
   * here. The page must not say the record was withdrawn, revoked or removed:
   * each of those tells an employer that the person was assessed here, which
   * is the fact the erasure existed to remove.
   */
  it('says nothing about whether the record ever existed', async () => {
    server.error = { status: 404 };
    show();

    const heading = await screen.findByRole('heading', { level: 1 });
    expect(document.body.textContent?.toLowerCase()).not.toMatch(/withdrawn|revoked|no longer|deleted|removed/);
    expect(heading.textContent).toContain('can’t check this link');
  });

  it('offers no download when there is nothing to download', async () => {
    server.error = { status: 404 };
    show();

    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
  });

  it('asks a reader whose record is still being migrated to come back', async () => {
    server.error = { status: 503 };
    show();

    expect((await screen.findByRole('heading', { level: 1 })).textContent).toContain('isn’t ready yet');
  });
});

describe('a page with a person’s name on it', () => {
  /**
   * Three lines stand between this page and a search result: robots.txt, the
   * header the API sets, and this tag — which is the one a crawler that
   * executes the page reads. A person's name and the role they were assessed
   * for, indexed and searchable for ever, is not something a candidate agreed
   * to.
   */
  it('tells crawlers not to index it', async () => {
    show();

    await screen.findByText('Priya Sharma');
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toContain('noindex');
  });

  /**
   * The token is in the address bar. Any request the browser makes out of this
   * page would otherwise carry it in a Referer header, which hands the
   * verification record of a named person to whoever is on the other end.
   */
  it('lets the token travel nowhere in a referrer', async () => {
    show();

    await screen.findByText('Priya Sharma');
    expect(document.head.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
  });
});
