import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { asyncHandler, authenticate, requireCapability, HttpError } from '../middleware/index.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { isJdMimeType } from '../engines/resumeParser.js';
import { RESUME_MAX_BYTES } from '../services/resumeFile.js';
import { readJdFile } from '../services/jdImportFile.js';
import { assertDemoCreationCap } from '../services/demoAccess.js';

/**
 * POST /api/roles/import-file — the job description as a file.
 *
 * It extracts text and returns it. It does NOT create the role: the page shows
 * what came out of the document beside what the document was, the person
 * corrects it if the parser misread a column or a table, and the existing
 * POST /api/roles then runs with that text as `sourceText`. So the
 * draft-and-approve flow is untouched, and no requisition is ever written from
 * an extraction nobody read.
 *
 * It lives in its own file rather than in routes/roles.ts because it shares
 * nothing with the routes there but its mount path.
 */
export const roleImportRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  // Same ceiling as an uploaded CV, for the same reason: the buffer lives in
  // process memory, and one file per request keeps a single upload from
  // fanning out into repeated parses.
  limits: { fileSize: RESUME_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    // The list this reads is the one the extractor dispatches on
    // (engines/resumeParser.ts), so the gate and the parser cannot drift.
    if (!isJdMimeType(file.mimetype)) {
      cb(new HttpError(400, 'Only PDF, DOCX, TXT or Markdown job descriptions are accepted'));
      return;
    }
    cb(null, true);
  },
});

// Multer rejections (size cap, file count) are not HttpErrors, so without this
// a rejected upload would be reported to the client as a 500.
function uploadJd(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      next(new HttpError(400, `Upload rejected: ${err.code === 'LIMIT_FILE_SIZE' ? 'file exceeds the 5 MB limit' : 'only a single job description file is accepted'}`));
      return;
    }
    next(err);
  });
}

// Parsing a document costs CPU and memory but no model spend, so this sits a
// little above the create limit it feeds: re-reading a file after fixing the
// extraction is normal, creating thirty roles is not.
const importLimit = rateLimit({
  name: 'role-import-file', windowMs: 15 * 60_000, max: 60,
  keyOf: (req) => req.auth?.userId ?? req.ip ?? 'unknown',
});

/**
 * Gated as the creation it is a step of: `role:create`, the caller's own
 * tenant (taken from the token, never the request), and the demo cap, checked
 * before anything is parsed so a capped tenant cannot spend the server's
 * memory on documents it could not turn into a role anyway.
 *
 * An injection hit FLAGS, it does not refuse. Signup refuses because an
 * organisation name is one short line that reaches a model's context unread by
 * anyone — there, a refusal is the only gate there is. Here the opposite holds:
 * the extraction is returned to the person who uploaded it, is stored nowhere,
 * reaches no model, and cannot become a job description until they have read
 * it on screen and pressed Create. They are the gate, so the server's job is
 * to point at the problem rather than to swallow the document — a refusal
 * would also be unfixable, since a real JD containing "disregard the above" in
 * prose would be rejected with no way to see what tripped it. What is refused
 * is echoing the offending line: the flag is a boolean and nothing more.
 */
roleImportRouter.post(
  '/import-file',
  authenticate,
  requireCapability('role:create'),
  importLimit,
  uploadJd,
  asyncHandler(async (req, res) => {
    await assertDemoCreationCap(req.auth!.tenantId, 'roles');
    if (!req.file) throw new HttpError(400, 'Choose a job description file to import.');
    res.json(await readJdFile(req.file));
  }),
);
