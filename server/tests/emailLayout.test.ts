import { describe, it, expect } from 'vitest';
import { companyEmail, detailsTable, emailButton, noticeBlock, preheader, safeHref } from '../src/providers/email/branding.js';

/**
 * The parts every Questor email is built from, and the four things that break
 * mail: Outlook's Word renderer, blocked images, forced dark mode, and a value
 * longer than the column it was drawn for.
 *
 * Asserted on the rendered string rather than on a snapshot, because what
 * matters is not that the markup is unchanged — it is that specific properties
 * hold. A snapshot would go green on a template that lost its plain URL.
 */

/** What a reader sees with every tag removed: the words, in order. */
function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

const LONG_TITLE = 'Senior Lead Cloud Distributed Infrastructure Reliability and Observability Platform Architect';

describe('the join button', () => {
  // Outlook's Word renderer drops padding on an inline-block anchor, so a
  // button styled that way arrived as bare underlined text on a white row —
  // on the client a majority of corporate readers use.
  it('paints its background on a table cell, which Word renders', () => {
    expect(emailButton('https://q.example.test/portal/x', 'Join')).toMatch(/<td[^>]*bgcolor="#2f2f7a"/);
  });

  it('carries the colour as an attribute and as a style, because Word reads only the attribute', () => {
    const html = emailButton('https://q.example.test/portal/x', 'Join');

    expect(html).toMatch(/bgcolor="#2f2f7a"[^>]*style="[^"]*background-color:#2f2f7a/);
  });

  it('writes the address out underneath, for a client that strips the link', () => {
    expect(visibleText(emailButton('https://q.example.test/portal/abc', 'Join')))
      .toContain('https://q.example.test/portal/abc');
  });

  it('lets a long address wrap instead of widening the message', () => {
    expect(emailButton('https://q.example.test/portal/abc', 'Join')).toContain('word-break:break-all');
  });

  it('escapes a label so it cannot close the anchor', () => {
    expect(emailButton('https://q.example.test/x', '"><script>alert(1)</script>')).not.toContain('<script>');
  });

  it('escapes the address itself', () => {
    expect(emailButton('https://q.example.test/x?a=1&b=2', 'Join')).not.toMatch(/href="[^"]*&b=/);
  });

  // Escaping keeps a value inside its attribute; it says nothing about where
  // the attribute points. A meeting URL is typed by an operator, and a `data:`
  // href in a letter that appears to come from the reader's own company is a
  // credible phish.
  it('refuses to make a data: address clickable', () => {
    expect(emailButton('data:text/html,<h1>Sign in</h1>', 'Join')).not.toContain('href=');
  });

  it('refuses to make a javascript: address clickable', () => {
    expect(emailButton('javascript:alert(1)', 'Join')).not.toContain('href=');
  });

  it('refuses a relative address, which resolves to nothing in a mail client', () => {
    expect(emailButton('/portal/abc', 'Join')).not.toContain('href=');
  });

  // The reader is not left wondering why the button vanished: they see the
  // address they were sent and can judge it themselves.
  it('still shows a refused address as plain text', () => {
    expect(visibleText(emailButton('data:text/html,hi', 'Join'))).toContain('data:text/html,hi');
  });

  it('escapes a refused address rather than writing it raw', () => {
    expect(emailButton('data:text/html,<script>alert(1)</script>', 'Join')).not.toContain('<script>');
  });

  it('still makes an ordinary https address clickable', () => {
    expect(emailButton('https://q.example.test/portal/abc', 'Join')).toContain('href="https://q.example.test/portal/abc"');
  });
});

describe('safeHref', () => {
  it('accepts https', () => {
    expect(safeHref('https://q.example.test/x')).toBe('https://q.example.test/x');
  });

  it('accepts http, because a self-hosted deployment may not have a certificate', () => {
    expect(safeHref('http://localhost:5173/portal/abc')).toBe('http://localhost:5173/portal/abc');
  });

  it('rejects a scheme that is neither', () => {
    expect([safeHref('data:text/html,x'), safeHref('javascript:alert(1)'), safeHref('file:///etc/passwd')])
      .toEqual(['', '', '']);
  });

  it('rejects something that is not a URL at all', () => {
    expect(safeHref('not a url')).toBe('');
  });

  it('rejects an empty address', () => {
    expect(safeHref('   ')).toBe('');
  });

  // A trusted name in front of the @ is not the host. In an email, where the
  // only defence a reader has is reading the address, that is the attack.
  it('rejects an address with a name in front of the @', () => {
    expect(safeHref('https://questor.example.test@evil.example/portal')).toBe('');
  });

  it('rejects one with a password in it, for the same reason', () => {
    expect(safeHref('https://user:pw@evil.example/')).toBe('');
  });

  // A backslash is normalised to a slash, so this is a link to evil.example
  // that does not read as one.
  it('rejects an address whose slashes are backslashes', () => {
    expect(safeHref('https:/\\evil.example/portal')).toBe('');
  });

  it('rejects an address carrying a control character', () => {
    expect(safeHref(`https://questor.example.test/${String.fromCharCode(13)}x`)).toBe('');
  });

  // Not merely one `new URL` will parse: a scheme-relative or bare-host value
  // resolves somewhere different, or nowhere, in a mail client.
  it('rejects a scheme-relative address', () => {
    expect(safeHref('//evil.example/portal')).toBe('');
  });

  // What comes back is what the browser will do, not what somebody typed, so
  // the address shown and the address followed cannot differ.
  it('returns the parsed address rather than the raw string', () => {
    expect(safeHref('HTTPS://Questor.Example.Test/portal')).toBe('https://questor.example.test/portal');
  });
});

