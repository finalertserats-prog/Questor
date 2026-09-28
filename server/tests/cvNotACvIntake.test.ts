import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, DEMO_JD } from '../src/seed/demoData.js';

/**
 * The document that is not a CV, at the door rather than at the desk.
 *
 * Observed: a file of whitespace, rules and bullets scored 22 out of 100 and
 * the journey board offered "Move to Silver" underneath it. Every part of
 * that is built from nothing — there is no candidate in the document — and a
 * number built from nothing is worse than no number, because it sits in the
 * same column as the real ones and a recruiter cannot tell them apart.
 *
 * The upload guard already refused a file with NO text, and this one had
 * plenty: punctuation is text. So the question the guard asks is now "is any
 * of this words", and it is asked at `attachResume`, which is the one place
 * every CV passes through — the single upload, the pasted text, the bulk
 * import and the apply-to-another-role path. Nothing is stored, so there is
 * no profile version, no fit score, no Bronze award and no stage to advance
 * from. The recruiter is told what to look at instead.
 */

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const NOISE = readFileSync(fileURLToPath(new URL('./fixtures/cv/noise-dashes.txt', import.meta.url)), 'utf8');
const REAL_CV = readFileSync(fileURLToPath(new URL('./fixtures/cv/en-standard.txt', import.meta.url)), 'utf8');

let recruiterToken = '';
let candidateId = '';

beforeAll(async () => {
  await prisma.candidateAssignment.deleteMany();
  await prisma.roleAssignment.deleteMany();
  await wipe();
  const reg = await request(app).post('/api/auth/register').send({
    email: 'admin@notacv.local', password: 'fixture-admin-passphrase', name: 'Admin', tenantName: 'Not A CV Org',
  });
  recruiterToken = reg.body.token;
  const roleRes = await request(app).post('/api/roles').set(auth(recruiterToken))
    .send({ sourceType: 'paste', sourceText: DEMO_JD, title: 'Senior Data Engineer', useLlm: false });
  const candRes = await request(app).post('/api/candidates').set(auth(recruiterToken))
    .send({ fullName: 'Priya Sharma', email: 'priya@notacv.local', roleId: roleRes.body.role.id });
  candidateId = candRes.body.candidate.id;
});

describe('a page of rules and bullets pasted as a CV', () => {
  it('is refused rather than scored', async () => {
    const res = await request(app).post(`/api/candidates/${candidateId}/resume`)
      .set(auth(recruiterToken)).send({ text: NOISE });
    expect(res.status).toBe(422);
  });

  it('says what is wrong with the document, not with the candidate', async () => {
    const res = await request(app).post(`/api/candidates/${candidateId}/resume`)
      .set(auth(recruiterToken)).send({ text: NOISE });
    expect(res.body.error ?? res.body.message).toMatch(/spacing and punctuation/i);
    expect(JSON.stringify(res.body)).not.toMatch(/candidate|applicant|suspicious/i);
  });

  it('leaves no profile version behind, so there is no score and nothing to promote', async () => {
    await request(app).post(`/api/candidates/${candidateId}/resume`)
      .set(auth(recruiterToken)).send({ text: NOISE });
    expect(await prisma.candidateProfileVersion.count({ where: { candidateId } })).toBe(0);
  });

  it('strikes no Bronze award for a reading that never happened', async () => {
    await request(app).post(`/api/candidates/${candidateId}/resume`)
      .set(auth(recruiterToken)).send({ text: NOISE });
    expect(await prisma.candidateAward.count({ where: { candidateId } })).toBe(0);
  });
});

describe('the same endpoint with a real CV', () => {
  it('still reads it, so the guard has not simply closed the door', async () => {
    const res = await request(app).post(`/api/candidates/${candidateId}/resume`)
      .set(auth(recruiterToken)).send({ text: REAL_CV });
    expect(res.status).toBe(201);
    expect(await prisma.candidateProfileVersion.count({ where: { candidateId } })).toBe(1);
  });
});
