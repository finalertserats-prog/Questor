import mammoth from 'mammoth';
import { HttpError } from '../middleware/index.js';
import type { NormalizedProfile } from '../domain/types.js';

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

/** Heuristic normalization of resume text into a structured profile. */
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

  // Rough total years
  const years = (clean.match(dateRe) ?? []).map(Number).filter((y) => y > 1980 && y <= new Date().getFullYear());
  const totalYears = years.length >= 2 ? Math.min(45, Math.max(...years) - Math.min(...years)) : undefined;

  return { employment: employment.slice(0, 12), education, projects, certifications, skills, totalYears };
}