describe('the details table', () => {
  const rows = [{ label: 'Role', value: LONG_TITLE }, { label: 'Interviewer', value: 'Avery' }];

  it('renders every row as a label and a value', () => {
    const text = visibleText(detailsTable(rows));

    expect(text).toContain('Role');
    expect(text).toContain(LONG_TITLE);
    expect(text).toContain('Interviewer');
  });

  it('fixes the layout so a long value cannot stretch the message', () => {
    expect(detailsTable(rows)).toContain('table-layout:fixed');
  });

  it('breaks a long value inside its cell', () => {
    expect(detailsTable(rows)).toContain('word-break:break-word');
  });

  // A role title is attacker-controllable: it comes out of a job description.
  it('escapes a value', () => {
    expect(detailsTable([{ label: 'Role', value: '<img src=x onerror=alert(1)>' }])).not.toContain('<img src=x');
  });

  it('escapes a label too', () => {
    expect(detailsTable([{ label: '<b>Role</b>', value: 'x' }])).not.toContain('<b>Role</b>');
  });

  it('leaves out a row with no value, rather than printing an empty one', () => {
    expect(visibleText(detailsTable([{ label: 'Interviewer', value: '' }, { label: 'Role', value: 'Cook' }])))
      .not.toContain('Interviewer');
  });

  it('renders nothing at all when no row has a value', () => {
    expect(detailsTable([{ label: 'Role', value: '' }])).toBe('');
  });
});

describe('the notice block', () => {
  it('shows every sentence it is given', () => {
    const text = visibleText(noticeBlock(['First sentence.', 'Second sentence.']));

    expect(text).toContain('First sentence.');
    expect(text).toContain('Second sentence.');
  });

  it('escapes what it is given', () => {
    expect(noticeBlock(['<script>alert(1)</script>'])).not.toContain('<script>');
  });

  it('renders nothing when there is nothing to say', () => {
    expect(noticeBlock([])).toBe('');
  });

  // Grey-on-white that a client inverts becomes grey-on-black. The notice is
  // the one block that must stay readable, so it states its own background.
  it('states its own background, so a forced inversion has something to invert', () => {
    expect(noticeBlock(['x'])).toMatch(/bgcolor="#f7f7fb"/);
  });
});

describe('the preheader', () => {
  it('puts the line where a client shows the preview', () => {
    expect(visibleText(preheader('Your interview is booked for Tuesday'))).toContain('Your interview is booked for Tuesday');
  });

  it('hides it from the body, so it is not read twice', () => {
    expect(preheader('x')).toContain('display:none');
  });

  it('hides it from Outlook too, which ignores display:none on its own', () => {
    expect(preheader('x')).toContain('mso-hide:all');
  });

  it('escapes it', () => {
    expect(preheader('<script>alert(1)</script>')).not.toContain('<script>');
  });

  it('renders nothing when there is no line', () => {
    expect(preheader('  ')).toBe('');
  });
});

describe('the company wrapper', () => {
  it('declares that it handles both colour schemes, so a client need not force one', () => {
    const message = companyEmail({ to: '', subject: 's', text: 't', html: '<p>x</p>' }, 'Acme');

    expect(message.html).toContain('color-scheme:light dark');
  });

  it('gives every surface an explicit background attribute, which Word needs', () => {
    const message = companyEmail({ to: '', subject: 's', text: 't', html: '<p>x</p>' }, 'Acme');

    expect(message.html).toMatch(/<table[^>]*bgcolor="#ffffff"/);
  });

  it('escapes the organisation name in the header it prints', () => {
    const message = companyEmail({ to: '', subject: 's', text: 't', html: '<p>x</p>' }, '<script>alert(1)</script>');

    expect(message.html).not.toContain('<script>');
  });

  it('breaks a very long organisation name rather than widening the card', () => {
    const message = companyEmail({ to: '', subject: 's', text: 't', html: '<p>x</p>' }, 'A'.repeat(90));

    expect(message.html).toContain('word-break:break-word');
  });

  it('carries a preheader when it is given one', () => {
    const message = companyEmail({ to: '', subject: 's', text: 't', html: '<p>x</p>' }, 'Acme', 'Tuesday at 14:30');

    expect(visibleText(message.html)).toContain('Tuesday at 14:30');
  });

  it('leaves the plain-text body exactly as the caller wrote it', () => {
    const text = 'Hi Ada,\n\nStart here: https://example.test/portal/abc';

    expect(companyEmail({ to: '', subject: 's', text, html: '<p>x</p>' }, 'Acme').text).toBe(text);
  });
});
