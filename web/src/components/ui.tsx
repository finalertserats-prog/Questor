import type { ReactNode } from 'react';
import { StatusBadge } from './StatusBadge';
import { isTextStatValue } from './scoreFormat';

export function Badge({ children, kind }: { children: ReactNode; kind?: 'green' | 'amber' | 'red' | 'blue' | 'gray' }) {
  return <span className={`badge ${kind ?? 'gray'}`}>{children}</span>;
}

/**
 * The AI recommendation badge.
 *
 * The caveat lives HERE rather than on each page because this is the single
 * sink every recommendation flows through — the dashboard, the interview list
 * and the interview detail all render it, and those lists are where the score
 * actually does its triage work. A reviewer scanning a column of PROCEED /
 * DO NOT PROGRESS badges sorts by them and may never open the detail view that
 * carries the full validation notice. Putting the marker on the badge means a
 * new screen cannot display a recommendation without it.
 *
 * The asterisk is deliberately quiet: loud enough to prompt "what's that?",
 * quiet enough not to be tuned out by the tenth row.
 */
export function recBadge(rec?: string | null) {
  if (!rec) return <Badge kind="gray">—</Badge>;
  return (
    <span
      title="This score comes from an instrument that has not been validated against human judgement. Open the assessment and judge the evidence yourself before acting on it."
      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'help' }}
    >
      <StatusBadge kind="recommendation" value={rec} />
      <abbr style={{ textDecoration: 'none', opacity: 0.7, fontSize: '0.85em' }} aria-label="unvalidated score">*</abbr>
    </span>
  );
}

/**
 * The AI's call in a list cell. When the organisation requires an independent
 * review first, the server leaves the recommendation out for a reviewer who
 * has not judged yet; a dash would read as "no assessment", so say it.
 */
export function aiCallCell(s: { recommendation?: string | null; blindReviewPending?: boolean }) {
  if (s.blindReviewPending) {
    return <span className="muted small" title="The AI's call shows once you record your own verdict.">Your review first</span>;
  }
  return recBadge(s.recommendation);
}

/** Interview state chip. Tone groupings live in statusModel.ts. */
export function stateBadge(state: string) {
  return <StatusBadge kind="interview" value={state} />;
}

/**
 * Banners appear after something happened — a failed save, a submitted review —
 * so a screen reader has to be told they arrived. Errors interrupt (role
 * "alert"); the rest wait for a pause (role "status"), which is the difference
 * between "this needs you now" and "for your information".
 */
export function Banner({ kind, children }: { kind: 'error' | 'info' | 'ok'; children: ReactNode }) {
  return <div className={`banner ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Meter({ value }: { value: number }) {
  return <div className="meter"><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return <div className="stat"><div className={isTextStatValue(value) ? 'value value-text' : 'value'}>{value}</div><div className="label">{label}</div></div>;
}

// Minimal, safe markdown renderer (headings, bold, tables, blockquotes, lists).
export function Markdown({ text }: { text: string }) {
  const html = renderMarkdown(text);
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function esc(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function inline(s: string) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>').replace(/_(.+?)_/g, '<i>$1</i>');
}
function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|?$/.test(lines[i + 1])) {
      const header = line.split('|').slice(1, -1).map((c) => c.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim())); i++; }
      // Scrolls inside its own region rather than pushing the page sideways.
      out.push('<div class="table-scroll" tabindex="0" role="region" aria-label="Report table"><table><thead><tr>' + header.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    if (/^### /.test(line)) out.push(`<h3>${inline(line.slice(4))}</h3>`);
    else if (/^## /.test(line)) out.push(`<h2>${inline(line.slice(3))}</h2>`);
    else if (/^# /.test(line)) out.push(`<h1>${inline(line.slice(2))}</h1>`);
    else if (/^> /.test(line)) out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
    else if (/^- /.test(line)) out.push(`<li>${inline(line.slice(2))}</li>`);
    else if (/^---/.test(line)) out.push('<hr/>');
    else if (line.trim() === '') out.push('');
    else out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  return out.join('\n');
}
