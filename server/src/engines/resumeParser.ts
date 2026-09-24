import mammoth from 'mammoth';
import { HttpError } from '../middleware/index.js';
import type { NormalizedProfile } from '../domain/types.js';
import { extractCvFacts } from './cvFacts.js';

export const PDF_MIME = 'application/pdf';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const TEXT_MIME = 'text/plain';

/** Single source of truth shared with the multer fileFilter so the upload gate
 *  and the parser dispatch can never drift apart. */
export const RESUME_MIME_TYPES = [PDF_MIME, DOCX_MIME, TEXT_MIME] as const;
export type ResumeMimeType = (typeof RESUME_MIME_TYPES)[number];

export function isResumeMimeType(value: string): value is ResumeMimeType {
  return (RESUME_MIME_TYPES as readonly string[]).includes(value);
}

export const MARKDOWN_MIME = 'text/markdown';
/** Not a format: the browser saying it could not name one. */
export const OCTET_STREAM_MIME = 'application/octet-stream';

/**
 * The types an uploaded JOB DESCRIPTION may arrive as — the same single source
 * of truth as RESUME_MIME_TYPES, for the other upload lane.
 *
 * Deliberately a second list rather than a wider first one. Markdown is a JD
 * format, not a CV format, and widening RESUME_MIME_TYPES would silently start
 * accepting `.md` on every candidate resume upload and every CV in a bulk
 * import — a change to candidate behaviour that nobody asked for, made by a
 * change to a job-description feature. Both lists are read by their own multer
 * fileFilter and by their own extractor below, so neither gate can drift from
 * the dispatch it guards.
 */
export const JD_MIME_TYPES = [PDF_MIME, DOCX_MIME, TEXT_MIME, MARKDOWN_MIME, OCTET_STREAM_MIME] as const;
export type JdMimeType = (typeof JD_MIME_TYPES)[number];

export function isJdMimeType(value: string): value is JdMimeType {
  return (JD_MIME_TYPES as readonly string[]).includes(value);
}

/** A resume that reaches this length is either machine-generated or hostile.
 *  Both pdf-parse and mammoth can expand a few kilobytes into gigabytes of text,
 *  so the cap is applied at extraction time — before the text reaches profile
 *  normalization, storage, or any LLM call priced per token. */
export const MAX_RESUME_TEXT_CHARS = 200_000;

const PDF_MAGIC = Buffer.from('%PDF', 'ascii');
// DOCX is an OOXML package, i.e. a ZIP archive, so it opens with the ZIP local
// file header rather than anything Word-specific.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const UNREADABLE_MESSAGE =
  'Could not read the uploaded file. Please upload a text-based PDF, DOCX, or paste the resume text.';

function startsWith(buffer: Buffer, magic: Buffer): boolean {
  return buffer.length >= magic.length && buffer.subarray(0, magic.length).equals(magic);
}

/** Classify by content. Anything that is not a PDF or a ZIP container is only
 *  ever treated as plain text, which is the one branch that feeds no parser. */
function sniffType(buffer: Buffer): ResumeMimeType {
  if (startsWith(buffer, PDF_MAGIC)) return PDF_MIME;
  if (startsWith(buffer, ZIP_MAGIC)) return DOCX_MIME;
  return TEXT_MIME;
}

/**
 * Extract raw text from a resume buffer.
 *
 * Dispatch is driven by the bytes, never by the filename or Content-Type: an
 * uploader controls both, so trusting them lets a crafted file pick which
 * parser it is handed to. The declared type must also agree with the sniffed
 * type, so a PDF disguised as .txt is rejected rather than reinterpreted.
 */
export async function extractResumeText(buffer: Buffer, declaredType: string): Promise<string> {
  if (!isResumeMimeType(declaredType)) throw new HttpError(400, UNREADABLE_MESSAGE);
  if (sniffType(buffer) !== declaredType) {
    throw new HttpError(400, 'The uploaded file does not match its declared file type.');
  }

  try {
    if (declaredType === PDF_MIME) {
      // Import the library file directly to avoid pdf-parse's debug harness.
      const mod = (await import('pdf-parse/lib/pdf-parse.js')) as {
        default?: (input: Buffer) => Promise<{ text?: string }>;
      };
      const pdfParse = mod.default ?? (mod as unknown as (input: Buffer) => Promise<{ text?: string }>);
      const data = await pdfParse(buffer);
      return capped(String(data.text ?? ''));
    }
    if (declaredType === DOCX_MIME) {
      const { value } = await mammoth.extractRawText({ buffer });
      return capped(value);
    }
    return capped(buffer.toString('utf-8'));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // A malformed or deliberately hostile document must not surface parser
    // internals or take the process down with it.
    throw new HttpError(400, UNREADABLE_MESSAGE);
  }
}

