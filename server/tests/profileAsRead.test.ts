import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { wipe } from '../src/seed/demoData.js';
import { prisma } from '../src/db.js';
import { signToken } from '../src/services/auth.js';
import { extractCvFacts } from '../src/engines/cvFacts.js';

/**
 * Lane 1: the reading of a CV that owes nothing to any role.
 *
 * The evidence-backed facts have been parsed and stored since the fit engine
 * was written, and no screen has ever shown them. HR saw a fit score against
 * one role and a legacy summary with no provenance — so "what does this CV
 * actually say, and where" had no answer in the product, and the only way to
 * check a parse was to read the CV again.
 *
 * `profileRead` is that answer: role-agnostic, every fact carrying the document
 * line it came from, and nothing about how good a match anybody is.
 */

const app = createApp();

const CV = [
  'Meera Iyer',
  'meera.iyer@example.com | +91 98765 43210',
  '',
  'EXPERIENCE',
  'Senior Data Engineer, Northwind Logistics (March 2021 - Present)',
  'Rebuilt the nightly ETL on Airflow 2.x.',
  'Led a team of 6 engineers across two time zones.',
  '',
  'EDUCATION',
  'B.Tech Computer Science, Anna University, 2016',
].join('\n');

/** The read path is what is under test, so the row is written directly. */
async function storeProfile(candidateId: string) {
  await prisma.candidateProfileVersion.create({
    data: {
      candidateId,
      version: 1,
      rawText: CV,
      profileJson: '{}',
      fitScoreJson: '{}',
      cvFactsJson: JSON.stringify(extractCvFacts(CV)),
    },
  });
}

async function candidateWithCv() {
  const tenant = await prisma.tenant.create({ data: { name: 'Lane One Org' } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, email: 'hr@laneone.local', name: 'Asha', passwordHash: 'x', role: 'admin' },
  });
  const role = await prisma.role.create({ data: { tenantId: tenant.id, title: 'Data Engineer', status: 'approved' } });
  const candidate = await prisma.candidate.create({
    data: { tenantId: tenant.id, roleId: role.id, fullName: 'Meera Iyer', email: 'meera@laneone.local' },
  });
  await storeProfile(candidate.id);
  return {
    candidateId: candidate.id,
    token: signToken({ userId: user.id, tenantId: tenant.id, role: 'admin', email: user.email }),
  };
}

const read = (id: string, token: string) =>
  request(app).get(`/api/candidates/${id}/profile-analysis`).set('Authorization', `Bearer ${token}`);

beforeEach(async () => {
  await wipe();
});

describe('the profile as read', () => {
  it('returns the roles the CV states, without being asked about a role', async () => {
    const { candidateId, token } = await candidateWithCv();

    const res = await read(candidateId, token);

    expect(res.body.profileRead?.roles?.[0]?.employer).toContain('Northwind');
  });

  it('gives every role the document line a reader can open the CV at', async () => {
    const { candidateId, token } = await candidateWithCv();

    const res = await read(candidateId, token);

    // Line 5 of the CV above. Not line 2, which is where an index into the
    // lines the scorer kept would point after the header block was dropped.
    expect(res.body.profileRead.roles[0].evidence.sourceLine).toBe(5);
  });

  it('carries the scope the CV states as its own kind of fact', async () => {
    const { candidateId, token } = await candidateWithCv();

    const res = await read(candidateId, token);

    const team = res.body.profileRead.scope.find((s: { kind: string }) => s.kind === 'team');
    expect(team?.value).toContain('6');
  });

  it('says what it took out, so an empty section is never read as an empty CV', async () => {
    const { candidateId, token } = await candidateWithCv();

    const res = await read(candidateId, token);

    expect(res.body.profileRead.redaction.linesRemoved).toBeGreaterThan(0);
  });

  it('does not ship the scorer lines to the browser', async () => {
    // `lines` is the scorer's input, and the browser has the real document
    // already. Sending both doubles the payload and invites a second, subtly
    // different, rendering of the CV.
    const { candidateId, token } = await candidateWithCv();

    const res = await read(candidateId, token);

    expect(res.body.profileRead.lines).toBeUndefined();
  });

  it('is present even when no role has an approved scorecard to score against', async () => {
    // The whole point of Lane 1: reading the person does not wait on a role.
    const tenant = await prisma.tenant.create({ data: { name: 'No Scorecard Org' } });
    const user = await prisma.user.create({
      data: { tenantId: tenant.id, email: 'hr@nosc.local', name: 'Asha', passwordHash: 'x', role: 'admin' },
    });
    const candidate = await prisma.candidate.create({
      data: { tenantId: tenant.id, fullName: 'Meera Iyer', email: 'meera@nosc.local' },
    });
    await storeProfile(candidate.id);
    const token = signToken({ userId: user.id, tenantId: tenant.id, role: 'admin', email: user.email });

    const res = await read(candidate.id, token);

    // No approved scorecard means no score to give — and the reading is there
    // anyway, which is the whole of Lane 1's claim.
    expect([res.status, res.body.currentFit?.overall ?? null, res.body.profileRead.roles.length])
      .toEqual([200, null, 1]);
  });
});
