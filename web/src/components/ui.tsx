import type { ReactNode } from 'react';

export function Badge({ children, kind }: { children: ReactNode; kind?: 'green' | 'amber' | 'red' | 'blue' | 'gray' }) {
  return <span className={`badge ${kind ?? 'gray'}`}>{children}</span>;
}

export function recBadge(rec?: string | null) {
  if (!rec) return <Badge kind="gray">—</Badge>;
  const kind = rec === 'PROCEED' ? 'green' : rec === 'CONSIDER' ? 'amber' : 'red';
  return <Badge kind={kind as any}>{rec.replace(/_/g, ' ')}</Badge>;
}

export function stateBadge(state: string) {
  const green = ['REVIEW_READY', 'HUMAN_REVIEWED', 'CLOSED', 'ACCEPTED'];
  const amber = ['ASSESSING', 'CANDIDATE_QUESTIONS', 'PROCESSING', 'INVITED', 'WARMUP', 'CONSENTED'];
  const red = ['CANCELLED', 'NO_SHOW', 'TECHNICAL_FAILURE', 'POLICY_STOP', 'CANDIDATE_WITHDREW'];
  const kind = green.includes(state) ? 'green' : red.includes(state) ? 'red' : amber.includes(state) ? 'amber' : 'blue';
  return <Badge kind={kind as any}>{state.replace(/_/g, ' ')}</Badge>;
}

export function Banner({ kind, children }: { kind: 'error' | 'info' | 'ok'; children: ReactNode }) {
  return <div className={`banner ${kind}`}>{children}</div>;
}

export function Meter({ value }: { value: number }) {
  return <div className="meter"><span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return <div className="stat"><div className="value">{value}</div><div className="label">{label}</div></div>;
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
      out.push('<table><thead><tr>' + header.map((h) => `<th>${inline(h)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
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
