import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { ImportRow } from '../src/components/bulkImportModel';

const signedIn = vi.hoisted(() => ({ capabilities: ['candidate:read'] as string[] }));
vi.mock('../src/auth', () => ({ useAuth: () => ({ user: { role: 'manager', capabilities: signedIn.capabilities } }) }));

const { CandidateImport } = await import('../src/pages/CandidateImport');
const { ImportPreviewList } = await import('../src/components/ImportPreviewList');

/** What the bulk import screens show, rendered to markup. */

function render(element: ReturnType<typeof createElement>): string {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    return renderToStaticMarkup(createElement(MemoryRouter, null, element));
  } finally {
    quiet.mockRestore();
  }
}

const row = (over: Partial<ImportRow> = {}): ImportRow => ({
  rowKey: 'r1', position: 1, fullName: 'Priya Sharma', email: 'priya@example.com', phone: '', linkedinUrl: '', filename: 'priya.pdf',
  hasCv: true, included: true, status: 'ready', message: 'Ready to add.', outcome: 'pending', candidateId: null, error: '', ...over,
});

describe('the import page for someone who cannot add candidates', () => {
  it('offers no upload, only who can', () => {
    const html = render(createElement(CandidateImport));

    expect({ upload: html.includes('type="file"'), says: html.includes('Only a recruiter or an admin can add candidates.') }).toEqual({ upload: false, says: true });
  });
});

describe('ImportPreviewList', () => {
  const html = () => render(createElement(ImportPreviewList, {
    rows: [row(), row({ rowKey: 'r2', position: 2, email: '', status: 'missing_email', message: 'Add an email address.' })],
    busy: false,
    onEdit: () => undefined,
  }));

  it('marks each row with a bracketed status', () => {
    const text = html().replace(/<!-- -->/g, '').replace(/<[^>]+>/g, '');

    expect(text).toContain('[ needs an email ]');
  });

  it('draws a rule on the row that needs a fix, not a fill', () => {
    expect(html().match(/class="import-row needs-fix"/g)).toHaveLength(1);
  });

  it('labels every name and email field', () => {
    const markup = html();
    const ids = [...markup.matchAll(/<input[^>]*id="([^"]+)"/g)].map((m) => m[1]);

    expect(ids.every((id) => markup.includes(`for="${id}"`))).toBe(true);
  });
});
