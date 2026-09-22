import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, DEMO_JD, DEMO_RESUME } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { purgeExpiredImportBatches } from '../src/services/candidateImport.js';

/**
 * Bulk import: stage people from a CSV or CVs, preview and fix them, then
 * confirm. Nothing is a candidate until confirm, and confirm goes through the
 * same services as Add candidate.
 */

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

let tenantId = '';
let adminToken = '';
let recruiterToken = '';
let otherRecruiterToken = '';
let managerToken = '';
let auditorToken = '';
let strangerToken = '';
let roleId = '';
let otherRoleId = '';
let hiddenRoleId = '';
let existingOnRoleId = '';
let knownElsewhereId = '';

async function makeUser(tenant: string, email: string, role: string) {
  const user = await prisma.user.create({ data: { tenantId: tenant, email, name: email, passwordHash: 'x', role } });
  return signToken({ userId: user.id, tenantId: tenant, role, email });
}

async function makeRole(token: string, title: string): Promise<string> {
  const res = await request(app).post('/api/roles').set(auth(token)).send({ sourceType: 'paste', sourceText: DEMO_JD, title, useLlm: false });
  const id = res.body.role.id as string;
  // Approved directly: the approval flow has its own tests, and interviews need an approved scorecard.
  await prisma.roleScorecardVersion.updateMany({ where: { roleId: id }, data: { status: 'approved', approvedAt: new Date() } });
  await prisma.role.update({ where: { id }, data: { status: 'approved' } });
  return id;
}

const start = (token: string, forRole: string) => request(app).post('/api/candidate-imports').set(auth(token)).send({ roleId: forRole });
const uploadCsv = (token: string, batchId: string, csv: string) =>
  request(app).post(`/api/candidate-imports/${batchId}/csv`).set(auth(token)).attach('file', Buffer.from(csv, 'utf-8'), { filename: 'people.csv', contentType: 'text/csv' });
const confirm = (token: string, batchId: string, rowKeys: string[]) =>
  request(app).post(`/api/candidate-imports/${batchId}/confirm`).set(auth(token)).send({ rowKeys });

interface Row { rowKey: string; email: string; fullName: string; status: string; outcome: string; candidateId: string | null; hasCv: boolean; included: boolean }
const byEmail = (rows: Row[], email: string): Row => rows.find((r) => r.email === email)!;
// Each part starts with no open imports, so the per-user cap only bites where it is tested.
const clearBatches = () => prisma.candidateImportBatch.deleteMany({ where: { tenantId } });

beforeAll(async () => {
  await wipe();
  const reg = await request(app).post('/api/auth/register').send({ email: 'admin@bulk.local', password: 'fixture-admin-passphrase', name: 'Admin', tenantName: 'Bulk Org' });
  adminToken = reg.body.token;
  tenantId = reg.body.user.tenantId;
  recruiterToken = await makeUser(tenantId, 'recruiter@bulk.local', 'recruiter');
  otherRecruiterToken = await makeUser(tenantId, 'other@bulk.local', 'recruiter');
  managerToken = await makeUser(tenantId, 'manager@bulk.local', 'manager');
  auditorToken = await makeUser(tenantId, 'auditor@bulk.local', 'auditor');
  const otherTenant = await request(app).post('/api/auth/register').send({ email: 'admin@elsewhere.local', password: 'fixture-admin-passphrase', name: 'Else', tenantName: 'Elsewhere' });
  strangerToken = otherTenant.body.token;

  roleId = await makeRole(recruiterToken, 'Senior Data Engineer');
  otherRoleId = await makeRole(recruiterToken, 'Platform Engineer');
  hiddenRoleId = await makeRole(otherRecruiterToken, 'Analytics Lead');

  const onRole = await request(app).post('/api/candidates').set(auth(recruiterToken)).send({ fullName: 'Already Here', email: 'already@example.com', roleId });
  existingOnRoleId = onRole.body.candidate.id;
  const known = await request(app).post('/api/candidates').set(auth(recruiterToken)).send({ fullName: 'Known Person', email: 'known@example.com', roleId: otherRoleId });
  knownElsewhereId = known.body.candidate.id;
  await request(app).post(`/api/candidates/${knownElsewhereId}/resume`).set(auth(recruiterToken)).send({ text: DEMO_RESUME });
});

