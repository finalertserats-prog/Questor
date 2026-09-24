import PDFDocument from 'pdfkit';
import type { Competency, RoleSuccessProfile } from '../domain/types.js';

/**
 * The approved scorecard as a document: a real, vector-text PDF that can be
 * filed, printed, searched and read aloud by a screen reader.
 *
 * Rendered server-side with pdfkit rather than by screenshotting the page. A
 * picture of a scorecard is unsearchable, unselectable and illegible when
 * printed, and this document exists precisely to be read outside the product —
 * by a hiring manager who never logs in, and by whoever has to show, months
 * later, which line of the job description each competency came from.
 *
 * Only the standard-14 fonts are used, so no font file ships with the server
 * and every viewer renders the same glyphs.
 */

export interface RoleScorecardPdfInput {
  readonly organisation: string;
  readonly role: {
    readonly title: string;
    readonly level: string;
    readonly location: string;
    readonly employmentType: string;
    readonly sourceText: string;
  };
  readonly scorecard: {
    readonly version: number;
    readonly approvedAt: Date | null;
    /** Already resolved to something a person can read, or null when the account is gone. */
    readonly approvedBy: string | null;
  };
  readonly profile: RoleSuccessProfile;
  readonly generatedAt: Date;
}

const MARGIN = 54;
const PAGE_HEIGHT = 792; // US Letter, pdfkit's default.
const FOOTER_BASELINE = PAGE_HEIGHT - MARGIN + 14;

const INK = '#1a1a1a';
const MUTED = '#5c5c5c';
const RULE = '#c9c9c9';

/** ISO, not a locale format: this file is read in other time zones than ours. */
function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * A role title is free text — slashes, colons and quotes included — and it ends
 * up in a Content-Disposition header and then in a file name on someone's
 * desktop. `sanitizeFilename` in services/resumeFile.ts is the same idea but
 * runs `path.basename` first, which is right for an uploaded file name and
 * wrong here: it would turn "Data Engineer / Payments" into "Payments".
 */
export function exportFilename(title: string, version: number): string {
  const stem = title
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return `${stem || 'role'}-scorecard-v${version}.pdf`;
}

export const NO_SOURCE_SPAN = 'No source span recorded';

/** The richer span shape a later extractor may write alongside `sourceText`. */
interface CompetencySource {
  readonly text: string;
  readonly section?: string;
  readonly line?: number;
}

function readSource(value: unknown): CompetencySource | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  if (!text) return null;
  return {
    text,
    ...(typeof record.section === 'string' && record.section.trim() ? { section: record.section.trim() } : {}),
    ...(typeof record.line === 'number' && Number.isFinite(record.line) ? { line: record.line } : {}),
  };
}

/**
 * The exact JD line a competency was derived from.
 *
 * `source` wins when it is there, because it carries where in the JD the span
 * came from as well as what it said; `sourceText` is the older, flatter record
 * of the same thing. Neither is guaranteed — a competency typed by hand has no
 * span at all — and an empty line under "Source" reads as a bug, so the absence
 * is stated instead of left blank.
 */
export function sourceSpanOf(competency: Competency): string {
  const rich = readSource((competency as { source?: unknown }).source);
  if (rich) {
    const where = [rich.section, rich.line !== undefined ? `line ${rich.line}` : ''].filter(Boolean).join(', ');
    return where ? `${rich.text} (${where})` : rich.text;
  }
  const flat = competency.sourceText?.trim();
  return flat || NO_SOURCE_SPAN;
}

function percent(weight: number): string {
  // One decimal only when it says something: "12.5%" matters, "60.0%" does not.
  const value = Math.round(weight * 1000) / 10;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

function contentWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width - MARGIN * 2;
}

function heading(doc: PDFKit.PDFDocument, text: string): void {
  doc.moveDown(1);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(text, { width: contentWidth(doc) });
  doc.moveDown(0.35);
  const y = doc.y;
  doc.save().strokeColor(RULE).lineWidth(0.75).moveTo(MARGIN, y).lineTo(doc.page.width - MARGIN, y).stroke().restore();
  doc.moveDown(0.6);
}

function body(doc: PDFKit.PDFDocument, text: string, opts: { readonly muted?: boolean; readonly size?: number } = {}): void {
  doc.font('Helvetica').fontSize(opts.size ?? 10).fillColor(opts.muted ? MUTED : INK)
    .text(text, { width: contentWidth(doc), align: 'left' });
}

