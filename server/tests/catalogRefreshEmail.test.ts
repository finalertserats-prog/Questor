import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailMessage } from '../src/providers/email/index.js';

const sent: EmailMessage[] = [];
const mail = { fail: false };
vi.mock('../src/providers/email/index.js', async (orig) => {
  const actual = await orig<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({
      name: 'test', configured: true, delivers: true,
      send: vi.fn(async (msg: EmailMessage) => {
        if (mail.fail) throw new Error('mail relay down');
        sent.push(msg);
        return { status: 'sent', id: `t${sent.length}` };
      }),
    }),
  };
});

import { config } from '../src/config.js';
import { prisma } from '../src/db.js';
import { logger } from '../src/logger.js';
import { runCatalogRefresh } from '../src/services/catalogRefresh.js';
import { configureCatalogRefresh, seedSmallCatalog, testDeps } from './catalogRefreshFixtures.js';

/**
 * The owner hears about a run only when it left something to review, at the
 * operator addresses, with counts and a link to the queue.
 */

beforeEach(async () => {
  sent.length = 0;
  mail.fail = false;
  vi.restoreAllMocks();
  configureCatalogRefresh();
  config.platformOperatorEmails = ['owner@questor.test', 'second@questor.test'];
  config.signupApproverEmail = 'approver@questor.test';
  config.webOrigin = 'https://app.questor.test';
  await seedSmallCatalog();
});

async function runWithProposals() {
  await runCatalogRefresh({ trigger: 'schedule', deps: testDeps({}).deps });
}

describe('the operator summary email', () => {
  it('goes to every platform operator', async () => {
    await runWithProposals();
    expect(sent.map((m) => m.to).sort()).toEqual(['owner@questor.test', 'second@questor.test']);
  });

  it('goes to the signup approver only when no operator is configured', async () => {
    config.platformOperatorEmails = [];
    await runWithProposals();
    expect(sent.map((m) => m.to)).toEqual(['approver@questor.test']);
  });

  it('counts proposals per kind', async () => {
    await runWithProposals();
    expect(sent[0].text).toMatch(/New roles: 1[\s\S]*New alternative titles: 3|New alternative titles: 3[\s\S]*New roles: 1/);
  });

  it('counts proposals per source', async () => {
    await runWithProposals();
    expect(sent[0].text).toContain('From O*NET: 4');
  });

  it('links to the review page', async () => {
    await runWithProposals();
    expect(sent[0].text).toContain('https://app.questor.test/catalog-review');
  });

  it('is branded', async () => {
    await runWithProposals();
    expect(sent[0].html).toContain('questor-wordmark');
  });

  it('says the total in the subject', async () => {
    await runWithProposals();
    expect(sent[0].subject).toBe('Questor catalog refresh: 4 proposals to review');
  });

  it('is not sent when the run queued nothing new', async () => {
    await runWithProposals();
    sent.length = 0;
    await runCatalogRefresh({ trigger: 'manual', deps: testDeps({}).deps });
    expect(sent).toEqual([]);
  });

  it('logs a warning, and the run still completes, when there is no address', async () => {
    config.platformOperatorEmails = [];
    config.signupApproverEmail = '';
    const warn = vi.spyOn(logger, 'warn');
    const result = await runCatalogRefresh({ trigger: 'schedule', deps: testDeps({}).deps });
    expect({ outcome: result.outcome, sent: sent.length, warned: warn.mock.calls.some((call) => String(call[1]).includes('PLATFORM_OPERATOR_EMAILS')) }).toEqual({ outcome: 'ran', sent: 0, warned: true });
  });
});

describe('when the operator summary cannot be sent', () => {
  it('keeps the run completed', async () => {
    mail.fail = true;
    const result = await runCatalogRefresh({ trigger: 'schedule', deps: testDeps({}).deps });
    const run = await prisma.catalogRefreshRun.findUniqueOrThrow({ where: { id: result.runId } });
    expect(run.status).toBe('completed');
  });

  it('records on the run that nobody was told, for the review page', async () => {
    mail.fail = true;
    const result = await runCatalogRefresh({ trigger: 'schedule', deps: testDeps({}).deps });
    const run = await prisma.catalogRefreshRun.findUniqueOrThrow({ where: { id: result.runId } });
    expect(run.error).toBe('notice_not_sent');
  });

  it('keeps the run completed when building the summary itself fails', async () => {
    const original = prisma.catalogProposal.findMany.bind(prisma.catalogProposal);
    // Only the summary reads exactly kind + sourcesJson; every other read passes through.
    vi.spyOn(prisma.catalogProposal, 'findMany').mockImplementation(((args: Parameters<typeof original>[0]) => {
      const select = args?.select ?? {};
      const isSummary = Object.keys(select).sort().join(',') === 'kind,sourcesJson';
      return isSummary ? Promise.reject(new Error('database went away')) : original(args);
    }) as unknown as typeof prisma.catalogProposal.findMany);

    const result = await runCatalogRefresh({ trigger: 'schedule', deps: testDeps({}).deps });

    const run = await prisma.catalogRefreshRun.findUniqueOrThrow({ where: { id: result.runId } });
    expect({ status: run.status, outcome: result.outcome, error: run.error }).toEqual({ status: 'completed', outcome: 'ran', error: 'notice_not_sent' });
  });
});
