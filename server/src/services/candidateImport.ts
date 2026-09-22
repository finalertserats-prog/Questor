import type { CandidateImportRow, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/index.js';
import { logger } from '../logger.js';
import { assertCanAccessRole, candidateScope } from './access.js';
import { assertRoleOpen } from './roleOpen.js';
import { logAudit } from './audit.js';
import { normalizeEmail } from './userEmail.js';
import { applyCandidateToRole } from './candidateReuse.js';
import { attachResume, createApplication } from './candidateCreate.js';
import { MAX_IMPORT_ROWS, parseCandidateCsv, type CsvPerson } from './candidateImportCsv.js';
import { isImportable, previewRows, type ImportRowStatus, type PreviewVerdict } from './candidateImportPreview.js';
import { readResumeFile, sanitizeFilename } from './resumeFile.js';
import { extractContact, normalizeLinkedinUrl } from '../engines/resumeContact.js';
import type { AuthClaims } from './auth.js';

/**
 * Bulk import of candidates onto one role, in three steps: stage the people
 * (from a CSV or a set of CVs), preview and edit them, then confirm. Nothing
 * becomes a candidate before confirm; each confirmed row goes through the same
 * create and resume services as Add candidate (services/candidateCreate.ts).
 *
 * A batch belongs to the user who made it, inside their tenant, and expires:
 * staged rows hold names, addresses and CV text of people who may never be
 * added, so they must not outlive the task.
 */

export const IMPORT_TTL_MS = 24 * 60 * 60_000;
/** Open batches per user; a new one past this is refused rather than piling up CV text. */
export const MAX_OPEN_BATCHES = 10;
/** Rows confirmed per request, so one request stays well inside any timeout. */
export const MAX_CONFIRM_ROWS = 25;
/** A row still "working" after this is taken to be from a request that died, and may be retried. */
const STALE_WORK_MS = 2 * 60_000;

type Outcome = 'pending' | 'working' | 'created' | 'linked' | 'failed';
const DONE: ReadonlySet<string> = new Set<Outcome>(['created', 'linked']);

export interface ImportRowView {
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
  readonly batch: { readonly id: string; readonly roleId: string; readonly roleTitle: string; readonly expiresAt: Date };
  readonly rows: readonly ImportRowView[];
}

const PREVIEW_SELECT = {
  id: true, rowKey: true, position: true, fullName: true, email: true, emailNormalized: true, phone: true, linkedinUrl: true,
  filename: true, readError: true, included: true, outcome: true, candidateId: true, error: true, resumeText: false,
} as const;

type PreviewRow = Omit<CandidateImportRow, 'resumeText' | 'batchId' | 'tenantId' | 'contentType' | 'cvAttached' | 'updatedAt'> & { hasCv: boolean };

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

export async function createImportBatch(auth: AuthClaims, roleId: string) {
  await assertCanAccessRole(auth, roleId);
  await assertRoleOpen(roleId);
  const now = new Date();
  const open = await prisma.candidateImportBatch.count({ where: { tenantId: auth.tenantId, createdById: auth.userId, expiresAt: { gt: now } } });
  if (open >= MAX_OPEN_BATCHES) {
    throw new HttpError(409, `You have ${open} imports still open. Finish or discard one before starting another.`);
  }
  const batch = await prisma.candidateImportBatch.create({
    data: { tenantId: auth.tenantId, roleId, createdById: auth.userId, expiresAt: new Date(now.getTime() + IMPORT_TTL_MS) },
  });
  await logAudit({ tenantId: auth.tenantId, actorId: auth.userId, actorType: 'user', action: 'candidate_import.started', entityType: 'CandidateImportBatch', entityId: batch.id, after: { roleId } });
  return batch;
}

/** The caller's own, unexpired batch; anything else is not found, never forbidden. */
async function ownBatch(auth: AuthClaims, batchId: string) {
  const batch = await prisma.candidateImportBatch.findFirst({
    where: { id: batchId, tenantId: auth.tenantId, createdById: auth.userId, expiresAt: { gt: new Date() } },
  });
  if (!batch) throw new HttpError(404, 'This import was not found. It may have expired; start a new one.');
  return batch;
}

export async function discardImportBatch(auth: AuthClaims, batchId: string): Promise<void> {
  const batch = await ownBatch(auth, batchId);
  await prisma.$transaction([
    prisma.candidateImportRow.deleteMany({ where: { batchId: batch.id } }),
    prisma.candidateImportBatch.delete({ where: { id: batch.id } }),
  ]);
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

interface StagedPerson extends CsvPerson {
  readonly filename?: string;
  readonly contentType?: string;
  readonly resumeText?: string | null;
  readonly readError?: string;
}

const inertName = (value: string): string => value.replace(/^[=+\-@]+/, '').trim().slice(0, 200);

async function stageRows(auth: AuthClaims, batchId: string, people: readonly StagedPerson[]): Promise<void> {
  const batch = await ownBatch(auth, batchId);
  await prisma.$transaction(async (tx) => {
    const already = await tx.candidateImportRow.count({ where: { batchId: batch.id } });
    if (already + people.length > MAX_IMPORT_ROWS) {
      throw new HttpError(400, `An import can hold at most ${MAX_IMPORT_ROWS} people; this would make ${already + people.length}.`);
    }
    await tx.candidateImportRow.createMany({
      data: people.map((person, index) => {
        const position = already + index + 1;
        return {
          batchId: batch.id, tenantId: auth.tenantId, rowKey: `r${position}`, position,
          fullName: inertName(person.fullName), email: person.email.trim().slice(0, 254),
          emailNormalized: normalizeEmail(person.email).slice(0, 254), phone: person.phone.slice(0, 40),
          linkedinUrl: normalizeLinkedinUrl(person.linkedinUrl),
          filename: person.filename ?? '', contentType: person.contentType ?? '',
          resumeText: person.resumeText ?? null, readError: person.readError ?? '',
        };
      }),
    });
  });
}

export async function stageCsv(auth: AuthClaims, batchId: string, text: string): Promise<void> {
  const parsed = parseCandidateCsv(text);
  if (!parsed.ok) throw new HttpError(400, parsed.error);
  await stageRows(auth, batchId, parsed.rows);
}

export interface UploadedCv {
  readonly buffer: Buffer;
  readonly mimetype: string;
  readonly originalname: string;
}

/** Each CV is read on its own; one that cannot be read becomes a row saying so, not a failed upload. */
async function readCv(file: UploadedCv): Promise<StagedPerson> {
  const filename = sanitizeFilename(file.originalname);
  const blank = { fullName: '', email: '', phone: '', linkedinUrl: '', filename, contentType: file.mimetype };
  try {
    const text = await readResumeFile(file);
    if (!text.trim()) return { ...blank, readError: 'No text was found in this file.' };
    return { ...extractContact(text, filename), filename, contentType: file.mimetype, resumeText: text };
  } catch (err) {
    return { ...blank, readError: err instanceof HttpError ? err.message : 'Could not read this file.' };
  }
}

export async function stageCvs(auth: AuthClaims, batchId: string, files: readonly UploadedCv[]): Promise<void> {
  await ownBatch(auth, batchId);
  const people: StagedPerson[] = [];
  // One at a time: parsers can expand a small file a long way in memory.
  for (const file of files) people.push(await readCv(file));
  await stageRows(auth, batchId, people);
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

async function batchRows(batchId: string): Promise<PreviewRow[]> {
  const rows = await prisma.candidateImportRow.findMany({ where: { batchId }, orderBy: { position: 'asc' }, select: PREVIEW_SELECT });
  const withCv = new Set((await prisma.candidateImportRow.findMany({ where: { batchId, resumeText: { not: null } }, select: { id: true } })).map((r) => r.id));
  return rows.map((row) => ({ ...row, hasCv: withCv.has(row.id) }));
}

/** Who is already on the role (tenant-wide, as Add candidate checks) and who the caller can see elsewhere. */
async function previewContext(auth: AuthClaims, roleId: string, addresses: readonly string[]) {
  const wanted = [...new Set(addresses.filter(Boolean))];
  if (wanted.length === 0) return { onRole: new Map<string, string>(), known: new Map<string, string>() };
  const [onRoleRows, knownRows] = await Promise.all([
    prisma.candidate.findMany({ where: { tenantId: auth.tenantId, roleId, emailNormalized: { in: wanted } }, select: { id: true, emailNormalized: true }, orderBy: { createdAt: 'asc' } }),
    prisma.candidate.findMany({
      where: { AND: [(await candidateScope(auth)) as Prisma.CandidateWhereInput, { emailNormalized: { in: wanted } }, { NOT: { roleId } }] },
      select: { id: true, emailNormalized: true, _count: { select: { profiles: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
  ]);
  const onRole = onRoleRows.reduce((m, r) => (m.has(r.emailNormalized) ? m : new Map(m).set(r.emailNormalized, r.id)), new Map<string, string>());
  // The newest application with a resume is the one worth copying, as on "Set up for another role".
  const known = [...knownRows].sort((a, b) => Number(b._count.profiles > 0) - Number(a._count.profiles > 0))
    .reduce((m, r) => (m.has(r.emailNormalized) ? m : new Map(m).set(r.emailNormalized, r.id)), new Map<string, string>());
  return { onRole, known };
}

async function verdictsFor(auth: AuthClaims, roleId: string, rows: readonly PreviewRow[]): Promise<Map<string, PreviewVerdict>> {
  const ctx = await previewContext(auth, roleId, rows.map((r) => r.emailNormalized));
  const verdicts = previewRows(rows.map((r) => ({ rowKey: r.rowKey, fullName: r.fullName, email: r.email, hasCv: r.hasCv, readError: r.readError, included: r.included })), ctx);
  return new Map(verdicts.map((v) => [v.rowKey, v]));
}

function toView(row: PreviewRow, verdict: PreviewVerdict): ImportRowView {
  return {
    rowKey: row.rowKey, position: row.position, fullName: row.fullName, email: row.email, phone: row.phone, linkedinUrl: row.linkedinUrl,
    filename: row.filename, hasCv: row.hasCv, included: row.included, status: verdict.status, message: verdict.message,
    ...(verdict.existingCandidateId ? { existingCandidateId: verdict.existingCandidateId } : {}),
    outcome: row.outcome, candidateId: row.candidateId, error: row.error,
  };
}

export async function previewImport(auth: AuthClaims, batchId: string): Promise<ImportPreview> {
  const batch = await ownBatch(auth, batchId);
  const role = await prisma.role.findFirst({ where: { id: batch.roleId, tenantId: auth.tenantId }, select: { title: true } });
  const rows = await batchRows(batch.id);
  const verdicts = await verdictsFor(auth, batch.roleId, rows);
  return {
    batch: { id: batch.id, roleId: batch.roleId, roleTitle: role?.title ?? '', expiresAt: batch.expiresAt },
    rows: rows.map((row) => toView(row, verdicts.get(row.rowKey)!)),
  };
}

export const rowEditSchema = z.object({
  fullName: z.string().max(200).optional(),
  email: z.string().max(254).optional(),
  included: z.boolean().optional(),
}).strict();

export async function editImportRow(auth: AuthClaims, batchId: string, rowKey: string, edit: z.infer<typeof rowEditSchema>): Promise<void> {
  const batch = await ownBatch(auth, batchId);
  const row = await prisma.candidateImportRow.findUnique({ where: { batchId_rowKey: { batchId: batch.id, rowKey } }, select: { id: true, outcome: true } });
  if (!row) throw new HttpError(404, 'That row is not in this import.');
  if (DONE.has(row.outcome) || row.outcome === 'working') throw new HttpError(409, 'This person has already been added, so the row can no longer change.');
  await prisma.candidateImportRow.update({
    where: { id: row.id },
    data: {
      ...(edit.fullName !== undefined ? { fullName: inertName(edit.fullName) } : {}),
      ...(edit.email !== undefined ? { email: edit.email.trim(), emailNormalized: normalizeEmail(edit.email) } : {}),
      ...(edit.included !== undefined ? { included: edit.included } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

export interface ConfirmedRow {
  readonly rowKey: string;
  readonly outcome: string;
  readonly candidateId: string | null;
  readonly error: string;
  /** The candidate's latest interview, for the invite step; only for candidates the caller may see. */
  readonly interview: { readonly id: string; readonly state: string } | null;
}

/** Take the row for this request, so two confirms at once never both work on it. */
async function claimRow(rowId: string): Promise<boolean> {
  const stale = new Date(Date.now() - STALE_WORK_MS);
  const { count } = await prisma.candidateImportRow.updateMany({
    where: { id: rowId, OR: [{ outcome: { in: ['pending', 'failed'] } }, { outcome: 'working', updatedAt: { lt: stale } }] },
    data: { outcome: 'working', error: '' },
  });
  return count === 1;
}

const callerMessage = (err: unknown, fallback: string): string => (err instanceof HttpError ? err.message : fallback);

interface RowWork {
  readonly auth: AuthClaims;
  readonly roleId: string;
  readonly row: CandidateImportRow;
  readonly verdict: PreviewVerdict;
}

/** Adds one person, resuming wherever an earlier attempt stopped. */
async function importRow({ auth, roleId, row, verdict }: RowWork): Promise<void> {
  let candidateId = row.candidateId;
  let outcome: Outcome = 'created';
  if (!candidateId && verdict.status === 'existing') {
    await prisma.candidateImportRow.update({ where: { id: row.id }, data: { outcome: 'linked', candidateId: verdict.existingCandidateId ?? null } });
    return;
  }
  if (!candidateId && verdict.status === 'known' && row.resumeText === null && verdict.knownCandidateId) {
    // No CV of their own: carry over the latest one they already have, as "Set up for another role" does.
    const applied = await applyCandidateToRole(auth, verdict.knownCandidateId, roleId);
    const id = applied.kind === 'created' ? applied.candidate.id : applied.candidateId;
    await prisma.candidateImportRow.update({ where: { id: row.id }, data: { outcome: applied.kind === 'created' ? 'created' : 'linked', candidateId: id, cvAttached: applied.kind === 'created' && applied.profileCopied } });
    return;
  }
  if (!candidateId) {
    const made = await createApplication(auth, { roleId, fullName: row.fullName, email: row.email, phone: row.phone, linkedinUrl: row.linkedinUrl }, {
      onCreated: async (tx, candidate) => { await tx.candidateImportRow.update({ where: { id: row.id }, data: { candidateId: candidate.id } }); },
    });
    candidateId = made.kind === 'created' ? made.candidate.id : made.candidateId;
    if (made.kind === 'exists') outcome = 'linked';
  }
  if (outcome === 'created' && row.resumeText && !row.cvAttached) {
    try {
      await attachResume(auth, { id: candidateId, roleId }, { rawText: row.resumeText, filename: row.filename || 'resume.txt', contentType: row.contentType || 'text/plain' }, {
        onStored: async (tx) => { await tx.candidateImportRow.update({ where: { id: row.id }, data: { cvAttached: true } }); },
      });
    } catch (err) {
      if (!(err instanceof HttpError)) logger.error({ err: err instanceof Error ? err.message : String(err), rowId: row.id }, 'bulk import CV could not be attached');
      await prisma.candidateImportRow.update({ where: { id: row.id }, data: { outcome: 'failed', candidateId, error: `Added, but the CV could not be attached: ${callerMessage(err, 'unexpected error')}. Try again to attach it.` } });
      return;
    }
  }
  await prisma.candidateImportRow.update({ where: { id: row.id }, data: { outcome, candidateId } });
}

export const confirmSchema = z.object({ rowKeys: z.array(z.string().min(1).max(16)).min(1).max(MAX_CONFIRM_ROWS) }).strict();

/**
 * Add the named rows. Rows already done answer with what was done; a failed
 * row is retried; a row that is unticked or needs a fix is left alone. Safe to
 * repeat: batch id plus row key identifies each person's attempt.
 */
export async function confirmImport(auth: AuthClaims, batchId: string, rowKeys: readonly string[]): Promise<ConfirmedRow[]> {
  const batch = await ownBatch(auth, batchId);
  await assertCanAccessRole(auth, batch.roleId);
  await assertRoleOpen(batch.roleId);
  // Verdicts are decided over the whole batch: "duplicate in batch" depends on the other rows.
  const verdicts = await verdictsFor(auth, batch.roleId, await batchRows(batch.id));
  const wanted = new Set(rowKeys);
  const rows = await prisma.candidateImportRow.findMany({ where: { batchId: batch.id, rowKey: { in: [...wanted] } }, orderBy: { position: 'asc' } });

  for (const row of rows) {
    const verdict = verdicts.get(row.rowKey)!;
    if (DONE.has(row.outcome) || !row.included || !isImportable(verdict.status)) continue;
    if (!(await claimRow(row.id))) continue;
    try {
      await importRow({ auth, roleId: batch.roleId, row, verdict });
    } catch (err) {
      if (!(err instanceof HttpError)) logger.error({ err: err instanceof Error ? err.message : String(err), rowId: row.id }, 'bulk import row failed');
      await prisma.candidateImportRow.update({ where: { id: row.id }, data: { outcome: 'failed', error: callerMessage(err, 'This person could not be added. Try again.') } });
    }
  }

  const after = await prisma.candidateImportRow.findMany({ where: { batchId: batch.id, rowKey: { in: [...wanted] } }, orderBy: { position: 'asc' }, select: { rowKey: true, outcome: true, candidateId: true, error: true } });
  const interviews = await latestInterviews(auth, after.map((r) => r.candidateId).filter((id): id is string => id !== null));
  const done = after.filter((r) => DONE.has(r.outcome)).length;
  await logAudit({ tenantId: auth.tenantId, actorId: auth.userId, actorType: 'user', action: 'candidate_import.confirmed', entityType: 'CandidateImportBatch', entityId: batch.id, after: { rows: after.length, done, failed: after.filter((r) => r.outcome === 'failed').length } });
  return after.map((r) => ({ ...r, interview: r.candidateId ? interviews.get(r.candidateId) ?? null : null }));
}

async function latestInterviews(auth: AuthClaims, candidateIds: readonly string[]): Promise<Map<string, { id: string; state: string }>> {
  if (candidateIds.length === 0) return new Map();
  const visible = await prisma.candidate.findMany({ where: { AND: [(await candidateScope(auth)) as Prisma.CandidateWhereInput, { id: { in: [...candidateIds] } }] }, select: { id: true } });
  const sessions = await prisma.interviewSession.findMany({
    where: { tenantId: auth.tenantId, candidateId: { in: visible.map((c) => c.id) } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, state: true, candidateId: true },
  });
  return sessions.reduce((m, s) => (m.has(s.candidateId) ? m : new Map(m).set(s.candidateId, { id: s.id, state: s.state })), new Map<string, { id: string; state: string }>());
}

// ---------------------------------------------------------------------------
// Cleanup and erasure
// ---------------------------------------------------------------------------

export async function purgeExpiredImportBatches(now = new Date()): Promise<number> {
  const expired = await prisma.candidateImportBatch.findMany({ where: { expiresAt: { lte: now } }, select: { id: true } });
  if (expired.length === 0) return 0;
  const ids = expired.map((b) => b.id);
  await prisma.$transaction([
    prisma.candidateImportRow.deleteMany({ where: { batchId: { in: ids } } }),
    prisma.candidateImportBatch.deleteMany({ where: { id: { in: ids } } }),
  ]);
  return ids.length;
}

/** A person's staged rows, removed with the rest of their data when they are erased. */
export function eraseStagedImportRows(
  tx: Prisma.TransactionClient,
  o: { readonly tenantId: string; readonly candidateId: string; readonly emailNormalized: string },
) {
  const byAddress = o.emailNormalized ? [{ emailNormalized: o.emailNormalized }] : [];
  return tx.candidateImportRow.deleteMany({ where: { tenantId: o.tenantId, OR: [{ candidateId: o.candidateId }, ...byAddress] } });
}
