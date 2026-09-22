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
 * The stored filename is echoed back into the reviewer's browser, so strip any
 * path the client smuggled in and keep only characters that cannot be read as
 * markup or as a traversal segment.
 */
export function sanitizeFilename(original: string): string {
  const cleaned = path
    .basename(original)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || 'resume.txt';
}

/**
 * The file's text. extractResumeText already reports why it refused a file;
 * only genuinely unexpected failures fall back to the generic FR-006 message.
 */
export async function readResumeFile(file: { readonly buffer: Buffer; readonly mimetype: string }): Promise<string> {
  try {
    return await extractResumeText(file.buffer, file.mimetype);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(422, UNREADABLE);
  }
}
