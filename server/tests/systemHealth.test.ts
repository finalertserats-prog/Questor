import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { config } from '../src/config.js';
import { wipe, createDemoData } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { _resetRateLimits } from '../src/middleware/rateLimit.js';
import { _setSystemHealthDepsForTest, rollupStatus, runCheck } from '../src/services/systemHealth.js';
import { backupsSection, judgeDisk, BACKUP_WARN_AGE_MS, BACKUP_FAIL_AGE_MS, PRODUCTION_BACKUP_DIR } from '../src/services/systemHealthPlatform.js';
import { judgeJob, judgeLibraryWorker, KNOWN_JOBS, JOB_MIN_WARN_MS } from '../src/services/systemHealthJobs.js';
import type { WorkerStatus } from '../src/library/workerState.js';
import { judgeModelFailures } from '../src/services/systemHealthDelivery.js';
import type { HealthDeps, HealthReport, HealthCheck } from '../src/services/systemHealthTypes.js';

/**
 * The Admin console's System health panel. What matters most: a tenant admin
 * never sees the deployment or another organisation, one hung dependency does
 * not hang the page, and no setting's value ever reaches the browser.
 */

const OPERATOR_EMAIL = 'operator@example.com';
const DUMMY_SECRET = 'sg-dummy-secret-value-0451';
const PRIVATE_BACKUP_DIR = '/very/private/backup-path-xyz';
const HOUR = 60 * 60_000;

function fakeDeps(overrides: Partial<HealthDeps> = {}): HealthDeps {
  return {
    now: () => new Date(),
    env: { ...process.env, BACKUP_DIR: PRIVATE_BACKUP_DIR },
    nodeEnv: 'test',
    timeoutMs: 3_000,
    statfs: async () => ({ bavail: 50, blocks: 100, bsize: 4096 }),
    listDir: async () => ['questor-nightly-20260917-023001.dump'],
    statFile: async () => ({ size: 1024, mtime: new Date(Date.now() - HOUR) }),
    diskPath: '/data',
    memoryRss: () => 100 * 1024 * 1024,
    uptimeSeconds: () => 3600,
    isDraining: () => false,
    commit: () => 'abc123',
    databaseUrl: () => 'file:./data/test.db',
    ...overrides,
  };
}

const app = createApp();
let tenantAToken = '';
let tenantBToken = '';
let operatorToken = '';
let recruiterToken = '';
let tenantBId = '';

beforeAll(async () => {
  await prisma.candidateAssignment.deleteMany();
  await prisma.roleAssignment.deleteMany();
  await prisma.jobRun.deleteMany();
  await wipe();
  const demo = await createDemoData();
  tenantBId = demo.tenantId;
  tenantBToken = signToken({ userId: demo.userId, tenantId: demo.tenantId, role: 'admin', email: demo.email });

  const reg = await request(app).post('/api/auth/register').send({
    email: 'admin@health-a.local', password: 'fixture-admin-passphrase', name: 'Health Admin', tenantName: 'Health A',
  });
  tenantAToken = reg.body.token;
  const tenantAId: string = reg.body.user.tenantId;

  const operator = await prisma.user.create({ data: { tenantId: tenantAId, email: OPERATOR_EMAIL, name: 'Operator', passwordHash: 'x', role: 'admin' } });
  operatorToken = signToken({ userId: operator.id, tenantId: tenantAId, role: 'admin', email: operator.email });
  const recruiter = await prisma.user.create({ data: { tenantId: tenantAId, email: 'rec@health-a.local', name: 'Rec', passwordHash: 'x', role: 'recruiter' } });
  recruiterToken = signToken({ userId: recruiter.id, tenantId: tenantAId, role: 'recruiter', email: recruiter.email });

  // Tenant B has trouble: failed webhook deliveries and an interview stuck finishing.
  const endpoint = await prisma.webhookEndpoint.create({ data: { tenantId: tenantBId, url: 'https://hooks.example.com/b' } });
  for (let i = 0; i < 3; i += 1) {
    await prisma.webhookDelivery.create({ data: { endpointId: endpoint.id, event: 'x', payloadJson: '{}', status: 'failed' } });
  }
  await prisma.interviewSession.update({ where: { id: demo.sessionId }, data: { state: 'PROCESSING', updatedAt: new Date(Date.now() - 3 * HOUR) } });
  // ...and a feedback email the provider refused for good.
  const assessment = await prisma.assessmentVersion.create({ data: { sessionId: demo.sessionId, scorecardId: demo.scorecardId } });
  await prisma.candidateFeedbackEmail.create({
    data: { sessionId: demo.sessionId, assessmentId: assessment.id, candidateId: demo.candidateId, tenantId: tenantBId, status: 'FAILED', lastError: 'SMTP 535' },
  });

  // A failing job whose note carries a secret and an internal address.
  process.env.SENDGRID_API_KEY = DUMMY_SECRET;
  await prisma.jobRun.create({
    data: {
      name: 'webhook-delivery', holder: 'test', finishedAt: new Date(), ok: false,
      note: `auth failed with ${DUMMY_SECRET} at postgresql://questor:pw@db.internal:5432/questor`,
    },
  });
});