describe('who may import', () => {
  it('refuses a hiring manager, who cannot add candidates', async () => {
    expect((await start(managerToken, roleId)).status).toBe(403);
  });

  it('refuses an auditor', async () => {
    expect((await start(auditorToken, roleId)).status).toBe(403);
  });

  it('refuses a role outside the recruiter\'s scope as not found', async () => {
    expect((await start(recruiterToken, hiddenRoleId)).status).toBe(404);
  });

  it('refuses an archived role', async () => {
    const archived = await makeRole(recruiterToken, 'Archived Role');
    await prisma.role.update({ where: { id: archived }, data: { status: 'archived' } });

    expect((await start(recruiterToken, archived)).status).toBe(409);
  });

  it('validates the start body', async () => {
    expect((await request(app).post('/api/candidate-imports').set(auth(recruiterToken)).send({ roleId, extra: 1 })).status).toBe(400);
  });
});

describe('the CSV preview', () => {
  beforeAll(clearBatches);

  let batchId = '';
  let rows: Row[] = [];

  beforeAll(async () => {
    batchId = (await start(recruiterToken, roleId)).body.batch.id;
    const csv = [
      'Full Name;E-mail;Phone;LinkedIn',
      'New Person;new@example.com;+91 98765 43210;linkedin.com/in/new',
      'Already Here;ALREADY@example.com;;',
      'Known Person;known@example.com;;',
      'No Address;;;',
      'Bad Address;not-an-address;;',
      'New Again;new@example.com;;',
    ].join('\n');
    const res = await uploadCsv(recruiterToken, batchId, csv);
    rows = res.body.rows;
  });

  it('marks a new person ready', () => {
    expect(byEmail(rows, 'new@example.com').status).toBe('ready');
  });

  it('marks someone already on the role as existing', () => {
    expect(byEmail(rows, 'ALREADY@example.com').status).toBe('existing');
  });

  it('marks someone on another visible role as known', () => {
    expect(byEmail(rows, 'known@example.com').status).toBe('known');
  });

  it('marks a missing address', () => {
    expect(rows.find((r) => r.fullName === 'No Address')!.status).toBe('missing_email');
  });

  it('marks an invalid address', () => {
    expect(byEmail(rows, 'not-an-address').status).toBe('invalid_email');
  });

  it('marks a repeat within the file', () => {
    expect(rows.find((r) => r.fullName === 'New Again')!.status).toBe('duplicate_in_batch');
  });

  it('creates nothing before confirm', async () => {
    expect(await prisma.candidate.count({ where: { tenantId, email: 'new@example.com' } })).toBe(0);
  });

  it('keeps a LinkedIn link only as an https linkedin.com address', async () => {
    const row = await prisma.candidateImportRow.findFirstOrThrow({ where: { batchId, email: 'new@example.com' } });

    expect(row.linkedinUrl).toBe('https://linkedin.com/in/new');
  });

  it('lets a row be fixed, and re-judges it', async () => {
    const key = rows.find((r) => r.fullName === 'Bad Address')!.rowKey;
    const res = await request(app).patch(`/api/candidate-imports/${batchId}/rows/${key}`).set(auth(recruiterToken)).send({ email: 'fixed@example.com' });

    expect(res.body.rows.find((r: Row) => r.rowKey === key).status).toBe('ready');
  });

  it('frees the repeat once the first row is unticked', async () => {
    const first = byEmail(rows, 'new@example.com').rowKey;
    const res = await request(app).patch(`/api/candidate-imports/${batchId}/rows/${first}`).set(auth(recruiterToken)).send({ included: false });

    expect(res.body.rows.find((r: Row) => r.fullName === 'New Again').status).toBe('ready');
  });

  it('refuses an unknown field in an edit', async () => {
    const key = rows[0].rowKey;

    expect((await request(app).patch(`/api/candidate-imports/${batchId}/rows/${key}`).set(auth(recruiterToken)).send({ outcome: 'created' })).status).toBe(400);
  });
});

