// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AwardResponseRow } from '../src/components/candidateAwardsModel';

/**
 * The credential viewer.
 *
 * Pressing Badge or Certificate on the journey opens the credential inside
 * the app — the badge the server drew, the certificate the server laid out —
 * and everything a person might then do with it is inside that dialog:
 * download it, copy the public verification link, or (an admin, a Silver or
 * a Gold, once) send it to the candidate.
 *
 * The file this replaces saved the bytes straight to disk. On Windows an
 * `.svg` is labelled "Microsoft Edge HTML Document", which is how a badge
 * download came to be reported as "an HTML file".
 */

const server = vi.hoisted(() => ({
  fetched: [] as string[],
  saved: [] as string[],
  gets: [] as string[],
  posts: [] as string[],
  fetchFails: false,
  /** The server never answers: what the dialog shows while it waits. */
  fetchHangs: false,
  /** The server answers 200 with a page instead of the file. */
  fetchAnswersHtml: false,
  sendFails: false,
  /** The send is answered only when the test says so. */
  sendHangs: false,
  releaseSend: () => undefined as void,
}));

const session = vi.hoisted(() => ({ capabilities: ['candidate:read'] as string[] }));

class FakeApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code; }
}

vi.mock('../src/api/client', () => ({
  api: {
    fetchFile: (path: string) => {
      server.fetched.push(path);
      if (server.fetchHangs) return new Promise(() => undefined);
      if (server.fetchFails) return Promise.reject(new FakeApiError(503, 'This certificate is not ready yet.'));
      if (server.fetchAnswersHtml) {
        return Promise.resolve({ blob: new Blob(['<html><script>1</script></html>'], { type: 'text/html' }), filename: null });
      }
      const pdf = path.endsWith('.pdf');
      return Promise.resolve({
        blob: new Blob([pdf ? '%PDF-1.4' : '<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: pdf ? 'application/pdf' : 'image/svg+xml' }),
        filename: pdf ? 'questor-silver-QS-SLV-8F2K-4471.pdf' : 'questor-silver-QS-SLV-8F2K-4471.svg',
      });
    },
    saveFile: (_blob: Blob, filename: string) => { server.saved.push(filename); },
    get: (path: string) => {
      server.gets.push(path);
      return Promise.resolve({ verifyUrl: 'https://questor.app/v/tok-123', reference: 'QS-SLV-8F2K-4471' });
    },
    post: (path: string) => {
      server.posts.push(path);
      if (server.sendFails) return Promise.reject(new FakeApiError(409, 'This certificate has already been sent to the candidate.', 'already_sent'));
      const answer = { sentToCandidateAt: '2026-09-27T10:00:00.000Z', delivered: true };
      if (server.sendHangs) return new Promise((resolve) => { server.releaseSend = () => resolve(answer); });
      return Promise.resolve(answer);
    },
  },
  ApiError: FakeApiError,
}));

vi.mock('../src/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', capabilities: session.capabilities } }),
}));

const { CandidateAwards } = await import('../src/components/CandidateAwards');

const SILVER: AwardResponseRow = {
  tier: 'silver', label: 'Silver', earned: true,
  awardedAt: '2026-09-24T09:00:00.000Z', reference: 'QS-SLV-8F2K-4471',
  awardedBy: 'Rahul Menon', humanAssessed: true,
  headline: 'Progressed to Gold by Rahul Menon', hasCertificate: true,
  sentToCandidateAt: null,
  exports: {
    badgeSvg: '/api/candidates/c1/awards/silver/badge.svg',
    badgePng: '/api/candidates/c1/awards/silver/badge.png',
    certificatePdf: '/api/candidates/c1/awards/silver/certificate.pdf',
    verifyLink: '/api/candidates/c1/awards/silver/verify-link',
    certificateSend: '/api/candidates/c1/awards/silver/certificate/send',
  },
};

const BRONZE: AwardResponseRow = {
  tier: 'bronze', label: 'Bronze', earned: true,
  awardedAt: '2026-09-21T09:00:00.000Z', reference: 'QS-BRZ-2D9P-1183',
  awardedBy: null, humanAssessed: false,
  headline: 'CV read against the approved scorecard, version 4', hasCertificate: true,
  sentToCandidateAt: null,
  exports: {
    badgeSvg: '/api/candidates/c1/awards/bronze/badge.svg',
    badgePng: '/api/candidates/c1/awards/bronze/badge.png',
    certificatePdf: '/api/candidates/c1/awards/bronze/certificate.pdf',
    verifyLink: '/api/candidates/c1/awards/bronze/verify-link',
    certificateSend: null,
  },
};

