import PDFDocument from 'pdfkit';
import { badgeShapes, rosette, type Paint, type Shape, type Tier } from './badgeGeometry.js';
import {
  BRONZE_ASSESSOR_NAME,
  claimFor,
  footnoteFor,
  kickerFor,
  whenLabel,
  type AwardEvidence,
  type CertificateTier,
} from './awardEvidence.js';
import { drawLines, emphasised, layoutRuns, type TextRun } from './pdfRichText.js';

/**
 * The Struck Seal — the certificate, as approved in
 * scratchpad/mockups/questor-credentials.html.
 *
 * A real, vector-text PDF: searchable, selectable, and legible to a screen
 * reader. Never a screenshot. This document exists to be read outside Questor,
 * by people who will never log in, and a picture of a certificate answers none
 * of the questions they will have about it.
 *
 * The structure is identical on Bronze, Silver and Gold — header, kicker,
 * name, rule, claim, five evidence rows, two signatures flanking the seal,
 * footnote — so that two of them can be held side by side and read as the same
 * document. Only the words differ, and on Bronze the INTERNAL watermark and
 * the "not for release" kicker.
 *
 * Only the standard-14 fonts are used, so no font file ships with the server
 * and every viewer renders the same glyphs. Cormorant Garamond maps to Times
 * and Archivo to Helvetica: the nearest faces of the right kind that are
 * guaranteed to exist everywhere this file will be opened.
 */

const PAGE = { width: 841.89, height: 595.28 } as const; // A4, landscape.
const PAD = 37;
const CONTENT_X = PAD;
const CONTENT_W = PAGE.width - PAD * 2;

const PAPER = '#f7f7f4';
const INK = { r: 23, g: 34, b: 60 } as const; // #17223c

/**
 * The ink at a given strength, already mixed with the paper.
 *
 * The design's faintest marks — the Q at 1.8%, the guilloché at 11%, INTERNAL
 * at 3.2% — are set in CSS as *group* opacity, which composites the whole
 * ornament first and only then fades it. Real alpha in a PDF fades each shape
 * separately, so the Q's white counters would stop punching through its dark
 * bubble and the overlapping lobes of a rosette would darken where they cross.
 *
 * Because the backdrop here is one flat sheet of paper, mixing the colour up
 * front reproduces group opacity exactly rather than approximately — and
 * leaves a file with no transparency in it at all, which prints and flattens
 * the same way in every viewer.
 */
function blend(alpha: number): string {
  const paper = { r: 247, g: 247, b: 244 };
  const at = (ink: number, sheet: number) => Math.round(sheet + alpha * (ink - sheet));
  const hex = (value: number) => value.toString(16).padStart(2, '0');
  return `#${hex(at(INK.r, paper.r))}${hex(at(INK.g, paper.g))}${hex(at(INK.b, paper.b))}`;
}

const FONT = {
  display: 'Times-Bold',
  displayLight: 'Times-Roman',
  sans: 'Helvetica',
  sansBold: 'Helvetica-Bold',
  mono: 'Courier',
} as const;

/** Sizes and gaps, scaled once from the approved mockup's 1148px-wide card. */
const TYPE = {
  wordmark: 15.4,
  wordmarkTracking: 4.6,
  ref: 7,
  refLeading: 11.9,
  kicker: 7.7,
  kickerTracking: 1.85,
  name: 38,
  claim: 14,
  claimLeading: 21.7,
  evidenceHeading: 7,
  evidence: 9.5,
  evidenceLeading: 13.8,
  signatureName: 11.7,
  signatureRole: 7,
  footnote: 6.6,
} as const;

/** The vertical air between blocks. Compressed together if a page runs long. */
const GAP = {
  headerToBody: 28,
  kickerToName: 13.2,
  nameToRule: 13.2,
  ruleToClaim: 14.7,
  claimToEvidence: 23.5,
  evidencePad: 13.2,
  headingToRows: 7.3,
  rowPad: 2.9,
  evidenceToFooter: 26.4,
  footerToFootnote: 16.1,
  footnotePad: 8.1,
} as const;