beforeEach(() => {
  config.signupApproverEmail = OPERATOR_EMAIL;
  _resetRateLimits();
  _setSystemHealthDepsForTest(fakeDeps());
});

afterAll(() => {
  _setSystemHealthDepsForTest(null);
  delete process.env.SENDGRID_API_KEY;
});

const getHealth = (token: string) => request(app).get('/api/admin/health').set({ Authorization: `Bearer ${token}` });
const sectionIds = (report: HealthReport) => report.sections.map((s) => s.id);
const findCheck = (report: HealthReport, sectionId: string, checkId: string): HealthCheck | undefined =>
  report.sections.find((s) => s.id === sectionId)?.checks.find((c) => c.id === checkId);

describe('the overall status', () => {
  it('is ok when every check is ok or informational', () => {
    expect(rollupStatus([{ status: 'ok' }, { status: 'info' }])).toBe('ok');
  });

  it('is ok when there is nothing but information', () => {
    expect(rollupStatus([{ status: 'info' }])).toBe('ok');
  });

  it('is warn when the worst check is a warning', () => {
    expect(rollupStatus([{ status: 'ok' }, { status: 'warn' }, { status: 'info' }])).toBe('warn');
  });

  it('is fail when any check fails', () => {
    expect(rollupStatus([{ status: 'warn' }, { status: 'fail' }, { status: 'ok' }])).toBe('fail');
  });
});

describe('who sees what', () => {
  it('refuses a recruiter', async () => {
    expect((await getHealth(recruiterToken)).status).toBe(403);
  });

  it('refuses a caller who is not signed in', async () => {
    expect((await request(app).get('/api/admin/health')).status).toBe(401);
  });

  it('shows a tenant admin only their own organisation', async () => {
    const res = await getHealth(tenantAToken);

    expect([res.status, sectionIds(res.body)]).toEqual([200, ['organisation']]);
  });

  it('shows the operator the deployment as well as their organisation', async () => {
    const res = await getHealth(operatorToken);

    expect(sectionIds(res.body)).toEqual(['platform', 'backups', 'jobs', 'delivery', 'accounts', 'organisation']);
  });

  it('treats nobody as the operator when no approver is configured', async () => {
    config.signupApproverEmail = '';

    const res = await getHealth(operatorToken);

    expect(sectionIds(res.body)).toEqual(['organisation']);
  });

  it('does not show tenant A the webhook failures of tenant B', async () => {
    const res = await getHealth(tenantAToken);

    expect(findCheck(res.body, 'organisation', 'webhook-deliveries')?.value).toBe(0);
  });

  it('shows tenant B its own webhook failures', async () => {
    const res = await getHealth(tenantBToken);

    expect(findCheck(res.body, 'organisation', 'webhook-deliveries')).toMatchObject({ status: 'warn', value: 3 });
  });

  it('shows tenant B its feedback emails that could not be sent', async () => {
    const res = await getHealth(tenantBToken);

    expect(findCheck(res.body, 'organisation', 'feedback-emails')).toMatchObject({ status: 'warn', value: 1 });
  });

  it('does not show tenant A the failed feedback emails of tenant B', async () => {
    const res = await getHealth(tenantAToken);

    expect(findCheck(res.body, 'organisation', 'feedback-emails')?.value).toBe(0);
  });

  it('does not show tenant A the stuck interviews of tenant B', async () => {
    const res = await getHealth(tenantAToken);

    expect(findCheck(res.body, 'organisation', 'interviews-stuck')?.value).toBe(0);
  });

  it('fails tenant B on its own stuck interview', async () => {
    const res = await getHealth(tenantBToken);

    expect([res.body.status, findCheck(res.body, 'organisation', 'interviews-stuck')?.value]).toEqual(['fail', 1]);
  });
});

