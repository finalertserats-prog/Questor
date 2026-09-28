import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { wipe } from '../src/seed/demoData.js';
import { prisma } from '../src/db.js';
import { signToken } from '../src/services/auth.js';

/**
 * The first run of an organisation, as Home asks the server for it.
 *
 * Home's opening card was driven by the queue alone: nothing waiting, nothing
 * booked, nothing finished meant "Start with a role". An organisation that had
 * created a role, approved its scorecard and added a candidate satisfies all
 * three of those, so it was still told to create its first role — pointed
 * backwards at work it had already done, and never at the interview it was one
 * click from starting. Two real organisations stopped somewhere in here.
 *
 * `firstRun` therefore names the step that is actually next, and is absent once
 * the organisation has an interview of its own.
 */

const app = createApp();

async function org(role = 'admin') {
  const tenant = await prisma.tenant.create({ data: { name: 'First Run Org' } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, email: `${role}@firstrun.local`, name: 'Asha', passwordHash: 'x', role },
  });
  return { tenant, user, token: signToken({ userId: user.id, tenantId: tenant.id, role, email: user.email }) };
}

const feed = (token: string) => request(app).get('/api/dashboard/needs-you').set('Authorization', `Bearer ${token}`);

beforeEach(async () => {
  await wipe();
});