const SEAL = 80;
const EVIDENCE_W = 440;
const RULE_W = 249;

/**
 * The claim line's measure, in characters, as the approved design sets it.
 *
 * Expressed as 46 characters rather than as a number of points because that is
 * the design's own rule, and the two faces are not the same width: hard-coding
 * the pixel measure the mockup happens to produce in Cormorant would give
 * Times a different line length than the design asks for.
 */
const CLAIM_CH = 46;

export interface CertificateInput {
  readonly tier: CertificateTier;
  readonly reference: string;
  /** Printed as-is. Never derived from the reference — see the route. */
  readonly verifyUrl: string;
  readonly issuedAt: Date;
  readonly evidence: AwardEvidence;
}

/** "24 September 2026" — the form the approved design prints. */
export function issuedOn(at: Date): string {
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function centredText(
  doc: PDFKit.PDFDocument,
  text: string,
  y: number,
  options: { readonly font: string; readonly size: number; readonly colour: string; readonly tracking?: number },
): void {
  const tracking = options.tracking ?? 0;
  doc.font(options.font).fontSize(options.size).fillColor(options.colour);
  const width = doc.widthOfString(text, { characterSpacing: tracking });
  doc.text(text, CONTENT_X + (CONTENT_W - width) / 2, y, { lineBreak: false, characterSpacing: tracking });
}

function horizontalRule(doc: PDFKit.PDFDocument, x: number, y: number, width: number, colour: string): void {
  doc.save().strokeColor(colour).lineWidth(0.75).moveTo(x, y).lineTo(x + width, y).stroke().restore();
}

/** The mockup's rule under the name fades out at both ends rather than stopping. */
function fadedRule(doc: PDFKit.PDFDocument, y: number): void {
  const x = CONTENT_X + (CONTENT_W - RULE_W) / 2;
  const gradient = doc.linearGradient(x, y, x + RULE_W, y);
  gradient.stop(0, PAPER).stop(0.5, blend(0.4)).stop(1, PAPER);
  doc.save().rect(x, y, RULE_W, 0.75).fill(gradient).restore();
}

function dottedRule(doc: PDFKit.PDFDocument, x: number, y: number, width: number): void {
  doc.save().strokeColor(blend(0.22)).lineWidth(0.5).dash(1, { space: 1.6 }).moveTo(x, y).lineTo(x + width, y).stroke().undash().restore();
}

// ---------------------------------------------------------------- ornament

/**
 * The guilloché corner engraving: hypotrochoids bleeding off the top-left and
 * bottom-right, clipped by the page edge exactly as the mockup clips them by
 * the card.
 */
function guilloche(doc: PDFKit.PDFDocument): void {
  const size = 0.2178 * PAGE.width;
  const scale = size / 220;
  const corners = [
    { x: -0.07 * PAGE.width, y: -0.16 * PAGE.height },
    { x: PAGE.width - size + 0.07 * PAGE.width, y: PAGE.height - size + 0.16 * PAGE.height },
  ];
  const curves: readonly (readonly [number, number, number, number])[] = [
    [70, 11, 46, 11],
    [54, 9, 34, 9],
    [38, 7, 24, 7],
  ];
  doc.save();
  doc.rect(0, 0, PAGE.width, PAGE.height).clip();
  for (const corner of corners) {
    curves.forEach(([outer, inner, offset, turns], index) => {
      const points = rosette(outer, inner, offset, turns, 110, 110, 1);
      doc.save().translate(corner.x, corner.y).scale(scale);
      doc.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) doc.lineTo(point.x, point.y);
      doc.strokeColor(blend(0.11 * (0.92 - index * 0.2))).lineWidth(0.6).stroke();
      doc.restore();
    });
  }
  doc.restore();
}

/**
 * The Questor Q at 1.8% — a bubble with three dots, from
 * web/public/brand/favicon.svg.
 *
 * The paper-coloured shapes are painted opaque on top of the blended ink,
 * which is what makes the counters read; see `blend` for why that is the
 * faithful reading of the design rather than a shortcut around it.
 */