describe('a dependency that does not answer', () => {
  it('marks that check failed and still answers the request', async () => {
    _setSystemHealthDepsForTest(fakeDeps({ statfs: () => new Promise(() => undefined), timeoutMs: 300 }));

    const res = await getHealth(operatorToken);
    const disk = findCheck(res.body, 'platform', 'disk');

    expect([res.status, disk?.status, disk?.summary.startsWith('Could not be checked')]).toEqual([200, 'fail', true]);
  });

  it('marks a check that throws as failed without its error text', async () => {
    const check = await runCheck(
      { id: 'boom', label: 'Boom', run: async () => { throw new Error('connect to 10.0.0.9 refused'); } },
      fakeDeps(), 't',
    );

    expect([check.status, JSON.stringify(check).includes('10.0.0.9')]).toEqual(['fail', false]);
  });
});

describe('what never leaves the server', () => {
  const operatorJson = async () => JSON.stringify((await getHealth(operatorToken)).body);

  it('does not include a provider key value', async () => {
    expect(await operatorJson()).not.toContain(DUMMY_SECRET);
  });

  it('does not include the session secret', async () => {
    expect(await operatorJson()).not.toContain(config.authSecret);
  });

  it('does not include the backup folder setting', async () => {
    expect(await operatorJson()).not.toContain(PRIVATE_BACKUP_DIR);
  });

  it('does not include the operator address', async () => {
    expect(await operatorJson()).not.toContain(OPERATOR_EMAIL);
  });

  it('does not include an internal address from a job error', async () => {
    expect(await operatorJson()).not.toContain('db.internal');
  });

  it('still reports the failing job', async () => {
    const res = await getHealth(operatorToken);

    expect(findCheck(res.body, 'jobs', 'job-webhook-delivery')?.status).toBe('fail');
  });
});

describe('disk space thresholds', () => {
  const at = (bavail: number) => judgeDisk({ bavail, blocks: 1000, bsize: 4096 }).status;

  it('is ok at exactly 15% free', () => { expect(at(150)).toBe('ok'); });
  it('warns just under 15% free', () => { expect(at(149)).toBe('warn'); });
  it('warns at exactly 5% free', () => { expect(at(50)).toBe('warn'); });
  it('fails just under 5% free', () => { expect(at(49)).toBe('fail'); });
});

describe('backup thresholds', () => {
  const NOW = new Date('2026-09-17T12:00:00Z');
  const run = (overrides: Partial<HealthDeps>) =>
    backupsSection.checks[0].run({ deps: fakeDeps({ now: () => NOW, ...overrides }), tenantId: 't' });
  const aged = (ageMs: number, size = 2048): Partial<HealthDeps> => ({
    statFile: async () => ({ size, mtime: new Date(NOW.getTime() - ageMs) }),
  });

  it('is ok at exactly 26 hours old', async () => { expect((await run(aged(BACKUP_WARN_AGE_MS))).status).toBe('ok'); });
  it('warns just past 26 hours old', async () => { expect((await run(aged(BACKUP_WARN_AGE_MS + 1))).status).toBe('warn'); });
  it('still warns at exactly 50 hours old', async () => { expect((await run(aged(BACKUP_FAIL_AGE_MS))).status).toBe('warn'); });
  it('fails just past 50 hours old', async () => { expect((await run(aged(BACKUP_FAIL_AGE_MS + 1))).status).toBe('fail'); });
  it('fails when the newest dump is empty', async () => { expect((await run(aged(HOUR, 0))).status).toBe('fail'); });

  it('fails when there is no dump at all', async () => {
    expect((await run({ listDir: async () => ['notes.txt', 'other.dump'] })).status).toBe('fail');
  });

  it('judges the newest of several dumps', async () => {
    const outcome = await run({
      listDir: async () => ['questor-old.dump', 'questor-new.dump'],
      statFile: async (p) => ({ size: 10, mtime: new Date(NOW.getTime() - (p.includes('new') ? HOUR : 100 * HOUR)) }),
    });

    expect(outcome.status).toBe('ok');
  });

  it('warns when the folder cannot be read', async () => {
    const outcome = await run({ listDir: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } });

    expect(outcome).toMatchObject({ status: 'warn', summary: 'The app cannot see the backup folder.' });
  });

  it('is informational outside production when no folder is configured', async () => {
    expect((await run({ env: {} })).status).toBe('info');
  });

  it('looks in the documented folder in production when none is configured', async () => {
    let looked = '';
    await run({ env: {}, nodeEnv: 'production', listDir: async (p) => { looked = p; return []; } });

    expect(looked).toBe(PRODUCTION_BACKUP_DIR);
  });
});