function labelled(doc: PDFKit.PDFDocument, label: string, value: string): void {
  // Label and value in one run: two columns at the same baseline extract as one
  // unspaced string ("Definition:Keeps..."), which is what a reader copying a
  // span out of this file would paste into a ticket.
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(MUTED).text(`${label}: `, { continued: true, width: contentWidth(doc) });
  doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(value, { width: contentWidth(doc) });
  doc.moveDown(0.15);
}

function header(doc: PDFKit.PDFDocument, input: RoleScorecardPdfInput): void {
  doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(input.role.title, { width: contentWidth(doc) });
  doc.moveDown(0.25);
  const facts = [input.role.level, input.role.location, input.role.employmentType].map((f) => f.trim()).filter(Boolean);
  doc.font('Helvetica').fontSize(10.5).fillColor(MUTED)
    .text([input.organisation, ...facts].filter(Boolean).join('  •  '), { width: contentWidth(doc) });
  doc.moveDown(0.5);
  const y = doc.y;
  doc.save().strokeColor(INK).lineWidth(1.2).moveTo(MARGIN, y).lineTo(doc.page.width - MARGIN, y).stroke().restore();
  doc.moveDown(0.8);
}

function approval(doc: PDFKit.PDFDocument, input: RoleScorecardPdfInput): void {
  const who = input.scorecard.approvedBy ?? 'an account that no longer exists';
  const when = input.scorecard.approvedAt ? isoDate(input.scorecard.approvedAt) : 'an unrecorded date';
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK)
    .text(`Approved scorecard — Version ${input.scorecard.version}`, { width: contentWidth(doc) });
  body(doc, `Approved by ${who} on ${when}.`, { muted: true });
}

function jobDescription(doc: PDFKit.PDFDocument, sourceText: string): void {
  heading(doc, 'Job description');
  const text = sourceText.trim();
  if (!text) {
    body(doc, 'No job description text is stored for this role.', { muted: true });
    return;
  }
  body(doc, text, { size: 9.5 });
}

function competencyBlock(doc: PDFKit.PDFDocument, competency: Competency, index: number): void {
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
    .text(`${index + 1}. ${competency.name}${competency.retired ? ' (retired)' : ''}`, { width: contentWidth(doc) });
  doc.moveDown(0.2);
  labelled(doc, 'Category', `${competency.category} • ${competency.classification} • weight ${percent(competency.weight)}`);
  labelled(doc, 'Levels', `Required level ${competency.requiredLevel} • Target level ${competency.targetLevel}`);
  labelled(doc, 'Definition', competency.definition?.trim() || 'No definition recorded.');
  labelled(doc, 'Indicators', competency.indicators?.length ? competency.indicators.join('  •  ') : 'No indicators recorded.');
  labelled(doc, 'Source span', sourceSpanOf(competency));
}

function competencies(doc: PDFKit.PDFDocument, profile: RoleSuccessProfile): void {
  heading(doc, 'Competencies');
  const list = profile.competencies ?? [];
  if (!list.length) {
    body(doc, 'This scorecard records no competencies.', { muted: true });
    return;
  }
  list.forEach((competency, index) => competencyBlock(doc, competency, index));
}

/**
 * Page numbers are only knowable once every page exists, so they are stamped
 * afterwards over the buffered pages. The bottom margin is dropped first:
 * writing at the footer baseline with the margin still in force makes pdfkit
 * add a page, and that page would then need a footer of its own.
 */
function footers(doc: PDFKit.PDFDocument, generatedAt: Date): void {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(
      `Page ${i + 1} of ${range.count}  •  Generated ${isoDate(generatedAt)}`,
      MARGIN,
      FOOTER_BASELINE,
      { width: doc.page.width - MARGIN * 2, align: 'center', lineBreak: false },
    );
  }
}

/**
 * Buffered rather than streamed: everything that can refuse this export
 * (capability, scope, "not approved yet") is decided before a byte is written,
 * and a buffer keeps it that way — a failure halfway through a stream would
 * have already sent a 200 and a PDF header, leaving the browser to save a
 * truncated file instead of showing the error.
 */
export function roleScorecardPdf(input: RoleScorecardPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margin: MARGIN,
      bufferPages: true,
      info: {
        Title: `${input.role.title} — scorecard v${input.scorecard.version}`,
        Author: input.organisation,
        Subject: 'Approved interview scorecard',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    try {
      header(doc, input);
      approval(doc, input);
      jobDescription(doc, input.role.sourceText);
      competencies(doc, input.profile);
      footers(doc, input.generatedAt);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