function watermarkQ(doc: PDFKit.PDFDocument): void {
  const width = 0.331 * PAGE.width;
  const scale = width / 64;
  const ink = blend(0.018);
  doc.save();
  doc.translate((PAGE.width - width) / 2, (PAGE.height - width) / 2).scale(scale);
  doc.circle(31.43, 29.25, 28.25).fill(ink);
  const tail: readonly (readonly [number, number])[] = [
    [43.85, 35.45], [60.5, 52.1], [60.8, 54.9], [58.5, 60.2], [55, 62.5], [52.7, 63], [49.5, 62.1], [48.45, 61.23], [33.26, 46.04],
  ];
  doc.moveTo(tail[0][0], tail[0][1]);
  for (const [x, y] of tail.slice(1)) doc.lineTo(x, y);
  doc.fill(ink);
  doc.circle(31.34, 29.74, 16.24).fill(PAPER);
  const notch: readonly (readonly [number, number])[] = [[18.24, 36.29], [16.27, 46.43], [24.96, 43.53], [27.85, 38.27]];
  doc.moveTo(notch[0][0], notch[0][1]);
  for (const [x, y] of notch.slice(1)) doc.lineTo(x, y);
  doc.fill(PAPER);
  for (const cx of [22.46, 31.28, 40.08]) doc.circle(cx, 29.6, 3.35).fill(ink);
  doc.restore();
}

/**
 * INTERNAL, across the sheet.
 *
 * Set as real text rather than as artwork, so it is in the extracted text of
 * the file as well as on the face of it. A watermark disappears in a
 * black-and-white print and is invisible to a screen reader; the kicker says
 * the same thing in words for exactly that reason, and so does this.
 */
function watermarkInternal(doc: PDFKit.PDFDocument): void {
  const size = 67.5;
  const tracking = 14.85;
  doc.save();
  doc.rotate(-18, { origin: [PAGE.width / 2, PAGE.height / 2] });
  doc.font(FONT.sansBold).fontSize(size).fillColor(blend(0.032));
  const width = doc.widthOfString('INTERNAL', { characterSpacing: tracking });
  doc.text('INTERNAL', PAGE.width / 2 - width / 2, PAGE.height / 2 - size * 0.7, { lineBreak: false, characterSpacing: tracking });
  doc.restore();
}

function frame(doc: PDFKit.PDFDocument): void {
  doc.save().strokeColor(blend(0.34)).lineWidth(0.75)
    .rect(13, 13, PAGE.width - 26, PAGE.height - 26).stroke().restore();
  doc.save().strokeColor(blend(0.15)).lineWidth(0.75)
    .rect(17, 17, PAGE.width - 34, PAGE.height - 34).stroke().restore();
}

// -------------------------------------------------------------------- seal

function gradientFrom(doc: PDFKit.PDFDocument, paint: Paint): string | PDFKit.PDFLinearGradient {
  if (paint.kind === 'solid') return paint.colour;
  const gradient = doc.linearGradient(paint.from.x, paint.from.y, paint.to.x, paint.to.y);
  for (const stop of paint.stops) gradient.stop(stop.at, stop.colour);
  return gradient;
}

function drawBadgeShape(doc: PDFKit.PDFDocument, shape: Shape): void {
  if (shape.op === 'text') {
    doc.font(FONT.mono).fontSize(shape.size).fillColor(shape.colour).fillOpacity(shape.alpha);
    const width = doc.widthOfString(shape.text, { characterSpacing: shape.tracking });
    doc.text(shape.text, shape.at.x - width / 2, shape.at.y - shape.size * 0.72, { lineBreak: false, characterSpacing: shape.tracking });
    doc.fillOpacity(1);
    return;
  }
  for (const points of shape.subpaths) {
    doc.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) doc.lineTo(point.x, point.y);
    if (shape.op === 'fill' || shape.closed) doc.closePath();
  }
  if (shape.op === 'fill') {
    doc.fillOpacity(shape.paint.alpha).fill(gradientFrom(doc, shape.paint));
    doc.fillOpacity(1);
    return;
  }
  doc.strokeOpacity(shape.alpha).lineWidth(shape.width).strokeColor(shape.colour).stroke();
  doc.strokeOpacity(1);
}