const DIAMOND: AwardResponseRow = {
  tier: 'diamond', label: 'Diamond', earned: true,
  awardedAt: '2026-10-03T09:00:00.000Z', reference: 'QS-DIA-5J3T-2290',
  awardedBy: 'Rahul Menon', humanAssessed: true,
  headline: 'The hiring team decided: ready to join', hasCertificate: false,
  sentToCandidateAt: null,
  exports: {
    badgeSvg: '/api/candidates/c1/awards/diamond/badge.svg',
    badgePng: '/api/candidates/c1/awards/diamond/badge.png',
    certificatePdf: null,
    verifyLink: null,
    certificateSend: null,
  },
};

const show = (awards: readonly AwardResponseRow[]) =>
  render(createElement(CandidateAwards, { awards, candidateName: 'Mei Lin Chua' }));

const clipboard = vi.hoisted(() => ({ written: [] as string[], refuses: false }));

let objectUrls = 0;
const revoked: string[] = [];

beforeEach(() => {
  server.fetched = []; server.saved = []; server.gets = []; server.posts = [];
  server.fetchFails = false; server.fetchHangs = false; server.fetchAnswersHtml = false;
  server.sendFails = false; server.sendHangs = false;
  session.capabilities = ['candidate:read'];
  clipboard.written = []; clipboard.refuses = false;
  objectUrls = 0; revoked.length = 0;
  // jsdom has neither object URLs nor a modal dialog nor a clipboard; the
  // component is what is under test, not the platform.
  URL.createObjectURL = vi.fn(() => `blob:questor/${++objectUrls}`);
  URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  // `close` arrives as a queued task in every browser, never synchronously;
  // a polyfill that dispatched it at once hid a bug the browser showed.
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    setTimeout(() => this.dispatchEvent(new Event('close')), 0);
  };
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        if (clipboard.refuses) return Promise.reject(new Error('NotAllowedError'));
        clipboard.written.push(text);
        return Promise.resolve();
      },
    },
  });
});
afterEach(cleanup);

async function open(name: 'Badge' | 'Certificate') {
  const trigger = screen.getByRole('button', { name });
  trigger.focus();
  fireEvent.click(trigger);
  return { trigger, dialog: await screen.findByRole('dialog') };
}

describe('pressing Badge', () => {
  it('opens the badge inside the app rather than saving a file', async () => {
    show([SILVER]);

    await open('Badge');

    expect(server.saved).toEqual([]);
  });

  it('asks the server for the agreed path, with the /api prefix stripped once', async () => {
    show([SILVER]);

    await open('Badge');

    await waitFor(() => expect(server.fetched).toEqual(['/candidates/c1/awards/silver/badge.svg']));
  });

  it('shows the badge the server drew, not a second drawing of it', async () => {
    show([SILVER]);

    const { dialog } = await open('Badge');

    const image = await within(dialog).findByRole('img', { name: 'Silver badge' });
    expect(image.getAttribute('src')).toBe('blob:questor/1');
  });

  // The app renders under StrictMode, which in development mounts, cleans
  // up and mounts every effect again. A cleanup that closed the dialog and
  // reported that close to the parent had the viewer vanish the instant it
  // opened — in the browser, and in no test that rendered without it.
  it('stays open under StrictMode, whose double mount must not read as the browser closing it', async () => {
    render(createElement(StrictMode, null, createElement(CandidateAwards, { awards: [SILVER], candidateName: 'Mei Lin Chua' })));

    const { dialog } = await open('Badge');
    await within(dialog).findByRole('img', { name: 'Silver badge' });
    // The stale close is a queued task; let it run before looking.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('is named after the credential, so a screen reader says what opened', async () => {
    show([SILVER]);

    const { dialog } = await open('Badge');

    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(within(dialog).getByRole('heading').textContent).toContain('Silver badge');
  });
});