describe('background job thresholds', () => {
  const NOW = new Date('2026-09-17T12:00:00Z');
  const sweep = KNOWN_JOBS.find((j) => j.name === 'incomplete-sweep')!;
  const delivery = KNOWN_JOBS.find((j) => j.name === 'webhook-delivery')!;
  const deps = (overrides: Partial<HealthDeps> = {}) => fakeDeps({ now: () => NOW, ...overrides });
  const finished = (ageMs: number, ok: boolean | null = true) => {
    const at = new Date(NOW.getTime() - ageMs);
    return { startedAt: at, finishedAt: ok === null ? null : at, ok, note: '' };
  };

  it('is ok at exactly three intervals', () => {
    expect(judgeJob(sweep, finished(3 * sweep.intervalMs), deps()).status).toBe('ok');
  });

  it('warns just past three intervals', () => {
    expect(judgeJob(sweep, finished(3 * sweep.intervalMs + 1), deps()).status).toBe('warn');
  });

  it('still warns at exactly ten intervals', () => {
    expect(judgeJob(sweep, finished(10 * sweep.intervalMs), deps()).status).toBe('warn');
  });

  it('fails just past ten intervals', () => {
    expect(judgeJob(sweep, finished(10 * sweep.intervalMs + 1), deps()).status).toBe('fail');
  });

  it('gives a fast job a minute before warning', () => {
    expect(judgeJob(delivery, finished(JOB_MIN_WARN_MS), deps()).status).toBe('ok');
  });

  it('fails a job that has never run on a server that has been up a while', () => {
    expect(judgeJob(sweep, null, deps({ uptimeSeconds: () => 86_400 })).status).toBe('fail');
  });

  it('waits for the first run on a server that just started', () => {
    expect(judgeJob(sweep, null, deps({ uptimeSeconds: () => 30 })).status).toBe('info');
  });

  it('fails a job whose last run failed', () => {
    expect(judgeJob(sweep, finished(1000, false), deps()).status).toBe('fail');
  });

  it('only warns about a late job while the process drains', () => {
    expect(judgeJob(sweep, finished(20 * sweep.intervalMs), deps({ isDraining: () => true })).status).toBe('warn');
  });

  it('is ok while a recent run is still going', () => {
    expect(judgeJob(sweep, finished(1000, null), deps()).status).toBe('ok');
  });
});

describe('which background jobs are watched', () => {
  it.each(['candidate-feedback-email', 'jd-draft-generate', 'catalog-refresh-schedule', 'demo-purge'])('watches %s', (name) => {
    expect(KNOWN_JOBS.map((j) => j.name)).toContain(name);
  });
});

describe('the library worker check', () => {
  const NOW = new Date('2026-09-17T12:00:00Z');
  const status = (over: Partial<WorkerStatus> = {}): WorkerStatus => ({
    state: 'running', reason: '', holder: 'h', since: NOW, lastBatchAt: new Date(NOW.getTime() - 60_000), lastError: '', updatedAt: NOW, ...over,
  });
  const deps = fakeDeps({ now: () => NOW });

  it('fails while the worker is paused after failed batches', () => {
    expect(judgeLibraryWorker(status({ state: 'paused', reason: 'batch failed: model returned garbage' }), deps).status).toBe('fail');
  });

  it('warns when the worker is switched on but not running', () => {
    expect(judgeLibraryWorker(status({ state: 'stopped', reason: 'never started' }), deps).status).toBe('warn');
  });

  it('is ok while it fills', () => {
    expect(judgeLibraryWorker(status(), deps).status).toBe('ok');
  });

  it('only informs while it waits for credits', () => {
    expect(judgeLibraryWorker(status({ state: 'waiting_for_credits', reason: 'OpenAI 429 insufficient_quota' }), deps).status).toBe('info');
  });
});

describe('AI call failure thresholds', () => {
  it('is informational with no calls', () => { expect(judgeModelFailures(0, 0).status).toBe('info'); });
  it('is ok at exactly 5%', () => { expect(judgeModelFailures(100, 5).status).toBe('ok'); });
  it('warns just past 5%', () => { expect(judgeModelFailures(100, 6).status).toBe('warn'); });
  it('still warns at exactly 25%', () => { expect(judgeModelFailures(100, 25).status).toBe('warn'); });
  it('fails past 25%', () => { expect(judgeModelFailures(100, 26).status).toBe('fail'); });
  it('stops at warn when there are too few calls to call it a rate', () => { expect(judgeModelFailures(4, 3).status).toBe('warn'); });
});
