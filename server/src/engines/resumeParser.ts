import mammoth from 'mammoth';
import { HttpError } from '../middleware/index.js';
import type { NormalizedProfile } from '../domain/types.js';
import { extractCvFacts } from './cvFacts.js';
import { pdfPageRenderer } from './pdfLayout.js';
import { totalExperienceYears } from './experienceSpan.js';
import { matchSkills } from './skillVocabulary.js';

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
/** Still sent by some editors and by Windows for a registered .md handler. */
export const X_MARKDOWN_MIME = 'text/x-markdown';
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
export const JD_MIME_TYPES = [PDF_MIME, DOCX_MIME, TEXT_MIME, MARKDOWN_MIME, X_MARKDOWN_MIME, OCTET_STREAM_MIME] as const;
export type JdMimeType = (typeof JD_MIME_TYPES)[number];

export function isJdMimeType(value: string): value is JdMimeType {
  return (JD_MIME_TYPES as readonly string[]).includes(value);
}

/** A resume that reaches this length is either machine-generated or hostile.
 *  Both pdf-parse and mammoth can expand a few kilobytes into gigabytes of text,
 *  so the cap is applied at extraction time — before the text reaches profile
 *  normalization, storage, or any LLM call priced per token. */
export const MAX_RESUME_TEXT_CHARS = 200_000;

type PdfParse = (input: Buffer, opts?: Record<string, unknown>) => Promise<{ text?: string }>;

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
      const mod = (await import('pdf-parse/lib/pdf-parse.js')) as { default?: PdfParse };
      const pdfParse = mod.default ?? (mod as unknown as PdfParse);
      // Our own page renderer, not pdf-parse's: see engines/pdfLayout.ts for
      // the two-column CVs and side-by-side date strips its default reading
      // turned into nonsense.
      const data = await pdfParse(buffer, { pagerender: pdfPageRenderer });
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
 * So the leniency is granted only where it costs nothing: the three types a
 * `.md` file arrives as — `text/markdown`, `text/x-markdown` and
 * `application/octet-stream` — are all read as PLAIN TEXT, which is the one
 * branch that feeds no parser at all.
 *
 * Note what that does NOT do. It does not let an unnamed type pick its own
 * parser from its bytes: a ZIP declared `application/octet-stream` is refused
 * rather than handed to mammoth, so this endpoint opens no new route to a
 * document parser that a declared DOCX did not already have. And the
 * agreement check still runs on the text branch, so a PDF or a ZIP calling
 * itself Markdown is refused rather than reinterpreted. A declared PDF or
 * DOCX is checked against the bytes exactly as before.
 */
