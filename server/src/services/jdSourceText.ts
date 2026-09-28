import { HttpError } from '../middleware/index.js';
import { detectInjection } from '../engines/policyEngine.js';

/**
 * The gate between an uploaded file and a job description.
 *
 * Extraction can succeed and still produce nothing. A real example, three
 * pages and two megabytes: `/Font 0`, `/Image 10`, five JPEG streams — a
 * scanned or exported-as-picture advert with no text layer at all. pdf-parse
 * reports three pages and returns six newline characters. Nothing threw.
 *
 * Left alone, that silence travels: the importer reports success, the
 * extractor is handed an empty string, and the person either sees a blank box
 * or a scorecard built from nothing. The one thing they are never told is the
 * only thing that would help — that their PDF is a picture of a job
 * description, and that they should paste the text instead.
 *
 * So an empty extraction is an explicit, explained refusal. It is a refusal
 * with a diagnosis, because "could not read the file" sends someone back to
 * re-upload the same file.
 */

/**
 * Shorter than this and there is no job description here worth extracting
 * from. A genuine advert — even a terse internal one — runs to several
 * hundred characters; the failures this catches return single digits.
 */
export const MIN_JD_CHARS = 200;

/** Enough words that the text is prose rather than a page header OCR'd by accident. */
const MIN_JD_WORDS = 30;

const SCANNED =
  'This file has no text in it — it looks like a scan or a picture of the job description rather than a text document. ' +
  'Copy the text and paste it in, or upload a PDF or DOCX that was saved from a word processor.';

const TOO_SHORT =
  'There was very little text in that file. Check it is the right document, or paste the job description text instead.';

export interface JdTextIntake {
  readonly text: string;
  readonly characters: number;
  readonly words: number;
  /** True when the text contains instruction-like content aimed at the model. */
  readonly injectionFlagged: boolean;
}

/**
 * Accept extracted text as a job description, or refuse it and say why.
 *
 * The injection screen matches how organisation text is treated elsewhere: the
 * text is kept and flagged rather than refused, because an advert legitimately
 * containing "ignore the above" is far likelier than an attack, and every
 * prompt that later receives this text already states that it is data and not
 * instructions. What is never done is echo the matched text back — that would
 * put the payload in the reviewer's browser and in the logs.
 */
export function readJdText(raw: string): JdTextIntake {
  const text = raw.replace(/\r/g, '').trim();
  const words = text.split(/\s+/).filter(Boolean).length;

  // Distinguish "no text layer" from "a short document": they need different
  // advice, and the first is by far the more common and the more confusing.
  if (text.length === 0 || words === 0) throw new HttpError(422, SCANNED);
  if (text.length < MIN_JD_CHARS || words < MIN_JD_WORDS) throw new HttpError(422, TOO_SHORT);

  return {
    text,
    characters: text.length,
    words,
    injectionFlagged: detectInjection(text).injection,
  };
}