/** The badge, struck into the certificate from the same geometry the exports use. */
function seal(doc: PDFKit.PDFDocument, tier: Tier, x: number, y: number, size: number): void {
  doc.save();
  doc.translate(x, y).scale(size / 100);
  for (const shape of badgeShapes(tier, size)) drawBadgeShape(doc, shape);
  doc.restore();
}

// ------------------------------------------------------------------ layout

interface Plan {
  readonly claimLines: ReturnType<typeof layoutRuns>;
  readonly claimWidth: number;
  readonly rows: readonly { readonly runs: readonly TextRun[]; readonly lines: ReturnType<typeof layoutRuns>; readonly when: string; readonly height: number }[];
  readonly gapScale: number;
}

function claimRuns(input: CertificateInput): readonly TextRun[] {
  const parts = claimFor(input.tier, input.evidence.roleTitle);
  const colour = blend(0.9);
  return [
    { text: parts.lead, font: FONT.displayLight, size: TYPE.claim, colour },
    { text: parts.tier, font: FONT.display, size: TYPE.claim, colour },
    { text: parts.middle, font: FONT.displayLight, size: TYPE.claim, colour },
    { text: `${parts.role}.`, font: FONT.display, size: TYPE.claim, colour },
    // The asterisk that ties the claim to the footnote. No rise of its own:
    // pdfkit places text by the top of its line box, so a smaller run drawn at
    // the same y already sits a third of an em above the baseline beside it,
    // which is where a superscript belongs. Lifting it as well put it clear of
    // the ascenders and reading as a footnote marker for the line above.
    { text: '*', font: FONT.display, size: TYPE.claim * 0.6, colour },
  ];
}

function plan(doc: PDFKit.PDFDocument, input: CertificateInput): Plan {
  const runs = claimRuns(input);
  // The mockup holds the claim to 46 characters a line. A role title long
  // enough to push it past two lines gets the full width instead of a third
  // line: the block below it is fixed height, and a certificate that spills
  // its footnote off the sheet is worse than one whose claim runs wide.
  let claimWidth = CLAIM_CH * doc.font(FONT.displayLight).fontSize(TYPE.claim).widthOfString('0');
  let claimLines = layoutRuns(doc, runs, claimWidth);
  if (claimLines.length > 2) {
    claimWidth = CONTENT_W;
    claimLines = layoutRuns(doc, runs, claimWidth);
  }

  // The stored row holds an instant; the date column holds words. Turned into
  // words once, here, so that the column is measured against exactly what the
  // rows below will print.
  const whens = input.evidence.rows.map((row) => whenLabel(row.when));
  const dateWidth = Math.max(
    ...whens.map((when) => doc.font(FONT.sans).fontSize(TYPE.evidence).widthOfString(when)),
  );
  const textWidth = EVIDENCE_W - dateWidth - 11.7;
  const rows = input.evidence.rows.map((row, index) => {
    const rowRuns = emphasised(row.what, { regular: FONT.sans, bold: FONT.sansBold }, TYPE.evidence, blend(0.9));
    const lines = layoutRuns(doc, rowRuns, textWidth);
    return { runs: rowRuns, lines, when: whens[index], height: Math.max(1, lines.length) * TYPE.evidenceLeading };
  });

  const gaps = Object.values(GAP).reduce((sum, value) => sum + value, 0) + GAP.rowPad * 9;
  const fixed =
    PAD * 2 +
    TYPE.refLeading * 3 +
    TYPE.kicker * 1.55 +
    TYPE.name * 1.05 +
    0.75 +
    claimLines.length * TYPE.claimLeading +
    0.75 +
    TYPE.evidenceHeading * 1.55 +
    rows.reduce((sum, row) => sum + row.height, 0) +
    0.75 +
    SEAL +
    TYPE.footnote * 1.5;
  const available = PAGE.height - fixed;
  const gapScale = available >= gaps ? 1 : Math.max(0.3, available / gaps);
  return { claimLines, claimWidth, rows, gapScale };
}