describe('pressing Certificate', () => {
  it('shows the certificate itself', async () => {
    show([SILVER]);

    const { dialog } = await open('Certificate');

    const sheet = await waitFor(() => {
      const found = dialog.querySelector('object[type="application/pdf"]');
      if (!found) throw new Error('no certificate yet');
      return found;
    });
    expect(sheet.getAttribute('data')).toBe('blob:questor/1#toolbar=0&navpanes=0&view=FitH');
  });

  it('offers to open the sheet on its own, for a browser that cannot show a PDF here', async () => {
    show([SILVER]);

    const { dialog } = await open('Certificate');

    const tab = await within(dialog).findByRole('link', { name: 'Open in a new tab' });
    expect([tab.getAttribute('href'), tab.getAttribute('target')]).toEqual(['blob:questor/1', '_blank']);
  });

  it('says what is being fetched while the sheet is on its way', async () => {
    server.fetchHangs = true;
    show([SILVER]);

    const { dialog } = await open('Certificate');

    expect(dialog.textContent).toContain('Preparing');
  });
});

describe('inside the dialog', () => {
  it('Download saves the bytes that were shown, under the name the server gave', async () => {
    show([SILVER]);
    const { dialog } = await open('Badge');

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Download' }));

    expect(server.saved).toEqual(['questor-silver-QS-SLV-8F2K-4471.svg']);
    expect(server.fetched).toHaveLength(1);
  });

  it('Copy link asks the server for the verification link and puts it on the clipboard', async () => {
    show([SILVER]);
    const { dialog } = await open('Badge');

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Copy verification link' }));

    await waitFor(() => expect(clipboard.written).toEqual(['https://questor.app/v/tok-123']));
    expect(server.gets).toEqual(['/candidates/c1/awards/silver/verify-link']);
  });

  it('announces that the link was copied', async () => {
    show([SILVER]);
    const { dialog } = await open('Badge');

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Copy verification link' }));

    const status = await within(dialog).findByRole('status');
    await waitFor(() => expect(status.textContent).toContain('copied'));
  });

  it('shows the link to copy by hand when the clipboard refuses', async () => {
    clipboard.refuses = true;
    show([SILVER]);
    const { dialog } = await open('Badge');

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Copy verification link' }));

    const field = await within(dialog).findByRole('textbox', { name: 'Verification link' });
    expect((field as HTMLInputElement).value).toBe('https://questor.app/v/tok-123');
  });

  it('offers no verification link for Diamond, which has no public page', async () => {
    show([DIAMOND]);
    const { dialog } = await open('Badge');

    await within(dialog).findByRole('button', { name: 'Download' });

    expect(within(dialog).queryByRole('button', { name: 'Copy verification link' })).toBeNull();
  });

  it('Escape closes it and hands focus back to the button that opened it', async () => {
    show([SILVER]);
    const { trigger, dialog } = await open('Badge');

    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('the Close button closes it', async () => {
    show([SILVER]);
    const { dialog } = await open('Badge');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('releases the object URL when it closes, so the document does not live on in memory', async () => {
    show([SILVER]);
    const { dialog } = await open('Badge');
    await within(dialog).findByRole('img', { name: 'Silver badge' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(revoked).toEqual(['blob:questor/1']));
  });

  it('names a failure to fetch rather than showing an empty frame', async () => {
    server.fetchFails = true;
    show([SILVER]);
    const { dialog } = await open('Certificate');

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('not ready');
  });

  // A blob URL carries this page's origin; a page handed to <object> would
  // run as this page. Only the file asked for is ever shown.
  it('refuses to show a 200 that is not the certificate', async () => {
    server.fetchAnswersHtml = true;
    show([SILVER]);
    const { dialog } = await open('Certificate');

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('something other than a certificate');
    expect(dialog.querySelector('object')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('closes when the browser closes it, so the journey does not believe it is still open', async () => {
    show([SILVER]);
    const { dialog } = await open('Badge');

    (dialog as HTMLDialogElement).close();

    // Unmounted, not merely no longer open: a closed <dialog> left in the
    // tree would still be reported as absent by a role query.
    await waitFor(() => expect(document.querySelector('dialog')).toBeNull());
  });
});

describe('sending to the candidate', () => {
  it('is offered to an admin on a Silver certificate', async () => {
    session.capabilities = ['candidate:read', 'admin:manage'];
    show([SILVER]);
    const { dialog } = await open('Certificate');

    expect(await within(dialog).findByRole('button', { name: 'Send to candidate' })).toBeTruthy();
  });

  it('is not offered on the badge — it is the certificate that is sent', async () => {
    session.capabilities = ['candidate:read', 'admin:manage'];
    show([SILVER]);
    const { dialog } = await open('Badge');
    await within(dialog).findByRole('button', { name: 'Download' });

    expect(within(dialog).queryByRole('button', { name: 'Send to candidate' })).toBeNull();
  });

  it('is not offered to someone who may not administer the organisation', async () => {
    show([SILVER]);
    const { dialog } = await open('Certificate');
    await within(dialog).findByRole('button', { name: 'Download' });

    expect(within(dialog).queryByRole('button', { name: 'Send to candidate' })).toBeNull();
  });

  it('is never offered for Bronze, and the dialog says why', async () => {
    session.capabilities = ['candidate:read', 'admin:manage'];
    show([BRONZE]);
    const { dialog } = await open('Certificate');
    await within(dialog).findByRole('button', { name: 'Download' });

    expect(within(dialog).queryByRole('button', { name: 'Send to candidate' })).toBeNull();
    expect(dialog.textContent).toContain('held by the hiring team');
  });

  it('is not offered until the certificate is on screen', async () => {
    session.capabilities = ['candidate:read', 'admin:manage'];
    server.fetchHangs = true;
    show([SILVER]);
    const { dialog } = await open('Certificate');
    expect(dialog.textContent).toContain('Preparing');

    expect(within(dialog).queryByRole('button', { name: 'Send to candidate' })).toBeNull();
  });

  it('is not offered when the certificate could not be shown — nobody has seen it', async () => {
    session.capabilities = ['candidate:read', 'admin:manage'];
    server.fetchFails = true;
    show([SILVER]);
    const { dialog } = await open('Certificate');
    await within(dialog).findByRole('alert');

    expect(within(dialog).queryByRole('button', { name: 'Send to candidate' })).toBeNull();
  });

  it('asks before anything is emailed, naming the candidate, with focus on the answer', async () => {
    session.capabilities = ['candidate:read', 'admin:manage'];
    show([SILVER]);
    const { dialog } = await open('Certificate');

    fireEvent.click(await within(dialog).findByRole('button', { name: 'Send to candidate' }));

    expect(server.posts).toEqual([]);
    expect(dialog.textContent).toContain('Mei Lin Chua');
    const yes = within(dialog).getByRole('button', { name: 'Yes, send it' });
    await waitFor(() => expect(document.activeElement).toBe(yes));
  });

  it('still tells the row when the dialog was closed before the send was answered', async () => {
    session.capabilities = ['candidate:read', 'admin:manage'];
    server.sendHangs = true;
    const { container } = show([SILVER]);
    const { dialog } = await open('Certificate');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Send to candidate' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, send it' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    server.releaseSend();

    await waitFor(() => expect(container.querySelector('.award-row')?.textContent).toContain('sent to candidate'));
  });

  it('sends only once confirmed, to the agreed path', async () => {
    session.capabilities = ['candidate:read', 'admin:manage'];
    show([SILVER]);
    const { dialog } = await open('Certificate');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Send to candidate' }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, send it' }));

    await waitFor(() => expect(server.posts).toEqual(['/candidates/c1/awards/silver/certificate/send']));
  });

  it('says when it went, and offers no second send', async () => {
    session.capabilities = ['candidate:read', 'admin:manage'];
    show([SILVER]);
    const { dialog } = await open('Certificate');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Send to candidate' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, send it' }));

    await waitFor(() => expect(dialog.textContent).toContain('Sent to the candidate'));
    expect(within(dialog).queryByRole('button', { name: 'Send to candidate' })).toBeNull();
  });

  it('tells the row, so the journey says it has been sent once the dialog closes', async () => {
    session.capabilities = ['candidate:read', 'admin:manage'];
    const { container } = show([SILVER]);
    const { dialog } = await open('Certificate');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Send to candidate' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, send it' }));
    await waitFor(() => expect(dialog.textContent).toContain('Sent to the candidate'));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(container.querySelector('.award-row')?.textContent).toContain('sent to candidate');
  });

  it('shows a certificate already sent as sent, with no button', async () => {
    session.capabilities = ['candidate:read', 'admin:manage'];
    show([{ ...SILVER, sentToCandidateAt: '2026-09-25T10:00:00.000Z' }]);
    const { dialog } = await open('Certificate');
    await within(dialog).findByRole('button', { name: 'Download' });

    expect(dialog.textContent).toContain('Sent to the candidate');
    expect(within(dialog).queryByRole('button', { name: 'Send to candidate' })).toBeNull();
  });

  it('names the refusal rather than leaving the button pressed', async () => {
    session.capabilities = ['candidate:read', 'admin:manage'];
    server.sendFails = true;
    show([SILVER]);
    const { dialog } = await open('Certificate');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Send to candidate' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, send it' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('already been sent');
  });
});
