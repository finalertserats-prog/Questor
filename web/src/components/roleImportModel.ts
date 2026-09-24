import { ApiError } from '../api/client';

/** What POST /api/roles/import-file returns: the text, and what it came from. */
export interface JdImport {
  readonly text: string;
  readonly filename: string;
  readonly bytes: number;
  readonly characters: number;
  readonly truncated: boolean;
  /**
   * The extracted text reads as an instruction to a model. A flag, not a
   * refusal — the server sends the boolean and nothing else, so there is no
   * offending line to show and the page must not pretend there is one.
   */
  readonly injectionFlagged: boolean;
}

/** The types the server's extractor reads. Kept in step with JD_MIME_TYPES. */
export const JD_FILE_ACCEPT = '.pdf,.docx,.txt,.md,.markdown';

const KB = 1024;
const MB = 1024 * 1024;

/** The file's size as a person would say it. */
export function fileSizeLabel(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  // Below a kilobyte, rounding to kB reads as "0 kB" — which looks like a
  // failed upload rather than a short file.
  if (bytes >= KB) return `${Math.round(bytes / KB)} kB`;
  return `${bytes} bytes`;
}

/** A large file that yielded almost nothing was an image, not a document. */
const SCAN_SUSPECT_BYTES = 200 * KB;
const SCAN_SUSPECT_CHARS = 400;

/**
 * What is worth saying about an extraction before it becomes a job
 * description. Everything here is checkable from the numbers the server sent;
 * none of it repeats the text.
 */
export function extractionNotes(result: JdImport): string[] {
  const notes: string[] = [];
  if (result.truncated) {
    notes.push('This document was too long to read in full, so the end of it is missing. Check the text before creating the role.');
  }
  if (result.bytes >= SCAN_SUSPECT_BYTES && result.characters < SCAN_SUSPECT_CHARS) {
    notes.push('Very little text came out of a file this size, which usually means a scan or an image-only PDF. Paste the job description instead if the text below is wrong.');
  }
  if (result.injectionFlagged) {
    notes.push('Part of this file reads as an instruction to the AI rather than as a job description. Read it through and remove anything that does not belong before creating the role.');
  }
  return notes;
}

/** Why an upload was refused, in words that say what to do about it. */
export function jdImportMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'The file could not be read. Please try again, or paste the job description instead.';
}