describe('the first-run step an organisation is shown', () => {
  it('asks a brand-new organisation for a role', async () => {
    const { token } = await org();

    const res = await feed(token);

    expect(res.body.firstRun).toMatchObject({ step: 'role' });
  });

  it('asks for the scorecard once a role exists but is not approved', async () => {
    const { tenant, token } = await org();
    const role = await prisma.role.create({ data: { tenantId: tenant.id, title: 'Data Engineer', status: 'draft' } });

    const res = await feed(token);

    expect(res.body.firstRun).toMatchObject({ step: 'scorecard', roleId: role.id });
  });

  it('asks for a candidate once a role is approved', async () => {
    const { tenant, token } = await org();
    const role = await prisma.role.create({ data: { tenantId: tenant.id, title: 'Data Engineer', status: 'approved' } });
    await prisma.roleScorecardVersion.create({ data: { roleId: role.id, status: 'approved', profileJson: '{}' } });

    const res = await feed(token);

    expect(res.body.firstRun).toMatchObject({ step: 'candidate', roleId: role.id });
  });

  it('asks for the interview once a candidate is waiting, and names that candidate', async () => {
    const { tenant, token } = await org();
    const role = await prisma.role.create({ data: { tenantId: tenant.id, title: 'Data Engineer', status: 'approved' } });
    await prisma.roleScorecardVersion.create({ data: { roleId: role.id, status: 'approved', profileJson: '{}' } });
    const candidate = await prisma.candidate.create({
      data: { tenantId: tenant.id, roleId: role.id, fullName: 'Meera Iyer', email: 'meera@firstrun.local' },
    });

    const res = await feed(token);

    expect(res.body.firstRun).toMatchObject({ step: 'interview', candidateId: candidate.id });
  });

  it('stops asking once the organisation has an interview of its own', async () => {
    const { tenant, token } = await org();
    const role = await prisma.role.create({ data: { tenantId: tenant.id, title: 'Data Engineer', status: 'approved' } });
    const scorecard = await prisma.roleScorecardVersion.create({ data: { roleId: role.id, status: 'approved', profileJson: '{}' } });
    const candidate = await prisma.candidate.create({
      data: { tenantId: tenant.id, roleId: role.id, fullName: 'Meera Iyer', email: 'meera@firstrun.local' },
    });
    // Finished a month ago, so it is outside the week the feed looks forward
    // and the week it looks back: the queue, the diary and the recent list are
    // all empty, and the only thing that can answer null is the interview
    // check itself. A session inside those windows would have filled one of
    // them and passed this test without reaching the code it names.
    await prisma.interviewSession.create({
      data: {
        tenantId: tenant.id, candidateId: candidate.id, roleId: role.id, scorecardId: scorecard.id,
        state: 'CLOSED', completedAt: new Date(Date.now() - 30 * 24 * 3_600_000),
      },
    });

    const res = await feed(token);

    expect([res.body.needsYou.total, res.body.comingUp.length, res.body.doneRecently.length, res.body.firstRun])
      .toEqual([0, 0, 0, null]);
  });

  it('does not tell a recruiter their established employer is brand new', async () => {
    // The interview belongs to a candidate outside this recruiter's scope. The
    // organisation has been through the journey; the reader simply cannot see
    // that it has, and must not be handed a first-run card because of it.
    const { tenant, token } = await org('recruiter');
    const role = await prisma.role.create({ data: { tenantId: tenant.id, title: 'Data Engineer', status: 'approved' } });
    const scorecard = await prisma.roleScorecardVersion.create({ data: { roleId: role.id, status: 'approved', profileJson: '{}' } });
    const theirs = await prisma.candidate.create({
      data: { tenantId: tenant.id, roleId: role.id, fullName: 'Someone Else', email: 'else@firstrun.local' },
    });
    await prisma.interviewSession.create({
      data: {
        tenantId: tenant.id, candidateId: theirs.id, roleId: role.id, scorecardId: scorecard.id,
        state: 'CLOSED', completedAt: new Date(Date.now() - 30 * 24 * 3_600_000),
      },
    });

    const res = await feed(token);

    expect(res.body.firstRun).toBeNull();
  });

  it('asks for the scorecard when the role is approved but its scorecard is not', async () => {
    // Role.status and the scorecard version are two different approvals, and
    // the add-candidate form requires both. Reading only the first would send
    // an organisation to add candidates to a role nobody can interview for.
    const { tenant, token } = await org();
    const role = await prisma.role.create({ data: { tenantId: tenant.id, title: 'Data Engineer', status: 'approved' } });
    await prisma.roleScorecardVersion.create({ data: { roleId: role.id, status: 'draft', profileJson: '{}' } });

    const res = await feed(token);

    expect(res.body.firstRun).toMatchObject({ step: 'scorecard', roleId: role.id });
  });

  it('does not offer a candidate who belongs to a role that is still a draft', async () => {
    const { tenant, token } = await org();
    const ready = await prisma.role.create({ data: { tenantId: tenant.id, title: 'Data Engineer', status: 'approved' } });
    await prisma.roleScorecardVersion.create({ data: { roleId: ready.id, status: 'approved', profileJson: '{}' } });
    const draft = await prisma.role.create({ data: { tenantId: tenant.id, title: 'Analyst', status: 'draft' } });
    await prisma.candidate.create({
      data: { tenantId: tenant.id, roleId: draft.id, fullName: 'Meera Iyer', email: 'meera@firstrun.local' },
    });

    const res = await feed(token);

    expect(res.body.firstRun).toMatchObject({ step: 'candidate', roleId: ready.id, candidateId: null });
  });

  it('tells a recruiter who cannot approve a scorecard that they cannot', async () => {
    const { tenant, token } = await org('recruiter');
    const role = await prisma.role.create({ data: { tenantId: tenant.id, title: 'Data Engineer', status: 'draft' } });
    await prisma.roleAssignment.create({ data: { roleId: role.id, userId: (await prisma.user.findFirstOrThrow({ where: { tenantId: tenant.id } })).id } });

    const res = await feed(token);

    expect(res.body.firstRun).toMatchObject({ step: 'scorecard', canAct: false });
  });

  it('does not ask an organisation that has work waiting on it', async () => {
    const { tenant, token } = await org();
    const role = await prisma.role.create({ data: { tenantId: tenant.id, title: 'Data Engineer', status: 'approved' } });
    const scorecard = await prisma.roleScorecardVersion.create({ data: { roleId: role.id, status: 'approved', profileJson: '{}' } });
    const candidate = await prisma.candidate.create({
      data: { tenantId: tenant.id, roleId: role.id, fullName: 'Meera Iyer', email: 'meera@firstrun.local' },
    });
    await prisma.interviewSession.create({
      data: { tenantId: tenant.id, candidateId: candidate.id, roleId: role.id, scorecardId: scorecard.id, state: 'INCOMPLETE' },
    });

    const res = await feed(token);

    expect([res.body.needsYou.total > 0, res.body.firstRun]).toEqual([true, null]);
  });
});
