import { brandedEmail } from './branding.js';
import type { EmailMessage } from './index.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function p(text: string): string {
  return `<p style="margin:0 0 12px">${escapeHtml(text)}</p>`;
}

function link(href: string, label: string): string {
  return `<p style="margin:0 0 10px"><a href="${escapeHtml(href)}" style="display:inline-block;background:#2f2f7a;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:6px;font-weight:600">${escapeHtml(label)}</a></p>`;
}

/**
 * A mail header is a single line. The applicant types their own name and it is
 * only length-checked on the way in, so a newline inside it would let a stranger
 * append headers to mail addressed to the operator. Collapse anything that is
 * not printable text, and bound the length.
 */
function header(value: string): string {
  // Written as an explicit code-point test rather than a regex character class:
  // every control character here would otherwise have to survive a source
  // literal, and one that does not is a sanitiser with a hole in it.
  const SPACE = 32;
  const DEL = 127;
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < SPACE || code === DEL ? ' ' : ch;
  }
  return out.trim().slice(0, 120);
}

export function renderSignupOperatorEmail(opts: {
  to: string;
  name: string;
  email: string;
  organisation: string;
  mode: 'new-org' | 'join';
  approveUrl: string;
  declineUrl: string;
}): EmailMessage {
  const modeLine = opts.mode === 'new-org'
    ? `They are asking to create a new organisation: ${opts.organisation}.`
    : `They are asking to join this organisation: ${opts.organisation}.`;
  const text = [
    'A person has requested access to Questor.',
    '',
    `Name: ${opts.name}`,
    `Email: ${opts.email}`,
    modeLine,
    '',
    'Approve this request:',
    opts.approveUrl,
    '',
    'Decline this request:',
    opts.declineUrl,
    '',
    'Nothing has been created yet. The account is created only if you approve.',
    '',
  ].join('\n');

  return brandedEmail({
    to: opts.to,
    subject: `Questor signup request — ${header(opts.name)}`,
    text,
    html: [
      p('A person has requested access to Questor.'),
      p(`Name: ${opts.name}`),
      p(`Email: ${opts.email}`),
      p(modeLine),
      link(opts.approveUrl, 'Approve request'),
      link(opts.declineUrl, 'Decline request'),
      p('Nothing has been created yet. The account is created only if you approve.'),
    ].join('\n'),
  });
}

export function renderSignupAcknowledgementEmail(opts: { to: string; name: string }): EmailMessage {
  const text = [
    `Hi ${opts.name},`,
    '',
    'We received your request for access to Questor.',
    '',
    'An operator will review it. Nothing else is needed from you right now.',
    '',
  ].join('\n');
  return brandedEmail({
    to: opts.to,
    subject: 'We received your Questor signup request',
    text,
    html: [
      p(`Hi ${opts.name},`),
      p('We received your request for access to Questor.'),
      p('An operator will review it. Nothing else is needed from you right now.'),
    ].join('\n'),
  });
}

export function renderSignupWelcomeEmail(opts: { to: string; name: string; signInUrl: string }): EmailMessage {
  const text = [
    `Hi ${opts.name},`,
    '',
    'Your Questor account has been approved.',
    '',
    'You can sign in here:',
    opts.signInUrl,
    '',
  ].join('\n');
  return brandedEmail({
    to: opts.to,
    subject: 'Your Questor account is ready',
    text,
    html: [
      p(`Hi ${opts.name},`),
      p('Your Questor account has been approved.'),
      link(opts.signInUrl, 'Sign in to Questor'),
    ].join('\n'),
  });
}
