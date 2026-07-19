import mammoth from 'mammoth';
import type { NormalizedProfile } from '../domain/types.js';

/** Extract raw text from a resume buffer (PDF, DOCX, or plain text). */
export async function extractResumeText(buffer: Buffer, filename: string, mimetype = ''): Promise<string> {
  const name = filename.toLowerCase();
  if (name.endsWith('.pdf') || mimetype.includes('pdf')) {
    // Import the library file directly to avoid pdf-parse's debug harness.
    const mod: any = await import('pdf-parse/lib/pdf-parse.js');
    const pdfParse = mod.default ?? mod;
    const data = await pdfParse(buffer);
    return String(data.text ?? '').trim();
  }
  if (name.endsWith('.docx') || mimetype.includes('officedocument')) {
    const { value } = await mammoth.extractRawText({ buffer });
    return value.trim();
  }
  // txt / md / unknown -> treat as utf-8 text
  return buffer.toString('utf-8').trim();
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
