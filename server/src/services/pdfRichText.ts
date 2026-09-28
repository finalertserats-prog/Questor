/**
 * Mixed-weight text, laid out by hand.
 *
 * The certificate's claim line is centred and changes weight mid-sentence
 * ("Completed Questor's **Silver** assessment for **Senior Marketing
 * Manager**."), and its evidence rows do the same with the names of the people
 * involved. pdfkit's `continued: true` chains the runs but decides alignment
 * per fragment rather than per finished line, so a centred chain comes out
 * with each bold word centred against the column instead of sitting in the
 * sentence.
 *
 * Measuring the words ourselves and placing each line is duller and exact.
 */

export interface TextRun {
  readonly text: string;
  readonly font: string;
  readonly size: number;
  readonly colour: string;
  /** Lifts a fragment off the baseline, for the claim line's asterisk. */
  readonly rise?: number;
}

interface Word {
  readonly text: string;
  readonly run: TextRun;
  readonly width: number;
  readonly space: number;
}

interface Line {
  readonly words: readonly Word[];
  readonly width: number;
}

function measure(doc: PDFKit.PDFDocument, text: string, run: TextRun): number {
  return doc.font(run.font).fontSize(run.size).widthOfString(text);
}

/**
 * Splits runs into words and packs them into lines no wider than `width`.
 *
 * Trailing space is carried on the word it follows rather than emitted as its
 * own token, so a line break never leaves a stranded space that shifts a
 * centred line off-centre by a space's width.
 */
export function layoutRuns(doc: PDFKit.PDFDocument, runs: readonly TextRun[], width: number): readonly Line[] {
  const words: Word[] = [];
  for (const run of runs) {
    const pieces = run.text.split(/(\s+)/).filter((piece) => piece !== '');
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i];
      if (/^\s+$/.test(piece)) {
        const previous = words[words.length - 1];
        if (previous) words[words.length - 1] = { ...previous, space: measure(doc, ' ', previous.run) };
        continue;
      }
      words.push({ text: piece, run, width: measure(doc, piece, run), space: 0 });
    }
  }

  const lines: Line[] = [];
  let current: Word[] = [];
  let used = 0;
  for (const word of words) {
    const lead = current.length ? current[current.length - 1].space : 0;
    if (current.length && used + lead + word.width > width) {
      lines.push({ words: current, width: used });
      current = [word];
      used = word.width;
      continue;
    }
    current.push(word);
    used += lead + word.width;
  }
  if (current.length) lines.push({ words: current, width: used });
  return lines;
}

export type Align = 'left' | 'centre';

/**
 * Draws laid-out lines and answers the y the next block may start at.
 *
 * Consecutive words in the same run are written as one string, spaces and all,
 * rather than one call a word. Drawn word by word, each one becomes its own
 * positioned text item with no space between them in the content stream, and
 * the file then extracts as "CompletedQuestor'sSilverassessment" — which is
 * what a screen reader would read out and what a search for the role title
 * would fail to find. The whole point of rendering this as vector text rather
 * than as a picture is that it survives being read by something other than a
 * pair of eyes.
 */
export function drawLines(
  doc: PDFKit.PDFDocument,
  lines: readonly Line[],
  options: { readonly x: number; readonly y: number; readonly width: number; readonly leading: number; readonly align: Align },
): number {
  let y = options.y;
  for (const line of lines) {
    let x = options.align === 'centre' ? options.x + (options.width - line.width) / 2 : options.x;
    let i = 0;
    while (i < line.words.length) {
      const { run } = line.words[i];
      let text = '';
      let width = 0;
      while (i < line.words.length && line.words[i].run === run) {
        const word = line.words[i];
        text += word.text;
        width += word.width;
        if (i < line.words.length - 1 && word.space > 0) {
          text += ' ';
          width += word.space;
        }
        i += 1;
      }
      doc.font(run.font).fontSize(run.size).fillColor(run.colour).text(text, x, y - (run.rise ?? 0), { lineBreak: false });
      x += width;
    }
    y += options.leading;
  }
  return y;
}

/** How tall `layoutRuns` output will be, before anything is drawn. */
export function heightOfLines(lines: readonly Line[], leading: number): number {
  return lines.length * leading;
}

/**
 * `**bold**` fragments in a stored string, as runs.
 *
 * The evidence rows are frozen at award time and the award lane writes the
 * names of the people involved emphasised, the way the approved design shows
 * them. A string with no markers is simply one regular run, so a lane that
 * writes plain prose still renders correctly rather than printing asterisks.
 */
export function emphasised(
  text: string,
  fonts: { readonly regular: string; readonly bold: string },
  size: number,
  colour: string,
): readonly TextRun[] {
  return text
    .split(/\*\*(.+?)\*\*/g)
    .map((piece, index) => ({ text: piece, font: index % 2 ? fonts.bold : fonts.regular, size, colour }))
    .filter((run) => run.text !== '');
}
