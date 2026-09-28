import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResumeFields, ResumeUploadCard, EMPTY_RESUME } from '../src/components/ResumeFields';

/**
 * A candidate imported from the ATS arrives without a resume, and the profile
 * page is where one gets added. The card must offer both ways in, and must not
 * be sendable empty.
 */

const noop = () => undefined;

describe('ResumeUploadCard', () => {
  const html = () => renderToStaticMarkup(createElement(ResumeUploadCard, { candidateId: 'c1', onUploaded: noop }));

  it('offers a file picker', () => {
    expect(html()).toMatch(/type="file"/);
  });

  it('offers a paste box', () => {
    expect(html()).toMatch(/<textarea[^>]*placeholder="Paste the candidate&#x27;s resume text here…"/);
  });

  it('cannot be sent before a resume is given', () => {
    expect(html()).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });
});

describe('ResumeFields', () => {
  it('says a resume is optional when told to', () => {
    const html = renderToStaticMarkup(createElement(ResumeFields, { value: EMPTY_RESUME, onChange: noop, optionalNote: 'optional' }));

    expect(html).toContain('Resume file (PDF, DOCX, or TXT) — optional');
  });

  it('ties both captions to their fields', () => {
    const html = renderToStaticMarkup(createElement(ResumeFields, { value: EMPTY_RESUME, onChange: noop }));
    const targets = [...html.matchAll(/<label for="([^"]+)"/g)].map((m) => m[1]);

    expect(targets.every((id) => html.includes(`id="${id}"`)) && targets.length === 2).toBe(true);
  });
});