/**
 * Extract raw text from an uploaded job description.
 *
 * The same extractor, reached by the same rule — bytes decide — with one
 * concession the resume lane does not need. A `.md` file has no agreed
 * Content-Type: browsers send `text/markdown`, `text/plain`, or
 * `application/octet-stream` for the same file on the same machine, so a
 * declared type that disagreed with the sniffed one would refuse perfectly
 * good Markdown for a reason the uploader could neither see nor fix.
 *
 * So the leniency is granted only where it costs nothing:
 * - `application/octet-stream` declares nothing, so there is no claim to check
 *   and the bytes alone choose the parser.
 * - `text/markdown` is read as plain text, which is the one branch that feeds
 *   NO parser — and the agreement check still runs, so a PDF or a ZIP calling
 *   itself Markdown is refused rather than reinterpreted.
 * - A declared PDF or DOCX is checked against the bytes exactly as before. A
 *   crafted file still cannot pick which parser it is handed to.
 */
export async function extractJdText(buffer: Buffer, declaredType: string): Promise<string> {
  if (!isJdMimeType(declaredType)) throw new HttpError(400, JD_UNREADABLE_MESSAGE);
  try {
    return await extractResumeText(buffer, jdDispatchType(buffer, declaredType));
  } catch (err) {
    // The shared extractor speaks to the candidate lane; someone uploading a
    // requisition is not pasting a resume, and must be told what to do next in
    // words that fit what they are doing.
    if (err instanceof HttpError && err.message === UNREADABLE_MESSAGE) throw new HttpError(400, JD_UNREADABLE_MESSAGE);
    throw err;
  }
}

const JD_UNREADABLE_MESSAGE =
  'Could not read the uploaded file. Please upload a text-based PDF, DOCX, TXT or Markdown file, or paste the job description instead.';

function jdDispatchType(buffer: Buffer, declared: JdMimeType): ResumeMimeType {
  if (declared === OCTET_STREAM_MIME) return sniffType(buffer);
  if (declared === MARKDOWN_MIME) return TEXT_MIME;
  return declared;
}

function capped(text: string): string {
  return text.slice(0, MAX_RESUME_TEXT_CHARS).trim();
}

const SKILL_HINTS = [
  'sql', 'python', 'java', 'javascript', 'typescript', 'react', 'node', 'aws', 'azure', 'gcp',
  'kubernetes', 'docker', 'terraform', 'spark', 'airflow', 'dbt', 'snowflake', 'bigquery', 'redshift',
  'postgres', 'mysql', 'kafka', 'pandas', 'tensorflow', 'pytorch', 'machine learning', 'nlp',
  'salesforce', 'excel', 'tableau', 'power bi', 'figma', 'jira', 'agile', 'scrum', 'go', 'rust', 'c++',
];

