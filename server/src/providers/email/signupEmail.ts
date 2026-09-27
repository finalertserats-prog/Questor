import { brandedEmail, emailButton, headerSafe } from './branding.js';
import type { EmailMessage } from './index.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function p(text: string): string {
  return `<p style="margin:0 0 12px">${escapeHtml(text)}</p>`;
}

function link(href: string, label: string): string {
  return emailButton(href, label);
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
    subject: `Questor signup request — ${headerSafe(opts.name)}`,
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

/**
 * The first click of the product, and for a long time the last one.
 *
 * `signInUrl` must be the organisation's own door (`/o/<slug>`). `/login`
 * carries no credential form by design — it is an organisation picker — and the
 * slug is minted at approval, so this mail is the only place the new admin can
 * learn it. Sent to `/login`, they had to guess their own organisation by a
 * three-character prefix. Two real organisations were approved, arrived there,
 * and never signed in.
 *
 * The slug is therefore written out in words as well as linked: a mail client
 * that strips the button, a forwarded plain-text copy and a printed page all
 * still carry the one fact they cannot recover from anywhere else.
 */
export function renderSignupWelcomeEmail(opts: { to: string; name: string; organisation: string; orgSlug: string | null; signInUrl: string }): EmailMessage {
  // Null only for an organisation that predates per-organisation sign-in links
  // and was never given a slug; the caller logs that for the operator.
  const slugLine = opts.orgSlug
    ? `Your organisation's sign-in name is ${opts.orgSlug} — everyone at ${opts.organisation} signs in at the address above.`
    : null;
  const text = [
    `Hi ${opts.name},`,
    '',
    `Your Questor account has been approved, for ${opts.organisation}.`,
    '',
    'You can sign in here:',
    opts.signInUrl,
    '',
    ...(slugLine ? [slugLine, ''] : []),
  ].join('\n');
  return brandedEmail({
    to: opts.to,
    subject: 'Your Questor account is ready',
    text,
    html: [
      p(`Hi ${opts.name},`),
      p(`Your Questor account has been approved, for ${opts.organisation}.`),
      link(opts.signInUrl, `Sign in to ${opts.organisation}`),
      ...(slugLine ? [p(slugLine)] : []),
    ].join('\n'),
  });
}
