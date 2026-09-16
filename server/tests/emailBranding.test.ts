import { describe, it, expect } from 'vitest';
import { brandedEmail } from '../src/providers/email/branding.js';
import { config } from '../src/config.js';

/**
 * Every message Questor sends carries the product's mark.
 *
 * Both bodies matter: a candidate whose mail client strips HTML must still get
 * a working link and plain words, so the wrapper decorates the HTML and leaves
 * the text body exactly as the caller wrote it.
 */

describe('branded email', () => {
  it('puts the wordmark, served from this deployment, at the top of the HTML body', () => {
    const message = brandedEmail({ to: 'a@b.local', subject: 'Hello', html: '<p>Body</p>', text: 'Body' });

    expect(message.html).toContain(`${config.webOrigin}/brand/questor-wordmark.png`);
  });

  it('keeps the caller’s HTML inside the wrapper', () => {
    const message = brandedEmail({ to: 'a@b.local', subject: 'Hello', html: '<p>Start your interview</p>', text: 'x' });

    expect(message.html).toContain('<p>Start your interview</p>');
  });

  it('leaves the plain-text body untouched', () => {
    const text = 'Hi Ada,\n\nStart here: https://example.test/portal/abc\n\nThanks';

    expect(brandedEmail({ to: 'a@b.local', subject: 'Hello', html: '<p>x</p>', text }).text).toBe(text);
  });

  it('carries the product line once, as a footer', () => {
    const message = brandedEmail({ to: 'a@b.local', subject: 'Hello', html: '<p>x</p>', text: 'x' });

    expect(message.html.match(/The intelligence behind every hire/g)).toHaveLength(1);
  });

  it('passes the recipient and subject through unchanged', () => {
    const message = brandedEmail({ to: 'ada@example.test', subject: 'Your first-round interview', html: '<p>x</p>', text: 'x' });

    expect({ to: message.to, subject: message.subject }).toEqual({ to: 'ada@example.test', subject: 'Your first-round interview' });
  });
});
