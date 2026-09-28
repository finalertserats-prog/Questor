import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { logger } from '../src/logger.js';
import { _resetEmail, getEmail } from '../src/providers/email/index.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';

/**
 * Logs are not erasable and not access-controlled like the database. A
 * candidate's address stays in them after an erasure, and an email body holds
 * the portal link, the only credential the candidate portal asks for. Outside
 * a developer's own machine neither is written to the log.
 */

const app = createApp();
const ADDRESS = 'private.person@candidate.test';
const LINK = 'https://questor.example/portal/bearer-link-value';
const SUBJECT_NAME = 'Priya Someone';

let logged: string;

function captureLogs() {
  const calls: unknown[][] = [];
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { calls.push(args); }) as never);
  }
  return () => JSON.stringify(calls);
}

beforeEach(() => {
  Object.assign(config.email, { provider: 'console' });
  _resetEmail();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetEmail();
});

describe('the console email provider outside development', () => {
  beforeEach(async () => {
    const read = captureLogs();
    await getEmail().send({ to: ADDRESS, subject: `Questor demo reaccess — ${SUBJECT_NAME}`, text: `Open ${LINK}`, html: `<a href="${LINK}">Open</a>` });
    logged = read();
  });

  it('does not log the recipient address', () => {
    expect(logged).not.toContain(ADDRESS);
  });

  it('does not log the body, which carries the portal link', () => {
    expect(logged).not.toContain(LINK);
  });

  it('does not log the subject, which can name the person', () => {
    expect(logged).not.toContain(SUBJECT_NAME);
  });

  it('still logs that a message was not delivered', () => {
    expect(logged).toContain('NOT DELIVERED');
  });
});

describe('an invitation created without a delivering provider', () => {
  it('does not log the candidate address', async () => {
    await wipe();
    const ids = await createDemoData();
    await prisma.candidate.update({ where: { id: ids.candidateId }, data: { email: ADDRESS } });
    await prisma.interviewSession.update({ where: { id: ids.sessionId }, data: { state: 'PROVISIONED' } });
    const auth = `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}`;
    const read = captureLogs();

    await request(app).post(`/api/interviews/${ids.sessionId}/invite`).set('Authorization', auth);

    expect(read()).not.toContain(ADDRESS);
  });
});
