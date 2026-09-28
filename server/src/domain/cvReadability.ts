/**
 * Whether a file has a CV in it at all.
 *
 * `services/resumeFile.ts` already refuses an upload with NO text, because a
 * scanned photograph of a CV extracts as a handful of newlines and travels
 * silently: the upload reports success, the parser is handed nothing, and the
 * recruiter gets a candidate with no skills and a fit score built from air.
 *
 * This is the rung above. A document of rules, bullets, bars and spacing has
 * text — punctuation is text — so it passed that guard, reached the scorer,
 * and came back as 22 out of 100 with "Move to Silver" offered underneath. A
 * number computed from nothing is worse than no number, because it looks like
 * the others. Twenty-two out of a hundred is a judgement about a person, and
 * there was no person in the document.
 *
 * So: a CV is made of words. Not of a particular length, not in a particular
 * language, not with any heading we recognise — but of words. Three counts,
 * all of them language-neutral, all of them about the shape of the text and
 * not its content, and a document has to fail one of them outright to be
 * refused. Fail closed: refuse, say why, and let a person look.
 */

/** Runs of letters. `\p{L}` so Devanagari, Cyrillic and CJK count as writing. */
const LETTER = /\p{L}/gu;
const WORD = /\p{L}{2,}/gu;
const NON_SPACE = /\S/g;

export type UnreadableReason =
  /** Nothing but whitespace. */
  | 'no_text'
  /** Too few words to be anybody's history. */
  | 'too_few_words'
  /** Mostly punctuation and rules: a page of dividers, a form, a table skeleton. */
  | 'not_prose';

/**
 * Twelve words.
 *
 * Deliberately far below anything a CV contains, because this number's job is
 * NOT to have an opinion about how much a CV should say. The upload path
 * already carries a 120-character floor for length; this catches the case
 * that floor cannot see — an extraction that produced 120 characters of which
 * only a handful are words. Set any higher and it starts refusing real
 * documents: a genuine six-line CV is around eighteen words, and a recruiter
 * whose candidate wrote a short one is not making a mistake we should correct.
 */
const MIN_WORDS = 12;

/**
 * A third of the ink has to be letters. A page of rules and bullets scores
 * near zero; a dense table of dates and figures still clears it, and so does
 * a CV in a script that writes without spaces.
 */
const MIN_LETTER_DENSITY = 0.34;

/**
 * Enough writing to be a CV even when the word count says otherwise.
 *
 * `\p{L}{2,}` counts runs of letters, and Chinese, Japanese and Korean write
 * without spaces — a whole page of one can come back as a handful of runs. A
 * word floor alone would refuse a perfectly good CV for being written in a
 * script that does not put gaps in, which is a hiring harm aimed squarely at
 * one group of candidates. So a document with this many letters at full
 * density has cleared the only question the floor was asking.
 */
const LETTERS_WITHOUT_SPACES = 120;

interface Measured {
  readonly letters: number;
  readonly words: number;
  /** Letters as a share of everything that is not whitespace. */
  readonly density: number;
}

/**
 * `readable` passes all three checks: there is writing, there is enough of it,
 * and it is mostly words. That is what an UPLOADED FILE has to clear, because
 * a file failing any of them is a file whose extraction went wrong.
 *
 * `prose` is the weaker question, and the one that matters everywhere else: is
 * any of this writing at all? The two guard different things. A recruiter
 * pasting a short CV into the box has decided that is the document, and
 * refusing it on length would be us overruling them about their own
 * candidate — nothing was ever wrong with a short CV. A page of rules and
 * bullets is a different claim entirely: there is no candidate in it to be
 * short. So the length floor stays on the upload path, where it means "this
 * extraction failed", and `prose` is what every path enforces.
 *
 * A union rather than an optional `reason`, so a caller that has established
 * the document is bad gets the reason without asserting it is there.
 */
export type CvReadability =
  | (Measured & { readonly readable: true; readonly prose: true; readonly reason?: undefined })
  | (Measured & { readonly readable: false; readonly prose: boolean; readonly reason: UnreadableReason });

export function cvReadability(text: string): CvReadability {
  const letters = (text.match(LETTER) ?? []).length;
  const words = (text.match(WORD) ?? []).length;
  const ink = (text.match(NON_SPACE) ?? []).length;
  const density = ink === 0 ? 0 : letters / ink;
  const measured: Measured = { letters, words, density };
  // Density before count, and the order is load-bearing: a page of dashes has
  // zero words AND zero density, and "there was very little text in that
  // file" would send someone hunting for a longer version of a document that
  // has no writing in it at all.
  if (ink === 0) return { readable: false, prose: false, reason: 'no_text', ...measured };
  if (density < MIN_LETTER_DENSITY) return { readable: false, prose: false, reason: 'not_prose', ...measured };
  const enoughWriting = words >= MIN_WORDS || letters >= LETTERS_WITHOUT_SPACES;
  if (!enoughWriting) return { readable: false, prose: true, reason: 'too_few_words', ...measured };
  return { readable: true, prose: true, ...measured };
}

export function hasReadableText(text: string): boolean {
  return cvReadability(text).readable;
}

/** Whether the document is made of words, whatever else is wrong with it. */
export function isProse(text: string): boolean {
  return cvReadability(text).prose;
}

/**
 * What the person who uploaded it is told. Names the shape of the problem so
 * they know whether to find a different file or paste the text, and never
 * says anything about the candidate — at this point we have not read one.
 */
export function unreadableCvMessage(reason: UnreadableReason): string {
  switch (reason) {
    case 'no_text':
      return 'This file has no text in it — it looks like a scan or a photo of the CV rather than a text document. '
        + 'Upload a PDF or DOCX saved from a word processor, or paste the CV text instead.';
    case 'too_few_words':
      return 'There was very little text in that file. Check it is the right document, or paste the CV text instead.';
    case 'not_prose':
      return 'That file is almost all spacing and punctuation, with no readable CV text in it. '
        + 'Check it is the right document — a scan, a form or a cover page will do this — or paste the CV text instead.';
  }
}
