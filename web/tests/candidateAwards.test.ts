// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { awardRows, type AwardResponseRow } from '../src/components/candidateAwardsModel';

/**
 * The journey, one row per tier.
 *
 * The case this file exists for: a candidate whose Silver interview is
 * finished but who has NOT been progressed has no Silver badge, no
 * certificate and no export — only the reason it is not there yet. It reads
 * like an oversight, it is the rule, and a developer removes it by accident.
 */

const server = vi.hoisted(() => ({ downloads: [] as string[], fails: false }));

class FakeApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

vi.mock('../src/api/client', () => ({
  api: {
    download: (path: string) => {
      server.downloads.push(path);
      return server.fails ? Promise.reject(new FakeApiError(404, 'That certificate is not ready.')) : Promise.resolve();
    },
  },
  ApiError: FakeApiError,
}));

const { CandidateAwards } = await import('../src/components/CandidateAwards');

const EARNED_SILVER: AwardResponseRow = {
  tier: 'silver', label: 'Silver', earned: true,
  awardedAt: '2026-09-24T09:00:00.000Z', reference: 'QS-SLV-8F2K-4471',
  awardedBy: 'Rahul Menon', humanAssessed: true,
  headline: 'Progressed to Gold by Rahul Menon', hasCertificate: true,
  exports: {
    badgeSvg: '/api/candidates/c1/awards/silver/badge.svg',
    badgePng: '/api/candidates/c1/awards/silver/badge.png',
    certificatePdf: '/api/candidates/c1/awards/silver/certificate.pdf',
  },
};

const EARNED_BRONZE: AwardResponseRow = {
  tier: 'bronze', label: 'Bronze', earned: true,
  awardedAt: '2026-09-21T09:00:00.000Z', reference: 'QS-BRZ-2D9P-1183',
  awardedBy: null, humanAssessed: false,
  headline: 'CV read against the approved scorecard, version 4', hasCertificate: true,
  exports: {
    badgeSvg: '/api/candidates/c1/awards/bronze/badge.svg',
    badgePng: '/api/candidates/c1/awards/bronze/badge.png',
    certificatePdf: '/api/candidates/c1/awards/bronze/certificate.pdf',
  },
};

const EARNED_DIAMOND: AwardResponseRow = {
  tier: 'diamond', label: 'Diamond', earned: true,
  awardedAt: '2026-10-03T09:00:00.000Z', reference: 'QS-DIA-5J3T-2290',
  awardedBy: 'Rahul Menon', humanAssessed: true,
  headline: 'The hiring team decided: ready to join', hasCertificate: false,
  exports: {
    badgeSvg: '/api/candidates/c1/awards/diamond/badge.svg',
    badgePng: '/api/candidates/c1/awards/diamond/badge.png',
    certificatePdf: null,
  },
};

const PENDING_SILVER: AwardResponseRow = {
  tier: 'silver', label: 'Silver', earned: false, reason: 'Awarded when they move to Gold',
};

const show = (awards: readonly AwardResponseRow[]) =>
  render(createElement(CandidateAwards, { awards, candidateName: 'Mei Lin Chua' }));

beforeEach(() => { server.downloads = []; server.fails = false; });
afterEach(cleanup);

describe('a tier that has not been earned', () => {
  it('shows the reason it is not there yet', () => {
    show([EARNED_BRONZE, PENDING_SILVER]);
    expect(screen.getByText('Awarded when they move to Gold')).toBeTruthy();
  });

  it('offers no buttons at all — there is no file to export', () => {
    show([PENDING_SILVER]);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows a dashed placeholder rather than a faded badge', () => {
    const { container } = show([PENDING_SILVER]);
    expect(container.querySelector('.award-placeholder')).toBeTruthy();
    expect(container.querySelector('.award-row-pending .tier-badge')).toBeNull();
  });

  it('shows no date, because nothing happened', () => {
    const { container } = show([PENDING_SILVER]);
    expect(container.querySelector('.award-when')?.textContent).toBe('—');
  });

  it('carries no reference a reader could quote', () => {
    const { container } = show([PENDING_SILVER]);
    expect(container.textContent).not.toContain('QS-');
  });
});

describe('a tier that has been earned', () => {
  it('shows its badge, what happened and when', () => {
    const { container } = show([EARNED_SILVER]);
    expect(container.querySelector('.tier-badge')).toBeTruthy();
    expect(container.textContent).toContain('Progressed to Gold by Rahul Menon');
    expect(container.querySelector('.award-when')?.textContent).not.toBe('—');
  });

  it('offers both a badge and a certificate', () => {
    show([EARNED_SILVER]);
    expect(screen.getByRole('button', { name: 'Badge' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Certificate' })).toBeTruthy();
  });

  // Diamond records what an employer decided, which is theirs to announce.
  it('offers Diamond a badge and no certificate', () => {
    show([EARNED_DIAMOND]);
    expect(screen.getByRole('button', { name: 'Badge' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Certificate' })).toBeNull();
  });

  // Bronze is held by the hiring team and never issued to the candidate, and
  // the watermark that says so disappears in a black-and-white print.
  it('marks Bronze as internal in words', () => {
    const { container } = show([EARNED_BRONZE]);
    expect(container.textContent).toContain('internal');
  });

  it('asks the server for the agreed path, with the /api prefix stripped once', async () => {
    show([EARNED_SILVER]);
    screen.getByRole('button', { name: 'Certificate' }).click();
    await waitFor(() => expect(server.downloads).toEqual(['/candidates/c1/awards/silver/certificate.pdf']));
  });

  it('names the failure rather than leaving a button that does nothing', async () => {
    server.fails = true;
    show([EARNED_SILVER]);
    screen.getByRole('button', { name: 'Badge' }).click();
    expect((await screen.findByRole('alert')).textContent).toContain('not ready');
  });
});

describe('the panel as a whole', () => {
  it('shows the tiers in ladder order however the server sent them', () => {
    const { container } = show([EARNED_DIAMOND, EARNED_BRONZE, EARNED_SILVER]);
    const labels = [...container.querySelectorAll('.award-what')].map((node) => node.textContent ?? '');
    expect(labels.map((text) => text.split(' ')[0])).toEqual(['Bronze', 'Silver', 'Diamond']);
  });

  it('says plainly that nothing is earned yet rather than showing an empty list', () => {
    const { container } = show([]);
    expect(container.textContent).toContain('Nothing has been earned yet');
    expect(container.querySelector('.award-rows')).toBeNull();
  });
});

describe('the row view model', () => {
  it('gives an unearned tier no export path at all', () => {
    const [row] = awardRows([PENDING_SILVER], 'Mei Lin Chua');
    expect(row.badgePath).toBeNull();
    expect(row.certificatePath).toBeNull();
    expect(row.reference).toBe('');
  });

  it('strips the /api prefix exactly once', () => {
    const [row] = awardRows([EARNED_SILVER], 'Mei Lin Chua');
    expect(row.badgePath).toBe('/candidates/c1/awards/silver/badge.svg');
  });

  it('names the saved file after the candidate and the tier', () => {
    const [row] = awardRows([EARNED_SILVER], 'Mei Lin Chua');
    expect(row.fileStem).toBe('mei-lin-chua-silver');
  });

  it('falls back to a usable filename when the name is nothing it can use', () => {
    const [row] = awardRows([EARNED_SILVER], '   ');
    expect(row.fileStem).toBe('candidate-silver');
  });
});