describe('batch limits', () => {
  beforeAll(clearBatches);

  const people = (n: number, from = 0) => ['name,email', ...Array.from({ length: n }, (_, i) => `P ${i + from},p${i + from}@limits.example`)].join('\n');

  it('refuses a CSV of more than 200 people', async () => {
    const batchId = (await start(recruiterToken, roleId)).body.batch.id;

    expect((await uploadCsv(recruiterToken, batchId, people(201))).status).toBe(400);
  });

  it('refuses a second file that would take the import past 200', async () => {
    const batchId = (await start(recruiterToken, roleId)).body.batch.id;
    await uploadCsv(recruiterToken, batchId, people(150));

    expect((await uploadCsv(recruiterToken, batchId, people(60, 150))).status).toBe(400);
  });

  it('refuses an upload that collides with another one on the same batch, without a 500', async () => {
    const batchId = (await start(recruiterToken, roleId)).body.batch.id;
    // What a second upload running at the same moment would have written first.
    await prisma.candidateImportRow.create({ data: { batchId, tenantId, rowKey: 'r2', position: 2 } });

    expect((await uploadCsv(recruiterToken, batchId, people(1))).status).toBe(409);
  });

  it('refuses more than five CVs in one request', async () => {
    const batchId = (await start(recruiterToken, roleId)).body.batch.id;
    const req = request(app).post(`/api/candidate-imports/${batchId}/cvs`).set(auth(recruiterToken));
    for (let i = 0; i < 6; i++) req.attach('files', Buffer.from(`Person Number\np${i}@example.com`), { filename: `p${i}.txt`, contentType: 'text/plain' });

    expect((await req).status).toBe(400);
  });

  it('refuses a file that is not a CSV on the CSV route', async () => {
    const batchId = (await start(recruiterToken, roleId)).body.batch.id;
    const res = await request(app).post(`/api/candidate-imports/${batchId}/csv`).set(auth(recruiterToken))
      .attach('file', Buffer.from('%PDF-1.4'), { filename: 'x.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
  });

  it('does not count an import people were added from', async () => {
    const token = await makeUser(tenantId, 'finished@bulk.local', 'recruiter');
    const role = await makeRole(token, 'Finished Role');
    for (let i = 0; i < 10; i++) {
      const batchId = (await start(token, role)).body.batch.id;
      await uploadCsv(token, batchId, `name,email
Done ${i},done${i}@finished.example`);
      await confirm(token, batchId, ['r1']);
    }

    expect((await start(token, role)).status).toBe(201);
  });

  it('caps how many imports one person keeps open', async () => {
    const token = await makeUser(tenantId, 'busy@bulk.local', 'recruiter');
    const role = await makeRole(token, 'Busy Role');
    for (let i = 0; i < 10; i++) await start(token, role);

    expect((await start(token, role)).status).toBe(409);
  });
});

describe('CV upload', () => {
  beforeAll(clearBatches);

  let rows: Row[] = [];
  let batchId = '';

  beforeAll(async () => {
    batchId = (await start(recruiterToken, roleId)).body.batch.id;
    const res = await request(app).post(`/api/candidate-imports/${batchId}/cvs`).set(auth(recruiterToken))
      .attach('files', Buffer.from(`Ravi Kumar\nravi.kumar@example.com\n\n${DEMO_RESUME}`), { filename: 'ravi.txt', contentType: 'text/plain' })
      .attach('files', Buffer.from('not really a pdf'), { filename: 'broken.pdf', contentType: 'application/pdf' });
    rows = res.body.rows;
  });

  it('reads the name from the CV', () => {
    expect(byEmail(rows, 'ravi.kumar@example.com').fullName).toBe('Ravi Kumar');
  });

  it('marks the row as carrying a CV', () => {
    expect(byEmail(rows, 'ravi.kumar@example.com').hasCv).toBe(true);
  });

  it('reports a CV it could not read as its own row', () => {
    expect(rows.find((r) => r.email === '')!.status).toBe('unreadable');
  });

  it('never sends the CV text back in the preview', async () => {
    const res = await request(app).get(`/api/candidate-imports/${batchId}`).set(auth(recruiterToken));

    expect(JSON.stringify(res.body)).not.toContain('EXPERIENCE');
  });
});

describe('tenant isolation', () => {
  beforeAll(clearBatches);

  let batchId = '';

  beforeAll(async () => {
    batchId = (await start(recruiterToken, roleId)).body.batch.id;
  });

  it('hides a batch from another organisation', async () => {
    expect((await request(app).get(`/api/candidate-imports/${batchId}`).set(auth(strangerToken))).status).toBe(404);
  });

  it('hides a batch from a colleague', async () => {
    expect((await request(app).get(`/api/candidate-imports/${batchId}`).set(auth(otherRecruiterToken))).status).toBe(404);
  });

  it('does not let a colleague confirm it', async () => {
    expect((await confirm(otherRecruiterToken, batchId, ['r1'])).status).toBe(404);
  });

  it('stops showing an import to someone taken off its role', async () => {
    const token = await makeUser(tenantId, 'moved@bulk.local', 'recruiter');
    const role = await makeRole(token, 'Moved Role');
    const moved = (await start(token, role)).body.batch.id;
    await prisma.roleAssignment.deleteMany({ where: { roleId: role } });

    expect((await request(app).get(`/api/candidate-imports/${moved}`).set(auth(token))).status).toBe(404);
  });

  it('still lets someone taken off the role discard their import', async () => {
    const token = await makeUser(tenantId, 'moved2@bulk.local', 'recruiter');
    const role = await makeRole(token, 'Moved Role 2');
    const moved = (await start(token, role)).body.batch.id;
    await prisma.roleAssignment.deleteMany({ where: { roleId: role } });

    expect((await request(app).delete(`/api/candidate-imports/${moved}`).set(auth(token))).status).toBe(204);
  });

  it('does not name a person seen only in a pipeline the recruiter cannot see', async () => {
    await request(app).post('/api/candidates').set(auth(otherRecruiterToken)).send({ fullName: 'Hidden', email: 'hidden@example.com', roleId: hiddenRoleId });
    const res = await uploadCsv(recruiterToken, batchId, 'name,email\nHidden,hidden@example.com');

    expect(byEmail(res.body.rows, 'hidden@example.com').status).toBe('ready');
  });
});

describe('confirm', () => {
  beforeAll(clearBatches);

  let batchId = '';
  let preview: Row[] = [];
  let results: { rowKey: string; outcome: string; candidateId: string | null; interview: unknown }[] = [];

  beforeAll(async () => {
    batchId = (await start(recruiterToken, roleId)).body.batch.id;
    await uploadCsv(recruiterToken, batchId, 'name,email\nCsv Person,csv.person@example.com\nAlready Here,already@example.com\nKnown Person,known@example.com\nNo Address,');
    const cv = await request(app).post(`/api/candidate-imports/${batchId}/cvs`).set(auth(recruiterToken))
      .attach('files', Buffer.from(`Meera Iyer\nmeera@example.com\n\n${DEMO_RESUME}`), { filename: 'meera.txt', contentType: 'text/plain' });
    preview = cv.body.rows;
    const res = await confirm(recruiterToken, batchId, preview.map((r) => r.rowKey));
    results = res.body.results;
  });

  const resultFor = (email: string) => results.find((r) => r.rowKey === byEmail(preview, email).rowKey)!;

  it('creates a candidate on the role for a new person', async () => {
    const created = await prisma.candidate.findUniqueOrThrow({ where: { id: resultFor('csv.person@example.com').candidateId! } });

    expect({ roleId: created.roleId, email: created.email }).toEqual({ roleId, email: 'csv.person@example.com' });
  });

  it('links, not duplicates, someone already on the role', async () => {
    expect(resultFor('already@example.com')).toMatchObject({ outcome: 'linked', candidateId: existingOnRoleId });
  });

  it('keeps one application per person on the role', async () => {
    expect(await prisma.candidate.count({ where: { roleId, emailNormalized: 'already@example.com' } })).toBe(1);
  });

  it('reuses a known person with their resume carried over', async () => {
    const id = resultFor('known@example.com').candidateId!;

    expect(await prisma.candidateProfileVersion.count({ where: { candidateId: id } })).toBe(1);
  });

  it('attaches the CV to a person added from one', async () => {
    const id = resultFor('meera@example.com').candidateId!;

    expect(await prisma.artifact.count({ where: { candidateId: id, kind: 'resume', filename: 'meera.txt' } })).toBe(1);
  });

  it('puts a person added from a CV at Bronze', async () => {
    const id = resultFor('meera@example.com').candidateId!;

    expect((await prisma.candidatePipeline.findFirstOrThrow({ where: { candidateId: id } })).currentStageKey).toBe('bronze');
  });

  it('records the creation in the audit trail, as Add candidate does', async () => {
    const id = resultFor('meera@example.com').candidateId!;

    expect(await prisma.auditEvent.count({ where: { entityId: id, action: { in: ['candidate.created', 'candidate.parsed'] } } })).toBe(2);
  });

  it('gives the recruiter ownership of each new candidate', async () => {
    const id = resultFor('csv.person@example.com').candidateId!;

    expect(await prisma.candidateAssignment.count({ where: { candidateId: id } })).toBe(1);
  });

  it('leaves a row that needs a fix alone', () => {
    expect(results.find((r) => r.rowKey === preview.find((p) => p.fullName === 'No Address')!.rowKey)!.outcome).toBe('pending');
  });

  it('answers a repeat with the same people and creates nobody new', async () => {
    const before = await prisma.candidate.count({ where: { tenantId } });
    const again = await confirm(recruiterToken, batchId, preview.map((r) => r.rowKey));

    expect({ count: await prisma.candidate.count({ where: { tenantId } }), ids: again.body.results.map((r: { candidateId: string }) => r.candidateId) })
      .toEqual({ count: before, ids: results.map((r) => r.candidateId) });
  });

  it('refuses to edit a row that has been added', async () => {
    const key = byEmail(preview, 'csv.person@example.com').rowKey;

    expect((await request(app).patch(`/api/candidate-imports/${batchId}/rows/${key}`).set(auth(recruiterToken)).send({ fullName: 'Changed' })).status).toBe(409);
  });

  it('refuses more than 25 rows in one confirm', async () => {
    expect((await confirm(recruiterToken, batchId, Array.from({ length: 26 }, (_, i) => `r${i + 1}`))).status).toBe(400);
  });

  it('refuses a hiring manager', async () => {
    expect((await confirm(managerToken, batchId, ['r1'])).status).toBe(403);
  });

  it('reports no interview yet for a new candidate', () => {
    expect(resultFor('csv.person@example.com').interview).toBeNull();
  });
});

describe('the invite handoff', () => {
  beforeAll(clearBatches);

  let candidateIds: string[] = [];

  beforeAll(async () => {
    const batchId = (await start(recruiterToken, roleId)).body.batch.id;
    await uploadCsv(recruiterToken, batchId, 'name,email\nInvite One,invite1@example.com\nInvite Two,invite2@example.com');
    const res = await confirm(recruiterToken, batchId, ['r1', 'r2']);
    candidateIds = res.body.results.map((r: { candidateId: string }) => r.candidateId);
    await request(app).post('/api/interviews').set(auth(recruiterToken)).send({ candidateId: candidateIds[0], approve: true });
  });

  it('invites an imported candidate once an interview is set up, through bulk-invite', async () => {
    const res = await request(app).post('/api/interviews/bulk-invite').set(auth(recruiterToken)).send(candidateIds.map((candidateId) => ({ candidateId })));

    expect(res.body.results.map((r: { success: boolean }) => r.success)).toEqual([true, false]);
  });

  it('reports the interview on a repeat confirm, for the invite step', async () => {
    const batchId = (await start(recruiterToken, roleId)).body.batch.id;
    await uploadCsv(recruiterToken, batchId, 'name,email\nInvite One,invite1@example.com');
    const res = await confirm(recruiterToken, batchId, ['r1']);

    expect(res.body.results[0].interview).toMatchObject({ state: 'INVITED' });
  });
});

describe('cleanup and erasure', () => {
  beforeEach(clearBatches);

  it('purges an expired batch with its rows', async () => {
    const batchId = (await start(recruiterToken, roleId)).body.batch.id;
    await uploadCsv(recruiterToken, batchId, 'name,email\nGone Soon,gone@example.com');
    await prisma.candidateImportBatch.update({ where: { id: batchId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await purgeExpiredImportBatches();

    expect(await prisma.candidateImportRow.count({ where: { batchId } })).toBe(0);
  });

  it('treats an expired batch as not found', async () => {
    const batchId = (await start(recruiterToken, roleId)).body.batch.id;
    await prisma.candidateImportBatch.update({ where: { id: batchId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    expect((await request(app).get(`/api/candidate-imports/${batchId}`).set(auth(recruiterToken))).status).toBe(404);
  });

  it('removes a person\'s staged rows when they are erased', async () => {
    const batchId = (await start(recruiterToken, roleId)).body.batch.id;
    await uploadCsv(recruiterToken, batchId, 'name,email\nErase Me,erase.me@example.com');
    const [row] = (await confirm(recruiterToken, batchId, ['r1'])).body.results;
    const other = (await start(recruiterToken, otherRoleId)).body.batch.id;
    await uploadCsv(recruiterToken, other, 'name,email\nErase Me,Erase.Me@example.com');
    await request(app).delete(`/api/candidates/${row.candidateId}`).set(auth(adminToken)).send({ reason: 'asked' });

    expect(await prisma.candidateImportRow.count({ where: { tenantId, emailNormalized: 'erase.me@example.com' } })).toBe(0);
  });

  it('discards a batch on request', async () => {
    const batchId = (await start(recruiterToken, roleId)).body.batch.id;
    await request(app).delete(`/api/candidate-imports/${batchId}`).set(auth(recruiterToken));

    expect(await prisma.candidateImportBatch.count({ where: { id: batchId } })).toBe(0);
  });
});