export async function extractJdText(buffer: Buffer, declaredType: string): Promise<string> {
  if (!isJdMimeType(declaredType)) throw new HttpError(400, JD_UNREADABLE_MESSAGE);
  try {
    return await extractResumeText(buffer, jdDispatchType(declaredType));
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

function jdDispatchType(declared: JdMimeType): ResumeMimeType {
  if (declared === MARKDOWN_MIME || declared === X_MARKDOWN_MIME || declared === OCTET_STREAM_MIME) return TEXT_MIME;
  // Exhaustive by construction: a type added to JD_MIME_TYPES without a branch
  // above fails to compile here rather than silently reaching a parser.
  return declared;
}

function capped(text: string): string {
  return text.slice(0, MAX_RESUME_TEXT_CHARS).trim();
}

/**
 * Bullet glyphs a PDF actually leaves in the text. The list used to be
 * `- * •`, so the square and round bullets that Word and Canva templates
 * favour were kept as part of the value: certifications reached the hiring
 * team reading "▪ Google Ads Fundamentals".
 */
const BULLET_PREFIX = /^[\s\-*+>•▪▫●○■□◦‣⁃·∙・›»⁃−]+/;

function stripBullet(line: string): string {
  return line.replace(BULLET_PREFIX, '').trim();
}

/**
 * Every heading a CV uses for a section that is not the one we are reading.
 *
 * A section ends where the next heading starts, so this list is what stops one
 * running on. It used to name nine headings, and a CV whose certifications
 * were followed by "LANGUAGES" had "English, Hindi" and the two paragraphs
 * after it filed as certifications, because "languages" was not on the list
 * and nothing else ended the section.
 */
const SECTION_HEADINGS = new Set([
  'experience', 'work experience', 'professional experience', 'employment', 'employment history',
  'work history', 'career history', 'career timeline', 'education', 'academic', 'qualifications',
  'professional background', 'background', 'career summary', 'experience summary',
  'relevant experience', 'related experience', 'industry experience', 'professional history',
  'career', 'career experience', 'positions held', 'appointments', 'roles', 'work',
  'projects', 'project', 'key projects', 'skills', 'technical skills', 'core skills',
  'core competencies', 'competencies', 'key skills', 'areas of expertise', 'expertise',
  'certifications', 'certification', 'certificates', 'licenses', 'licences', 'training',
  'summary', 'profile', 'profile summary', 'professional summary', 'objective', 'about',
  'awards', 'honors', 'honours', 'achievements', 'key highlights', 'highlights',
  'publications', 'patents', 'languages', 'interests', 'hobbies', 'activities',
  'volunteering', 'volunteer experience', 'references', 'contact', 'personal details',
  'tools', 'technologies', 'affiliations', 'memberships', 'courses', 'coursework',
]);

/**
 * The section this line is the heading of, or null if it is content.
 *
 * Named headings are matched whole, not by prefix. "Experience" is a heading;
 * "Experienced in B2B campaigns across EMEA" is a sentence that starts with
 * the same letters, and reading the second as the first silently moved the
 * section boundary into the middle of someone's job.
 */
function headingKey(line: string): string | null {
  const bare = stripBullet(line).replace(/[:\s]+$/, '').toLowerCase();
  if (!bare || bare.length > 48) return null;
  if (SECTION_HEADINGS.has(bare)) return bare;
  // Compound headings are the norm, not the exception: "CERTIFICATIONS &
  // TRAINING", "Education and Qualifications", "Skills / Tools". Every part
  // has to be a heading in its own right, so "Experience at Gartner and
  // Genesys" is still a sentence.
  const parts = bare.split(/\s*(?:&|\/|\||,|\band\b)\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return null;
  return parts.every((p) => SECTION_HEADINGS.has(p)) ? parts[0] : null;
}

/**
 * The document with these sections removed, everything else left in place.
 *
 * Used for counting years, where the question is which text CANNOT contain
 * employment dates rather than which text can. Reading the experience section
 * alone looked like the obvious answer and was wrong: CVs put sub-headings
 * inside it — "Key Highlights", "Achievements" — and the section stops at the
 * first of them, so one real CV lost five of its six jobs and reported one
 * year instead of six. Cutting out education and training instead makes no
 * assumption about where the jobs end.
 */
function withoutSections(text: string, headers: readonly string[]): string {
  const wanted = new Set(headers);
  const out: string[] = [];
  let dropping = false;
  for (const line of text.split('\n')) {
    const key = headingKey(line);
    if (key) dropping = wanted.has(key);
    out.push(dropping ? '' : line);
  }
  return out.join('\n');
}

/** Sections whose dates are never time spent employed. */
const NON_EMPLOYMENT_SECTIONS = [
  'education', 'academic', 'qualifications',
  'certifications', 'certification', 'certificates', 'licenses', 'licences',
  'training', 'courses', 'coursework',
];

/** The lines under one of these headings, ending at the next heading of any kind. */
function sectionBody(text: string, headers: string[]): string {
  const lines = text.split('\n');
  const wanted = new Set(headers);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const key = headingKey(lines[i]);
    if (key && wanted.has(key)) { startIdx = i; break; }
  }
  if (startIdx < 0) return '';
  const out: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (headingKey(lines[i])) break;
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
/** Headings a CV puts its jobs under. */
const EXPERIENCE_HEADINGS = [
  'experience', 'work experience', 'professional experience', 'employment',
  'employment history', 'work history', 'career history',
  // Without these a CV headed "Professional Background" or "Relevant
  // Experience" produced no employment at all — no jobs shown to the
  // recruiter, on a CV that plainly lists them. Since the section no longer
  // falls back to the whole document, an unlisted heading is not a degraded
  // reading any more; it is silence.
  'professional background', 'background', 'career summary', 'experience summary',
  'relevant experience', 'related experience', 'industry experience',
  'professional history', 'career', 'career experience', 'positions held',
  'appointments', 'roles', 'work', 'work history & projects',
];

const DEGREE_RE = /\b(b\.?tech|b\.?e\.?|bachelor|master|m\.?tech|m\.?s\.?|mba|mca|bca|phd|doctorate|b\.?sc|m\.?sc|b\.?a\.?|m\.?a\.?|b\.?com|m\.?com|bbs|bba|llb|llm|diploma|hnd|btec|a[- ]levels?)\b/i;

/**
 * Whether a line names a certification rather than being prose that happened
 * to sit under the heading.
 *
 * Two ways to qualify: it says what kind of thing it is (certified, course,
 * programme, licence), or it is short and title-shaped — a name and an issuer,
 * not a sentence. Anything with a full stop mid-line, or more than about a
 * dozen words, is prose.
 */
function looksLikeCertification(line: string): boolean {
  if (/\.\s+[A-Z]/.test(line)) return false;
  const words = line.split(/\s+/).filter(Boolean).length;
  if (words > 14) return false;
  if (/\b(certifi\w*|certificate|credential|licen[cs]e\w*|accredit\w*|course|programme|program|training|diploma|badge|associate|professional|specialist|practitioner|foundation|fundamentals)\b/i.test(line)) return true;
  // A short line carrying a recognised issuer or a year in brackets reads as a
  // credential even when it never uses the word.
  return words <= 10 && /\b(google|microsoft|aws|amazon|azure|oracle|salesforce|hubspot|cisco|pmi|pmp|prince2|scrum|comptia|sap|tableau|meta|adobe|ibm|isaca|acca|cima|cfa|cipd)\b/i.test(line);
}

export function normalizeProfile(text: string): NormalizedProfile {
  const clean = text.replace(/\r/g, '');

  // Skills. Word-boundary matching against a vocabulary that covers more than
  // one profession — see engines/skillVocabulary.ts for the senior marketing
  // manager whose CV came back as ["Salesforce", "Go"], the second of which
  // was the word "Google".
  const skills = matchSkills(clean);

  // Employment: lines that look like "Title, Company (dates)" or "Title at Company"
  const employment: NormalizedProfile['employment'] = [];
  // No fallback to the whole document. Treating every line as the experience
  // section is the swallowing bug in its purest form: a CV with no recognised
  // heading had its education, its skills list and its address read as jobs.
  // A CV we cannot find an experience section in has no employment we can
  // state, and the evidence parser below is the one that gets to try next.
  const expBody = sectionBody(clean, EXPERIENCE_HEADINGS);
  const dateRe = /(19|20)\d{2}/g;
  const roleLineRe = /^(.{3,60}?)(?:\s+(?:at|@|,|-|–|—|\|)\s+)(.{2,60}?)(?:\s*[\(\|].*)?$/;
  const bulletBuf: string[] = [];
  let current: NormalizedProfile['employment'][number] | null = null;
  for (const raw of expBody.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const isBullet = BULLET_PREFIX.test(raw) || /^\s{2,}/.test(raw);
    const m = line.match(roleLineRe);
    // A line that is only dates, or begins with one, is the date line under a
    // heading — not a job title. A career-timeline strip is made entirely of
    // those, and reading them as jobs is how "2017" became an employer.
    const isDateLine = /^[\s(]*(?:(?:19|20)\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(line)
      && !/[a-z]{4,}/i.test(line.replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*/gi, ''));
    if (m && !isBullet && !isDateLine && line.length < 90) {
      if (current) { current.bullets = bulletBuf.slice(); employment.push(current); bulletBuf.length = 0; }
      const dates = line.match(dateRe) ?? [];
      current = { title: m[1].trim(), company: m[2].replace(/[\(\|].*$/, '').trim(), start: dates[0], end: dates[1] ?? (/present|current/i.test(line) ? 'Present' : undefined), bullets: [] };
    } else if (current && isDateLine && !current.start) {
      // The dates for the role above, written on their own line beneath it.
      const dates = line.match(dateRe) ?? [];
      current.start = dates[0];
      current.end = dates[1] ?? (/present|current/i.test(line) ? 'Present' : undefined);
    } else if (current && (isBullet || line.length > 20)) {
      bulletBuf.push(stripBullet(line));
    }
  }
  if (current) { current.bullets = bulletBuf.slice(); employment.push(current); }

  // Education
  const education: NormalizedProfile['education'] = [];
  const eduBody = sectionBody(clean, ['education', 'academic', 'qualifications']);
  for (const raw of eduBody.split('\n')) {
    const line = stripBullet(raw);
    // "Digital Marketing Master's Program" is a course, and the word "Master"
    // in it is a marketing decision rather than an academic one.
    if (DEGREE_RE.test(line) && !/\b(program|programme|course|bootcamp|training|certification|certificate)\b/i.test(line)) {
      const year = line.match(dateRe)?.[0];
      // "— MBA" and "▪ B.Tech" are the glyphs a PDF leaves behind, not part of
      // anyone's degree.
      const degree = line.replace(dateRe, '').replace(/[,|].*$/, '').replace(/^[\s\-–—:]+/, '').trim().slice(0, 80);
      if (degree) education.push({ degree, institution: '', year });
    }
    if (education.length >= 6) break;
  }

  // Projects
  const projects: NormalizedProfile['projects'] = [];
  const projBody = sectionBody(clean, ['projects', 'project', 'key projects']);
  for (const raw of projBody.split('\n')) {
    const line = stripBullet(raw);
    if (line.length > 15) projects.push({ name: line.slice(0, 60), summary: line });
    if (projects.length >= 6) break;
  }

  // Certifications
  //
  // A certification is a named award, not a sentence. Without that test the
  // section picked up whatever followed it — one CV contributed "LANGUAGES"
  // and "English, Hindi" — and the list is shown to the hiring team as fact.
  const certifications: string[] = [];
  const certBody = sectionBody(clean, ['certifications', 'certification', 'certificates', 'licenses', 'licences', 'training', 'courses', 'coursework']);
  for (const raw of certBody.split('\n')) {
    const line = stripBullet(raw);
    if (line.length > 4 && line.length <= 120 && looksLikeCertification(line)) certifications.push(line.slice(0, 80));
    if (certifications.length >= 8) break;
  }

  // Years of experience: the union of the date ranges the CV writes down.
  // engines/experienceSpan.ts has the candidate who was credited with 31 years
  // because 1995 appears in her email address.
  //
  // Everything except education and training. Scanning the whole document
  // counts a course dated "Jul 2019 - Oct 2019" and a degree dated
  // "2010 - 2013" as time employed, and where those fall in a gap between
  // jobs they add years nobody worked.
  const totalYears = totalExperienceYears(withoutSections(clean, NON_EMPLOYMENT_SECTIONS));

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
