import path from 'node:path';
import { HttpError } from '../middleware/index.js';
import { extractResumeText } from '../engines/resumeParser.js';

/**
 * One uploaded resume file, read the same way wherever it arrives: the single
 * upload on a candidate and each CV in a bulk import.
 */

/** Buffers live in process memory, so the ceiling is far below anything a genuine resume needs. */
export const RESUME_MAX_BYTES = 5 * 1024 * 1024;

const UNREADABLE = 'Could not read the uploaded file. Please upload a text-based PDF, DOCX, or paste the resume text.';

/**
 * A CV shorter than this is not a CV. The failures this catches return single
 * digits, not hundreds: a scanned PDF extracts as a handful of newlines.
 */
const MIN_RESUME_CHARS = 120;

const SCANNED =
  'This file has no text in it — it looks like a scan or a photo of the CV rather than a text document. '
  + 'Upload a PDF or DOCX saved from a word processor, or paste the CV text instead.';

const TOO_SHORT =
  'There was very little text in that file. Check it is the right document, or paste the CV text instead.';

/**
 * The stored filename is echoed back into the reviewer's browser, so strip any
 * path the client smuggled in and keep only characters that cannot be read as
 * markup or as a traversal segment.
 */
export function sanitizeFilename(original: string, fallback = 'resume.txt'): string {
  const cleaned = path
    .basename(original)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || fallback;
}

/**
 * The file's text. extractResumeText already reports why it refused a file;
 * only genuinely unexpected failures fall back to the generic FR-006 message.
 *
 * Extraction can also succeed and produce nothing, which is worse than
 * failing, because nothing throws. A scanned CV — a photo, or a PDF exported
 * as pictures — has no text layer: pdf-parse reports its pages and returns a
 * handful of newlines. Left alone that silence travels. The upload reports
 * success, the parser is handed an empty string, and the recruiter gets a
 * candidate with no skills, no history and a fit score built from nothing,
 * while the one fact that would help — that this file is a picture — is the
 * one thing nobody is told.
 */
export async function readResumeFile(file: { readonly buffer: Buffer; readonly mimetype: string }): Promise<string> {
  let text: string;
  try {
    text = await extractResumeText(file.buffer, file.mimetype);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(422, UNREADABLE);
  }
  const trimmed = text.trim();
  if (!trimmed) throw new HttpError(422, SCANNED);
  if (trimmed.length < MIN_RESUME_CHARS) throw new HttpError(422, TOO_SHORT);
  return text;
}
