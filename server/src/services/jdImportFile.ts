import { HttpError } from '../middleware/index.js';
import { MAX_RESUME_TEXT_CHARS, extractJdText } from '../engines/resumeParser.js';
import { detectInjection } from '../engines/policyEngine.js';
import { sanitizeFilename } from './resumeFile.js';

/**
 * One uploaded job description, read once and handed back for a person to
 * check. Nothing here writes: the role is still created by POST /api/roles
 * with this text as `sourceText`, so the draft-and-approve flow is reached the
 * same way whether the words were pasted or extracted from a file.
 */
export interface JdImport {
  /** The extracted text, as the uploader will see and may correct it. */
  readonly text: string;
  readonly filename: string;
  readonly bytes: number;
  readonly characters: number;
  /** The extractor hit its ceiling, so the tail of the document is missing. */
  readonly truncated: boolean;
  /**
   * The text contains something that reads as an instruction to a model.
   *
   * A flag, not a refusal — see the endpoint's own note. Reported as a boolean
   * and nothing else: the matched line is never quoted back, and neither are
   * the detector's patterns, so nothing that tripped it is repeated anywhere a
   * log or a console would carry it.
   */
  readonly injectionFlagged: boolean;
}

export interface UploadedJdFile {
  readonly buffer: Buffer;
  readonly mimetype: string;
  readonly originalname: string;
}

export async function readJdFile(file: UploadedJdFile): Promise<JdImport> {
  const text = await extractJdText(file.buffer, file.mimetype);
  if (!text.trim()) {
    throw new HttpError(400, 'No job description text was found in that file. It may be a scan or an image-only PDF.');
  }

  return {
    text,
    filename: sanitizeFilename(file.originalname, 'job-description.txt'),
    bytes: file.buffer.length,
    // The two numbers are deliberately both shown: a 4 MB file that yields 300
    // characters is a scanned image, and the person needs to see that before
    // they interview anyone against those 300 characters.
    characters: text.length,
    // extractJdText slices at exactly the ceiling, so a result that long was
    // cut. A document of precisely that length reports the same, which is the
    // safe direction to be wrong in.
    truncated: text.length >= MAX_RESUME_TEXT_CHARS,
    // Screened with the same engine that screens organisation text on signup
    // (engines/policyEngine.ts) rather than a second, weaker rule.
    injectionFlagged: detectInjection(text).injection,
  };
}
