import { describe, expect, it } from 'vitest';
import { extractContact, nameFromFilename, normalizeLinkedinUrl } from '../src/engines/resumeContact.js';

/** Who a CV belongs to, read from its own text, for bulk import's preview. */

const CV = [
  'Priya Sharma',
  'Senior Data Engineer',
  'Bengaluru, India | priya.sharma@example.com | +91 98765 43210',
  'linkedin.com/in/priya-sharma',
  '',
  'EXPERIENCE',
  'Data Engineer at Acme (2019 - Present)',
].join('\n');

describe('extractContact', () => {
  it('reads the name from the first line that looks like one', () => {
    expect(extractContact(CV, 'cv.pdf').fullName).toBe('Priya Sharma');
  });

  it('reads the first email address', () => {
    expect(extractContact(CV, 'cv.pdf').email).toBe('priya.sharma@example.com');
  });

  it('reads a phone number', () => {
    expect(extractContact(CV, 'cv.pdf').phone).toBe('+91 98765 43210');
  });

  it('reads a LinkedIn profile written without a scheme', () => {
    expect(extractContact(CV, 'cv.pdf').linkedinUrl).toBe('https://linkedin.com/in/priya-sharma');
  });

  it('skips a heading such as "Curriculum Vitae" when looking for the name', () => {
    expect(extractContact('CURRICULUM VITAE\nLee Chan\nlee@example.com', 'x.pdf').fullName).toBe('Lee Chan');
  });

  it('falls back to the file name when no line reads as a name', () => {
    expect(extractContact('lee@example.com\n2019-2023 things', 'Lee_Chan_CV.pdf').fullName).toBe('Lee Chan');
  });

  it('leaves the email empty when the CV has none', () => {
    expect(extractContact('Lee Chan\nNo address here', 'x.pdf').email).toBe('');
  });
});

describe('nameFromFilename', () => {
  it('drops extension, separators and words like resume', () => {
    expect(nameFromFilename('ana-lopez-resume-2024.docx')).toBe('Ana Lopez');
  });

  it('gives nothing for a file name with no name in it', () => {
    expect(nameFromFilename('CV.pdf')).toBe('');
  });
});

describe('normalizeLinkedinUrl', () => {
  it('keeps an https linkedin.com address', () => {
    expect(normalizeLinkedinUrl('https://www.linkedin.com/in/lee')).toBe('https://www.linkedin.com/in/lee');
  });

  it('adds https to a bare address', () => {
    expect(normalizeLinkedinUrl('in.linkedin.com/in/lee')).toBe('https://in.linkedin.com/in/lee');
  });

  it('refuses any other site', () => {
    expect(normalizeLinkedinUrl('https://linkedin.com.evil.example/in/lee')).toBe('');
  });

  it('refuses a javascript: link', () => {
    expect(normalizeLinkedinUrl('javascript:alert(1)//linkedin.com')).toBe('');
  });
});

describe('extractContact phone numbers', () => {
  it('does not mistake a date range for a phone number', () => {
    expect(extractContact('Lee Chan\nAcme 2019 - 2023\nBeta 2015-2019', 'x.pdf').phone).toBe('');
  });
});