// ------------------------------------------------------------------- parts

function header(doc: PDFKit.PDFDocument, input: CertificateInput): number {
  doc.font(FONT.display).fontSize(TYPE.wordmark).fillColor(blend(1));
  doc.text('QUESTOR', CONTENT_X, PAD, { lineBreak: false, characterSpacing: TYPE.wordmarkTracking });

  // The verify link keeps its own case while everything beside it is set in
  // capitals: the token is what a reader types into a browser, and a
  // case-folded token resolves to nothing.
  const lines: readonly (readonly [string, string])[] = [
    ['REFERENCE', input.reference.toUpperCase()],
    ['ISSUED', issuedOn(input.issuedAt).toUpperCase()],
    ['VERIFY', input.verifyUrl],
  ];
  const right = CONTENT_X + CONTENT_W;
  lines.forEach(([label, value], index) => {
    const y = PAD + index * TYPE.refLeading;
    doc.font(FONT.sansBold).fontSize(TYPE.ref);
    const valueWidth = doc.widthOfString(value, { characterSpacing: 0.35 });
    doc.font(FONT.sans).fontSize(TYPE.ref);
    const labelWidth = doc.widthOfString(`${label} `, { characterSpacing: 0.7 });
    doc.fillColor(blend(0.6)).text(`${label} `, right - valueWidth - labelWidth, y, { lineBreak: false, characterSpacing: 0.7 });
    doc.font(FONT.sansBold).fillColor(blend(0.85)).text(value, right - valueWidth, y, { lineBreak: false, characterSpacing: 0.35 });
  });
  return PAD + TYPE.refLeading * 3;
}

function evidence(doc: PDFKit.PDFDocument, layout: Plan, top: number): number {
  const scale = layout.gapScale;
  const x = CONTENT_X + (CONTENT_W - EVIDENCE_W) / 2;
  let y = top;
  horizontalRule(doc, x, y, EVIDENCE_W, blend(0.2));
  y += 0.75 + GAP.evidencePad * scale;

  doc.font(FONT.sansBold).fontSize(TYPE.evidenceHeading).fillColor(blend(0.55));
  doc.text('WHAT THIS RECORDS', x, y, { lineBreak: false, characterSpacing: 1.4 });
  y += TYPE.evidenceHeading * 1.55 + GAP.headingToRows * scale;

  layout.rows.forEach((row, index) => {
    if (index > 0) {
      dottedRule(doc, x, y, EVIDENCE_W);
      y += 0.5;
    }
    y += GAP.rowPad * scale;
    doc.font(FONT.sans).fontSize(TYPE.evidence).fillColor(blend(0.58));
    const dateWidth = doc.widthOfString(row.when);
    doc.text(row.when, x + EVIDENCE_W - dateWidth, y, { lineBreak: false });
    drawLines(doc, row.lines, { x, y, width: EVIDENCE_W, leading: TYPE.evidenceLeading, align: 'left' });
    y += row.height + GAP.rowPad * scale;
  });

  horizontalRule(doc, x, y + GAP.evidencePad * scale - GAP.rowPad * scale, EVIDENCE_W, blend(0.2));
  return y + GAP.evidencePad * scale - GAP.rowPad * scale + 0.75;
}

/**
 * The two signatures, flanking the seal.
 *
 * Both are always present, on every tier, because the structure is identical
 * across the three — and on Bronze the left-hand one says Questor, which is
 * how the absence of a human assessor stays visible instead of being an empty
 * space a reader fills in themselves.
 */