function sectionBody(text: string, headers: string[]): string {
  const lines = text.split('\n');
  const lower = lines.map((l) => l.toLowerCase().trim());
  const startIdx = lower.findIndex((l) => headers.some((h) => l === h || l.startsWith(h)));
  if (startIdx < 0) return '';
  const nextHeaderRe = /^(experience|employment|work history|education|projects?|skills|certifications?|summary|objective|awards|publications)\b/i;
  const out: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (nextHeaderRe.test(lines[i].trim()) && lines[i].trim().length < 40) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

/**
 * Heuristic normalization of resume text into a structured profile.
 *
 * This shape is what the interview plan reads: the CV-anchored identity
 * questions quote its bullets, and band calibration counts its jobs. The fit
 * score no longer reads it at all — that goes through `engines/cvFacts.ts`,
 * which carries provenance and has protected detail removed first — so the two
 * are deliberately separate things with separate jobs.
 */
export function normalizeProfile(text: string): NormalizedProfile {
  const clean = text.replace(/\r/g, '');
  const lower = clean.toLowerCase();

  // Skills
  const skills = Array.from(new Set(SKILL_HINTS.filter((s) => lower.includes(s)))).map((s) =>
    s.replace(/\b\w/g, (c) => c.toUpperCase()),
  );

  // Employment: lines that look like "Title, Company (dates)" or "Title at Company"
  const employment: NormalizedProfile['employment'] = [];
  const expBody = sectionBody(clean, ['experience', 'employment', 'work history']) || clean;
  const dateRe = /(19|20)\d{2}/g;
  const roleLineRe = /^(.{3,60}?)(?:\s+(?:at|@|,|-)\s+)(.{2,60}?)(?:\s*[\(\|].*)?$/;
  const bulletBuf: string[] = [];
  let current: NormalizedProfile['employment'][number] | null = null;
  for (const raw of expBody.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const isBullet = /^[\-\*•]/.test(raw) || /^\s{2,}/.test(raw);
    const m = line.match(roleLineRe);
    if (m && !isBullet && line.length < 90) {
      if (current) { current.bullets = bulletBuf.slice(); employment.push(current); bulletBuf.length = 0; }
      const dates = line.match(dateRe) ?? [];
      current = { title: m[1].trim(), company: m[2].replace(/[\(\|].*$/, '').trim(), start: dates[0], end: dates[1] ?? (/present|current/i.test(line) ? 'Present' : undefined), bullets: [] };
    } else if (current && (isBullet || line.length > 20)) {
      bulletBuf.push(line.replace(/^[\-\*•\s]+/, ''));
    }
  }
  if (current) { current.bullets = bulletBuf.slice(); employment.push(current); }

  // Education
  const education: NormalizedProfile['education'] = [];
  const eduBody = sectionBody(clean, ['education']);
  for (const raw of eduBody.split('\n')) {
    const line = raw.trim();
    if (/\b(b\.?tech|b\.?e\.?|bachelor|master|m\.?tech|m\.?s\.?|mba|phd|b\.?sc|m\.?sc|diploma)\b/i.test(line)) {
      const year = line.match(dateRe)?.[0];
      education.push({ degree: line.replace(dateRe, '').replace(/[,|].*$/, '').trim().slice(0, 80), institution: '', year });
    }
  }

  // Projects
  const projects: NormalizedProfile['projects'] = [];
  const projBody = sectionBody(clean, ['projects', 'project']);
  for (const raw of projBody.split('\n')) {
    const line = raw.trim().replace(/^[\-\*•\s]+/, '');
    if (line.length > 15) projects.push({ name: line.slice(0, 60), summary: line });
    if (projects.length >= 6) break;
  }

  // Certifications
  const certifications: string[] = [];
  const certBody = sectionBody(clean, ['certifications', 'certification', 'certificate']);
  for (const raw of certBody.split('\n')) {
    const line = raw.trim().replace(/^[\-\*•\s]+/, '');
    if (line.length > 4) certifications.push(line.slice(0, 80));
    if (certifications.length >= 8) break;
  }

  // Rough total years.
  //
  // "Present" is not a year, and a CV that reads "2004 - Present" therefore used
  // to measure as zero years of experience: the span between the earliest and
  // latest years actually WRITTEN DOWN. Every currently-employed candidate was
  // understated, and the longer their tenure the worse the error.
  //
  // That fed band calibration, which read a twenty-two year director as
  // `developing` and interviewed them at a level meant for two-to-five years.
  // The questions were not the bug; this was.
  const thisYear = new Date().getFullYear();
  const years = (clean.match(dateRe) ?? []).map(Number).filter((y) => y > 1980 && y <= thisYear);
  // An ongoing role means the range runs to today, whether or not the CV says so.
  if (/\b(present|current|now|to date|ongoing|till date)\b/i.test(clean) && years.length) years.push(thisYear);
  const totalYears = years.length >= 2 ? Math.min(45, Math.max(...years) - Math.min(...years)) : undefined;

  return {
    // A CV this parser could not find a single job in still has jobs. The
    // evidence parser reads role headings that carry their dates on the line
    // below, and headings written "Acme Corp — Senior Engineer", both of which
    // this one misses — and an empty employment list means the identity check
    // has no CV line to ask about and band calibration has nothing to count.
    // It is only ever a fallback: where this parser found anything, its own
    // answer stands, so nothing that worked before changes.
    employment: employment.length > 0 ? employment.slice(0, 12) : employmentFromFacts(text),
    education, projects, certifications, skills, totalYears,
  };
}

function employmentFromFacts(text: string): NormalizedProfile['employment'] {
  return extractCvFacts(text).roles.slice(0, 12).map((role) => ({
    title: role.title,
    company: role.employer,
    ...(role.startYear ? { start: String(role.startYear) } : {}),
    ...(role.endYear ? { end: role.current ? 'Present' : String(role.endYear) } : {}),
    bullets: role.bullets.map((b) => b.quote),
  }));
}
