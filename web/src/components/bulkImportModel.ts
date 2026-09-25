import type { IconName } from './Icon';

/**
 * Rules behind bulk import (pages/CandidateImport.tsx): which files go up, in
 * what pieces, which rows confirm would act on, and how each state is worded.
 * The server decides every status; this only reads them.
 */

/** The server's limits (routes/candidateImports.ts, services/candidateImport.ts). */
export const MAX_IMPORT_PEOPLE = 200;
export const CV_CHUNK = 5;
export const CONFIRM_CHUNK = 25;
const CV_MAX_BYTES = 5 * 1024 * 1024;

export type ImportRowStatus =
  | 'ready' | 'known' | 'existing' | 'unreadable' | 'missing_name' | 'missing_email' | 'invalid_email' | 'duplicate_in_batch';

export interface ImportRow {
  readonly rowKey: string;
  readonly position: number;
  readonly fullName: string;
  readonly email: string;
  readonly phone: string;
  readonly linkedinUrl: string;
  readonly filename: string;
  readonly hasCv: boolean;
  readonly included: boolean;
  readonly status: ImportRowStatus;
  readonly message: string;
  readonly existingCandidateId?: string;
  readonly outcome: string;
  readonly candidateId: string | null;
  readonly error: string;
}

export interface ImportPreview {
  readonly batch: { readonly id: string; readonly roleId: string; readonly roleTitle: string; readonly expiresAt: string };
  readonly rows: readonly ImportRow[];
}

export interface ConfirmedRow {
  readonly rowKey: string;
  readonly outcome: string;
  readonly candidateId: string | null;
  readonly error: string;
  readonly interview: { readonly id: string; readonly state: string } | null;
}

export type ImportSource = 'csv' | 'cv';

export function chunk<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

interface FileLike {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}

const CV_TYPES = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain']);
const CV_EXTENSIONS = /\.(pdf|docx|txt)$/i;
export const CV_ACCEPT = '.pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain';
export const CSV_ACCEPT = '.csv,text/csv';

export function isCvFile(f: FileLike): boolean {
  return f.type ? CV_TYPES.has(f.type) : CV_EXTENSIONS.test(f.name);
}

/** The files worth sending, and the rest with the reason, so nobody waits on an upload that can only be refused. */
export function screenCvFiles<T extends FileLike>(files: readonly T[]): { accepted: T[]; skipped: { name: string; reason: string }[] } {
  return files.reduce<{ accepted: T[]; skipped: { name: string; reason: string }[] }>((acc, f) => {
    if (!isCvFile(f)) return { ...acc, skipped: [...acc.skipped, { name: f.name, reason: 'not a PDF, DOCX or text file' }] };
    if (f.size > CV_MAX_BYTES) return { ...acc, skipped: [...acc.skipped, { name: f.name, reason: 'larger than 5 MB' }] };
    if (acc.accepted.length >= MAX_IMPORT_PEOPLE) return { ...acc, skipped: [...acc.skipped, { name: f.name, reason: `over the ${MAX_IMPORT_PEOPLE}-file limit` }] };
    return { ...acc, accepted: [...acc.accepted, f] };
  }, { accepted: [], skipped: [] });
}

/** A starting file with the columns the import reads, and one example row. */
export function csvTemplate(): string {
  return 'name,email,phone,linkedin\nPriya Sharma,priya.sharma@example.com,+91 98765 43210,https://www.linkedin.com/in/priya-sharma\n';
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type StatusTone = 'ok' | 'info' | 'fix';

interface StatusView {
  readonly label: string;
  readonly tone: StatusTone;
  readonly icon: IconName;
}

const STATUS_VIEW: Readonly<Record<ImportRowStatus, StatusView>> = {
  ready: { label: 'ready', tone: 'ok', icon: 'check-circle' },
  known: { label: 'in Questor', tone: 'ok', icon: 'link' },
  existing: { label: 'already a candidate', tone: 'info', icon: 'candidate-profile' },
  unreadable: { label: 'could not read CV', tone: 'fix', icon: 'x-circle' },
  missing_name: { label: 'needs a name', tone: 'fix', icon: 'alert' },
  missing_email: { label: 'needs an email', tone: 'fix', icon: 'alert' },
  invalid_email: { label: 'invalid email', tone: 'fix', icon: 'alert' },
  duplicate_in_batch: { label: 'repeat', tone: 'fix', icon: 'copy' },
};

export const statusView = (status: ImportRowStatus): StatusView => STATUS_VIEW[status];

const CONFIRMABLE: ReadonlySet<ImportRowStatus> = new Set(['ready', 'known', 'existing']);
const DONE = new Set(['created', 'linked']);

export const isDone = (outcome: string): boolean => DONE.has(outcome);

/** Rows confirm would act on: ticked, not needing a fix, not already added. */
export function confirmableKeys(rows: readonly ImportRow[]): string[] {
  return rows.filter((r) => r.included && CONFIRMABLE.has(r.status) && !isDone(r.outcome)).map((r) => r.rowKey);
}

/** A CV that could not be read has nothing to import; an added row is history. */
export function isEditable(r: ImportRow): boolean {
  return !isDone(r.outcome) && r.status !== 'unreadable';
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function previewSummary(rows: readonly ImportRow[]): string {
  const ticked = rows.filter((r) => r.included);
  const ready = ticked.filter((r) => r.status === 'ready' || r.status === 'known').length;
  const existing = ticked.filter((r) => r.status === 'existing').length;
  const needsFix = ticked.filter((r) => statusView(r.status).tone === 'fix').length;
  const leftOut = rows.length - ticked.length;
  return [
    `${ready} ready to add`,
    existing ? plural(existing, 'already a candidate', 'already candidates') : '',
    needsFix ? plural(needsFix, 'needs a fix', 'need a fix') : '',
    leftOut ? `${leftOut} left out` : '',
  ].filter(Boolean).join(' · ');
}

export function resultSummary(results: readonly ConfirmedRow[]): string {
  const added = results.filter((r) => r.outcome === 'created').length;
  const linked = results.filter((r) => r.outcome === 'linked').length;
  const failed = results.filter((r) => r.outcome === 'failed').length;
  return [
    `${added} added`,
    linked ? plural(linked, 'already a candidate', 'already candidates') : '',
    failed ? `${failed} failed` : '',
  ].filter(Boolean).join(' · ');
}

export function retryableKeys(results: readonly ConfirmedRow[]): string[] {
  return results.filter((r) => r.outcome === 'failed').map((r) => r.rowKey);
}
