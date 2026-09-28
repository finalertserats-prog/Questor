import { describe, expect, it } from 'vitest';
import { readResumeFile } from '../src/services/resumeFile.js';
import { HttpError } from '../src/middleware/index.js';

/**
 * The gate between an uploaded file and a candidate's CV.
 *
 * Extraction can succeed and produce nothing, and that is worse than failing,
 * because nothing throws. A scanned CV has no text layer: the reader reports
 * its pages and returns a few newlines. The upload used to report success, and
 * the recruiter was given a candidate with no skills, no history and a fit
 * score built from an empty string — while the one fact that would have
 * helped, that the file is a picture, was the one nobody was told.
 *
 * The same silence was found on the job-description path first (see
 * services/jdSourceText.ts); this is the candidate side of it.
 */

const TEXT = 'text/plain';

async function refusal(body: string): Promise<HttpError> {
  try {
    await readResumeFile({ buffer: Buffer.from(body, 'utf-8'), mimetype: TEXT });
  } catch (err) {
    return err as HttpError;
  }
  throw new Error('expected a refusal');
}

const REAL_CV = [
  'Kajal Vishwakarma Joshi',
  'Senior Marketing Manager',
  '',
  'WORK EXPERIENCE',
  'Marketing Manager, Genesys International (2024 - Present)',
  'Led end-to-end B2B digital marketing campaigns across email, social and events.',
  'Managed the annual marketing budget across channels.',
  '',
  'EDUCATION',
  'B.Com, University of Mumbai (2013)',
].join('\n');

describe('a file with no text in it', () => {
  it('is refused rather than accepted as an empty CV', async () => {
    const err = await refusal('\n\n\n\n\n\n');
    expect(err.status).toBe(422);
  });

  it('says the file is a picture, so the person knows what to do next', async () => {
    // "Could not read the file" sends someone back to upload the same file.
    const err = await refusal('   \n  \n');
    expect(err.message).toMatch(/scan or a photo/i);
    expect(err.message).toMatch(/paste the CV text/i);
  });

  it('tells a nearly-empty file apart from a picture', async () => {
    const err = await refusal('Kajal Joshi\nMarketing\n');
    expect(err.message).toMatch(/very little text/i);
  });
});

describe('a file with a CV in it', () => {
  it('is read and handed back whole', async () => {
    expect(await readResumeFile({ buffer: Buffer.from(REAL_CV, 'utf-8'), mimetype: TEXT })).toContain('Genesys');
  });

  it('keeps the text exactly as extracted, trimming nothing a parser needs', async () => {
    const read = await readResumeFile({ buffer: Buffer.from(REAL_CV, 'utf-8'), mimetype: TEXT });
    expect(read.split('\n').filter((l) => l.trim() === 'WORK EXPERIENCE')).toHaveLength(1);
  });
});