function signatures(doc: PDFKit.PDFDocument, input: CertificateInput, top: number): number {
  const width = (CONTENT_W - SEAL - 26.4) / 2;
  const height = 0.75 + 4.4 + TYPE.signatureName * 1.2 + TYPE.signatureRole * 1.55;
  const ruleY = top + SEAL - height;

  const left = input.tier === 'bronze'
    ? { name: BRONZE_ASSESSOR_NAME, role: input.evidence.signatures.left.role }
    : input.evidence.signatures.left;
  const blocks = [
    { at: CONTENT_X, ...left },
    { at: CONTENT_X + CONTENT_W - width, ...input.evidence.signatures.right },
  ];

  for (const block of blocks) {
    horizontalRule(doc, block.at, ruleY, width, blend(0.45));
    let y = ruleY + 0.75 + 4.4;
    doc.font(FONT.display).fontSize(TYPE.signatureName).fillColor(blend(1));
    doc.text(block.name, block.at, y, { width, lineBreak: false, ellipsis: true });
    y += TYPE.signatureName * 1.2;
    doc.font(FONT.sans).fontSize(TYPE.signatureRole).fillColor(blend(0.56));
    doc.text(block.role.toUpperCase(), block.at, y, { width, lineBreak: false, ellipsis: true, characterSpacing: 0.84 });
  }

  seal(doc, input.tier, (PAGE.width - SEAL) / 2, top, SEAL);
  return top + SEAL;
}

function footnote(doc: PDFKit.PDFDocument, input: CertificateInput, top: number, scale: number): void {
  const y = top + GAP.footerToFootnote * scale;
  horizontalRule(doc, CONTENT_X, y, CONTENT_W, blend(0.16));
  centredText(doc, footnoteFor(input.tier), y + 0.75 + GAP.footnotePad * scale, {
    font: FONT.sans,
    size: TYPE.footnote,
    colour: blend(0.5),
    tracking: 0.26,
  });
}

function face(doc: PDFKit.PDFDocument, input: CertificateInput, layout: Plan): void {
  const scale = layout.gapScale;
  doc.rect(0, 0, PAGE.width, PAGE.height).fill(PAPER);
  guilloche(doc);
  watermarkQ(doc);
  if (input.tier === 'bronze') watermarkInternal(doc);
  frame(doc);

  let y = header(doc, input) + GAP.headerToBody * scale;

  centredText(doc, kickerFor(input.tier).toUpperCase(), y, {
    font: FONT.sans, size: TYPE.kicker, colour: blend(0.6), tracking: TYPE.kickerTracking,
  });
  y += TYPE.kicker * 1.55 + GAP.kickerToName * scale;

  centredText(doc, input.evidence.candidateName, y, { font: FONT.display, size: TYPE.name, colour: blend(1), tracking: -0.46 });
  y += TYPE.name * 1.05 + GAP.nameToRule * scale;

  fadedRule(doc, y);
  y += 0.75 + GAP.ruleToClaim * scale;

  drawLines(doc, layout.claimLines, {
    x: CONTENT_X + (CONTENT_W - layout.claimWidth) / 2,
    y,
    width: layout.claimWidth,
    leading: TYPE.claimLeading,
    align: 'centre',
  });
  y += layout.claimLines.length * TYPE.claimLeading + GAP.claimToEvidence * scale;

  y = evidence(doc, layout, y) + GAP.evidenceToFooter * scale;
  y = signatures(doc, input, y);
  footnote(doc, input, y, scale);
}

/**
 * Buffered rather than streamed, for the same reason the role export is:
 * everything that can refuse this document is decided before a byte is
 * written, and a failure halfway through a stream would already have sent a
 * 200 and a PDF header, leaving the reader with a truncated file instead of an
 * explanation.
 */
export function certificatePdf(input: CertificateInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: [PAGE.width, PAGE.height],
      margin: 0,
      info: {
        // No organisation anywhere, including the metadata: Questor is the
        // only party vouching for this, and an employer's name in Author would
        // read as their endorsement of the candidate.
        Title: `Questor — ${input.reference}`,
        Author: 'Questor',
        Subject: 'Record of assessment',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    try {
      face(doc, input, plan(doc, input));
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
