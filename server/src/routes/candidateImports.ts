import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { isResumeMimeType } from '../engines/resumeParser.js';
import { RESUME_MAX_BYTES } from '../services/resumeFile.js';
import {
  confirmImport,
  confirmSchema,
  createImportBatch,
  discardImportBatch,
  editImportRow,
  previewImport,
  rowEditSchema,
  stageCsv,
  stageCvs,
} from '../services/candidateImport.js';

/**
 * Bulk import of candidates onto one role (services/candidateImport.ts):
 *
 *   POST   /                      start an import for a role
 *   POST   /:id/csv               add the people in one CSV file
 *   POST   /:id/cvs               add up to CVS_PER_REQUEST CV files
 *   GET    /:id                   the preview, one row per person
 *   PATCH  /:id/rows/:rowKey      fix a name or address, tick or untick
 *   POST   /:id/confirm           add the named rows (idempotent)
 *   DELETE /:id                   discard the import
 *
 * All of it is adding candidates, so all of it needs candidate:create; a
 * hiring manager holds no such capability and never sees the controls.
 * Inviting afterwards goes through POST /api/interviews/bulk-invite.
 */

export const candidateImportsRouter = Router();
candidateImportsRouter.use(authenticate, requireCapability('candidate:create'));

/** CVs per upload request: the browser sends a large set in several, so no one request holds much in memory. */
export const CVS_PER_REQUEST = 5;
const CSV_MAX_BYTES = 1024 * 1024;
// What browsers and spreadsheet programs send for a .csv; the content is checked regardless.
const CSV_TYPES = new Set(['text/csv', 'application/csv', 'text/x-csv', 'application/vnd.ms-excel', 'text/plain', 'text/comma-separated-values']);

const byUser = (req: Request): string => req.auth?.userId ?? req.ip ?? 'unknown';
const startLimit = rateLimit({ name: 'candidate-import-start', windowMs: 15 * 60_000, max: 30, keyOf: byUser });
// A full batch of 200 CVs is 40 requests; parsing is the expensive part.
const uploadLimit = rateLimit({ name: 'candidate-import-upload', windowMs: 15 * 60_000, max: 90, keyOf: byUser });
const editLimit = rateLimit({ name: 'candidate-import-edit', windowMs: 15 * 60_000, max: 600, keyOf: byUser });
const confirmLimit = rateLimit({ name: 'candidate-import-confirm', windowMs: 15 * 60_000, max: 60, keyOf: byUser });

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CSV_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!CSV_TYPES.has(file.mimetype)) {
      cb(new HttpError(400, 'Only a CSV file is accepted here. Save the spreadsheet as CSV and try again.'));
      return;
    }
    cb(null, true);
  },
});

const cvUpload = multer({
  storage: multer.memoryStorage(),
  // The same per-file limit and types as the single resume upload.
  limits: { fileSize: RESUME_MAX_BYTES, files: CVS_PER_REQUEST },
  fileFilter: (_req, file, cb) => {
    if (!isResumeMimeType(file.mimetype)) {
      cb(new HttpError(400, `${file.originalname ? 'One of the files' : 'A file'} is not a PDF, DOCX or plain-text CV.`));
      return;
    }
    cb(null, true);
  },
});

/** Multer's own refusals are not HttpErrors; without this they would reach the client as a 500. */
function multerErrors(handler: (req: Request, res: Response, cb: (err: unknown) => void) => void, sizeText: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        next(new HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? `Upload rejected: a file exceeds the ${sizeText} limit.` : `Upload rejected: too many files in one request (at most ${CVS_PER_REQUEST}).`));
        return;
      }
      next(err);
    });
  };
}

const idParams = z.object({ id: z.string().min(1).max(64) });
const rowParams = idParams.extend({ rowKey: z.string().min(1).max(16) });
const startSchema = z.object({ roleId: z.string().min(1).max(64) }).strict();

candidateImportsRouter.post('/', startLimit, asyncHandler(async (req, res) => {
  const { roleId } = startSchema.parse(req.body ?? {});
  const batch = await createImportBatch(req.auth!, roleId);
  res.status(201).json({ batch: { id: batch.id, roleId: batch.roleId, expiresAt: batch.expiresAt } });
}));

candidateImportsRouter.post('/:id/csv', uploadLimit, multerErrors(csvUpload.single('file'), '1 MB'), asyncHandler(async (req, res) => {
  const { id } = idParams.parse(req.params);
  if (!req.file) throw new HttpError(400, 'Choose a CSV file to upload.');
  await stageCsv(req.auth!, id, req.file.buffer.toString('utf-8'));
  res.status(201).json(await previewImport(req.auth!, id));
}));

candidateImportsRouter.post('/:id/cvs', uploadLimit, multerErrors(cvUpload.array('files', CVS_PER_REQUEST), '5 MB'), asyncHandler(async (req, res) => {
  const { id } = idParams.parse(req.params);
  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length === 0) throw new HttpError(400, 'Choose at least one CV to upload.');
  await stageCvs(req.auth!, id, files);
  res.status(201).json(await previewImport(req.auth!, id));
}));

candidateImportsRouter.get('/:id', asyncHandler(async (req, res) => {
  const { id } = idParams.parse(req.params);
  res.json(await previewImport(req.auth!, id));
}));

candidateImportsRouter.patch('/:id/rows/:rowKey', editLimit, asyncHandler(async (req, res) => {
  const { id, rowKey } = rowParams.parse(req.params);
  await editImportRow(req.auth!, id, rowKey, rowEditSchema.parse(req.body ?? {}));
  res.json(await previewImport(req.auth!, id));
}));

candidateImportsRouter.post('/:id/confirm', confirmLimit, asyncHandler(async (req, res) => {
  const { id } = idParams.parse(req.params);
  const { rowKeys } = confirmSchema.parse(req.body ?? {});
  res.json({ results: await confirmImport(req.auth!, id, rowKeys) });
}));

candidateImportsRouter.delete('/:id', editLimit, asyncHandler(async (req, res) => {
  const { id } = idParams.parse(req.params);
  await discardImportBatch(req.auth!, id);
  res.status(204).end();
}));
