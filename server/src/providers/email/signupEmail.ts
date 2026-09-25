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
