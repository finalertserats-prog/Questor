import { brandedEmail, headerSafe } from './branding.js';
import type { EmailMessage } from './index.js';

function escapeHtml(s: string): string { return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`); }
function p(text: string): string { return `<p style="margin:0 0 12px">${escapeHtml(text)}</p>`; }
function link(href: string, label: string): string { return `<p style="margin:0 0 10px"><a href="${escapeHtml(href)}" style="display:inline-block;background:#2f2f7a;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:6px;font-weight:600">${escapeHtml(label)}</a></p>`; }

export function renderDemoAccessEmail(opts: { to: string; name: string; linkUrl: string }): EmailMessage {
  const text = [`Hi ${opts.name},`, '', 'Here is your one-time Questor demo sign-in link. It opens your private sandbox and can be used once.', '', opts.linkUrl, '', 'The demo session lasts 45 minutes after you open it.'].join('\n');
  return brandedEmail({ to: opts.to, subject: 'Your Questor demo link', text, html: [p(`Hi ${opts.name},`), p('Here is your one-time Questor demo sign-in link. It opens your private sandbox and can be used once.'), link(opts.linkUrl, 'Start the demo'), p('The demo session lasts 45 minutes after you open it.')].join('\n') });
}

export function renderDemoOperatorEmail(opts: { to: string; name: string; email: string; company: string }): EmailMessage {
  const text = ['A visitor requested a self-serve Questor demo.', '', `Name: ${opts.name}`, `Email: ${opts.email}`, `Company: ${opts.company}`].join('\n');
  return brandedEmail({ to: opts.to, subject: `Questor demo request — ${headerSafe(opts.company)}`, text, html: [p('A visitor requested a self-serve Questor demo.'), p(`Name: ${opts.name}`), p(`Email: ${opts.email}`), p(`Company: ${opts.company}`)].join('\n') });
}

export function renderDemoDecisionEmail(opts: { to: string; name: string; email: string; company: string; approveUrl: string; declineUrl: string }): EmailMessage {
  const text = ['A visitor requested demo access again.', '', `Name: ${opts.name}`, `Email: ${opts.email}`, `Company: ${opts.company}`, '', 'Approve:', opts.approveUrl, '', 'Decline:', opts.declineUrl].join('\n');
  return brandedEmail({ to: opts.to, subject: `Questor demo reaccess — ${headerSafe(opts.email)}`, text, html: [p('A visitor requested demo access again.'), p(`Name: ${opts.name}`), p(`Email: ${opts.email}`), p(`Company: ${opts.company}`), link(opts.approveUrl, 'Approve'), link(opts.declineUrl, 'Decline')].join('\n') });
}

export function renderDemoDeclinedEmail(opts: { to: string; name: string }): EmailMessage {
  const text = [`Hi ${opts.name},`, '', 'Thanks for trying Questor. We cannot reopen this self-serve demo link right now. Please contact us if you would like to talk.'].join('\n');
  return brandedEmail({ to: opts.to, subject: 'Questor demo access request', text, html: [p(`Hi ${opts.name},`), p('Thanks for trying Questor. We cannot reopen this self-serve demo link right now. Please contact us if you would like to talk.')].join('\n') });
}
