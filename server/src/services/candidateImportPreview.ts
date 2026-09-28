import { z } from 'zod';
import { normalizeEmail } from './userEmail.js';

/**
 * The verdict on each staged row of a bulk import, worked out fresh on every
 * read so an edit (a corrected address, an unticked row) is reflected at once.
 * Pure: the caller supplies who is already on the role and who is known
 * elsewhere in their scope.
 */

export type ImportRowStatus =
  | 'ready'
  | 'known'
  | 'existing'
  | 'unreadable'
  | 'missing_name'
  | 'missing_email'
  | 'invalid_email'
  | 'duplicate_in_batch';

export interface PreviewInput {
  readonly rowKey: string;
  readonly fullName: string;
  readonly email: string;
  readonly hasCv: boolean;
  readonly readError: string;
  readonly included: boolean;
}

export interface PreviewContext {
  /** Normalised address → the application already on this role. */
  readonly onRole: ReadonlyMap<string, string>;
  /** Normalised address → an application elsewhere the caller may see, to copy from. */
  readonly known: ReadonlyMap<string, string>;
}

export interface PreviewVerdict {
  readonly rowKey: string;
  readonly status: ImportRowStatus;
  readonly message: string;
  readonly existingCandidateId?: string;
  readonly knownCandidateId?: string;
}

const IMPORTABLE: ReadonlySet<ImportRowStatus> = new Set(['ready', 'known', 'existing']);

/** Whether confirming would act on a row with this status (existing rows are linked, not duplicated). */
export const isImportable = (status: ImportRowStatus): boolean => IMPORTABLE.has(status);

const emailSchema = z.string().email().max(254);

export const STATUS_MESSAGE: Readonly<Record<ImportRowStatus, string>> = {
  ready: 'Ready to add.',
  known: 'Already in Questor for another role; their details are reused for this one.',
  existing: 'Already a candidate for this role; the existing application is kept.',
  unreadable: 'Could not read this CV. Add this person on their own with a text-based PDF or DOCX.',
  missing_name: 'Add a name.',
  missing_email: 'Add an email address.',
  invalid_email: 'This email address is not valid.',
  duplicate_in_batch: 'The same email appears earlier in this import.',
};

function ownStatus(row: PreviewInput): ImportRowStatus | null {
  if (row.readError) return 'unreadable';
  if (!row.fullName.trim()) return 'missing_name';
  if (!row.email.trim()) return 'missing_email';
  if (!emailSchema.safeParse(row.email.trim()).success) return 'invalid_email';
  return null;
}

export function previewRows(rows: readonly PreviewInput[], ctx: PreviewContext): PreviewVerdict[] {
  // Only a ticked, valid row claims an address, so fixing or unticking the
  // first of two repeats frees the second.
  const claimed = new Set<string>();
  return rows.map((row) => {
    const own = ownStatus(row);
    if (own) return { rowKey: row.rowKey, status: own, message: STATUS_MESSAGE[own] };
    const key = normalizeEmail(row.email);
    if (claimed.has(key)) return { rowKey: row.rowKey, status: 'duplicate_in_batch', message: STATUS_MESSAGE.duplicate_in_batch };
    if (row.included) claimed.add(key);
    const existing = ctx.onRole.get(key);
    if (existing) return { rowKey: row.rowKey, status: 'existing', message: STATUS_MESSAGE.existing, existingCandidateId: existing };
    const known = ctx.known.get(key);
    if (known) return { rowKey: row.rowKey, status: 'known', message: STATUS_MESSAGE.known, knownCandidateId: known };
    return { rowKey: row.rowKey, status: 'ready', message: STATUS_MESSAGE.ready };
  });
}
