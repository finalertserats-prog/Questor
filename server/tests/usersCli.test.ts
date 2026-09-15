import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { spawnSync } from 'node:child_process';
import { createApp } from '../src/app.js';
import { wipe } from '../src/seed/demoData.js';
import { prisma } from '../src/db.js';

// The account CLI is the bootstrap path onto a running install: it is what an
// operator reaches for when nobody can sign in, which is exactly the moment
// there is no other way to fix it. So the thing worth asserting is not that it
// writes a row — it is that the password it PRINTS actually authenticates
// against the real login route. A generated credential that the API then
// rejects would be indistinguishable, from the operator's side, from being
// locked out.

const app = createApp();
const CLI = 'src/scripts/users.ts';

interface CliResult { status: number; stdout: string; stderr: string; }

function cli(...args: string[]): CliResult {
  const res = spawnSync('npx', ['tsx', CLI, ...args], {
    encoding: 'utf8',
    cwd: process.cwd(),
    // The child must land on this worker's database, not the default one.
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** The printed credential block is the tool's actual contract with the operator. */
function passwordFrom(stdout: string): string {
  const m = stdout.match(/Password\s+(\S+)/);
  if (!m) throw new Error(`No password in CLI output:\n${stdout}`);
  return m[1];
}

beforeAll(async () => {
  await wipe();
  await prisma.tenant.create({ data: { name: 'CLI Org' } });
}, 60_000);

describe('account administration CLI', () => {
  let adminPassword = '';

  it('creates an admin whose printed password logs in', async () => {
    const res = cli('create', '--email', 'boss@cli.local', '--name', 'Boss', '--role', 'admin');
    expect(res.status).toBe(0);

    adminPassword = passwordFrom(res.stdout);
    // 4 groups of 5 from the unambiguous alphabet, so comfortably over the
    // 12-character floor the API enforces.
    expect(adminPassword).toMatch(/^[a-z346789]{5}(-[a-z346789]{5}){3}$/);

    const login = await request(app).post('/api/auth/login').send({ email: 'boss@cli.local', password: adminPassword });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('admin');
  }, 60_000);

  it('issues a credential that only works for the right password', async () => {
    const bad = await request(app).post('/api/auth/login').send({ email: 'boss@cli.local', password: 'not-the-password' });
    expect(bad.status).toBe(401);
  });

  it('creates an admin who can actually reach admin-only endpoints', async () => {
    const login = await request(app).post('/api/auth/login').send({ email: 'boss@cli.local', password: adminPassword });
    // admin:manage is the capability that makes an account useful for setting
    // up everyone else; a row with role='admin' that cannot call this would be
    // a working login and a useless one.
    const users = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${login.body.token}`);
    expect(users.status).toBe(200);
    expect(users.body.users.map((u: { email: string }) => u.email)).toContain('boss@cli.local');
  }, 60_000);

  it('places the new user in the existing organisation, not a new one', async () => {
    // The failure this guards against is the one that looks like data loss: an
    // account in a fresh tenant signs in fine and shows an empty console.
    const tenants = await prisma.tenant.findMany();
    expect(tenants).toHaveLength(1);
    const user = await prisma.user.findUnique({ where: { email: 'boss@cli.local' } });
    expect(user?.tenantId).toBe(tenants[0].id);
  });

  it('records the creation in the audit log', async () => {
    const events = await prisma.auditEvent.findMany({ where: { action: 'user.created' } });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].actorType).toBe('system');
  });

  it('replaces a password on reset, and the old one stops working', async () => {
    const res = cli('reset-password', '--email', 'boss@cli.local');
    expect(res.status).toBe(0);
    const next = passwordFrom(res.stdout);
    expect(next).not.toBe(adminPassword);

    const withNew = await request(app).post('/api/auth/login').send({ email: 'boss@cli.local', password: next });
    expect(withNew.status).toBe(200);

    const withOld = await request(app).post('/api/auth/login').send({ email: 'boss@cli.local', password: adminPassword });
    expect(withOld.status).toBe(401);

    adminPassword = next;
  }, 60_000);

  it('refuses a duplicate email rather than overwriting the account', () => {
    const res = cli('create', '--email', 'boss@cli.local', '--name', 'Impostor');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('already has an account');
  }, 60_000);

  it('refuses an unrecognised role', () => {
    // A typo'd role resolves to zero capabilities, producing an account that
    // signs in and can do nothing — so this must fail loudly at creation.
    const res = cli('create', '--email', 'typo@cli.local', '--name', 'Typo', '--role', 'recruter');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--role must be one of');
  }, 60_000);

  it('refuses a password under the API floor', () => {
    const res = cli('create', '--email', 'weak@cli.local', '--name', 'Weak', '--password', 'short');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('at least 12 characters');
  }, 60_000);

  it('refuses to demote the last administrator', () => {
    const res = cli('set-role', '--email', 'boss@cli.local', '--role', 'manager');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('only administrator');
  }, 60_000);

  it('creates the other HR roles and changes a role once a second admin exists', async () => {
    const recruiter = cli('create', '--email', 'rec@cli.local', '--name', 'Rec', '--role', 'recruiter');
    expect(recruiter.status).toBe(0);
    const recruiterPassword = passwordFrom(recruiter.stdout);

    const login = await request(app).post('/api/auth/login').send({ email: 'rec@cli.local', password: recruiterPassword });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('recruiter');

    // A recruiter must not hold admin:manage — that separation is the point of
    // handing HR anything other than an admin account.
    const denied = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${login.body.token}`);
    expect(denied.status).toBe(403);

    expect(cli('set-role', '--email', 'rec@cli.local', '--role', 'manager').status).toBe(0);
    const updated = await prisma.user.findUnique({ where: { email: 'rec@cli.local' } });
    expect(updated?.role).toBe('manager');
  }, 90_000);

  it('lists accounts without ever printing a hash', () => {
    const res = cli('list');
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('boss@cli.local');
    expect(res.stdout).toContain('rec@cli.local');
    expect(res.stdout).not.toContain('$2a$');
    expect(res.stdout).not.toContain('$2b$');
  }, 60_000);
});
