import { brandedEmail, emailButton, escapeHtml } from './branding.js';
import { firstName } from '../../engines/openingModel.js';
import { KIND_LABEL, type NeedsYouKind } from '../../domain/needsYou.js';
import type { EmailMessage } from './index.js';

/**
 * The HR-Box daily summary (services/dailyDigest.ts): the same rows the Home
 * queue shows, most urgent first, each with its one link, and a way to turn
 * the email off. Only names and role titles the reader can already see in the
 * console; no assessment content.
 */

export interface DigestRow {
  readonly kind: NeedsYouKind;
  readonly urgent: boolean;
  readonly who: string;
  readonly role: string | null;
  readonly since: Date;
  /** Absolute console link for the row's action, or null when it has none. */
  readonly href: string | null;
}

export interface DigestDetails {
  readonly userName: string;
  readonly total: number;
  readonly rows: readonly DigestRow[];
  readonly homeUrl: string;
  readonly settingsUrl: string;
  readonly now: Date;
}

/** "18 min", "3 h", "5 days": how long a row has waited. */
export function waitedFor(since: Date, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - since.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

export function buildDigestEmail(d: DigestDetails): EmailMessage {
  const first = firstName(d.userName) || 'there';
  const lead = d.total === 1 ? 'One thing needs you today.' : `${d.total} things need you today.`;
  const more = d.total > d.rows.length ? `And ${d.total - d.rows.length} more on your Home page.` : '';
  const line = (r: DigestRow) => `${KIND_LABEL[r.kind]}${r.urgent ? ' (urgent)' : ''}: ${r.who}${r.role ? `, ${r.role}` : ''}. Waiting ${waitedFor(r.since, d.now)}.`;
  const text = [
    `Hi ${first},`, '', lead, '',
    ...d.rows.map((r) => `- ${line(r)}${r.href ? ` ${r.href}` : ''}`),
    ...(more ? ['', more] : []),
    '', `Open Home: ${d.homeUrl}`, '',
    `You get this summary each morning when something is waiting. Turn it off in Settings: ${d.settingsUrl}`,
  ].join('\n');
  const html = [
    `<p>Hi ${escapeHtml(first)},</p>`,
    `<p style="font-weight:600">${escapeHtml(lead)}</p>`,
    '<ul style="padding-left:18px;margin:0 0 14px">',
    ...d.rows.map((r) => `<li style="margin:0 0 8px">${escapeHtml(line(r))}${r.href ? ` <a href="${escapeHtml(r.href)}">Open</a>` : ''}</li>`),
    '</ul>',
    more ? `<p>${escapeHtml(more)}</p>` : '',
    emailButton(d.homeUrl, 'Open Home'),
    `<p style="color:#5a5a6e;font-size:13px">You get this summary each morning when something is waiting. <a href="${escapeHtml(d.settingsUrl)}">Turn it off in Settings</a>.</p>`,
  ].join('\n');
  return brandedEmail({ to: '', subject: d.total === 1 ? 'Questor: one thing needs you today' : `Questor: ${d.total} things need you today`, text, html });
}
