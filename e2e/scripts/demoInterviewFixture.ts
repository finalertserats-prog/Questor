import { prisma } from '../../server/src/db.js';
import { hashDemoToken, hashRequestIp, mintDemoToken, provisionDemoTenant } from '../../server/src/services/demoAccess.js';
import { startCandidateMode } from '../../server/src/services/demoInterviewStart.js';
import { DEMO_CAP_MS, DEMO_CLOSING_RESERVE_MS } from '../../server/src/domain/demoInterview.js';

/**
 * Fixtures the demo-interview suite cannot build through the browser.
 *
 * Three things, each of which the UI genuinely cannot do:
 *
 *   `link`        — the one-time demo link. The real flow emails it, and the
 *                   console email provider logs it inside the dev server where
 *                   a test cannot read it. Everything after this is the real
 *                   path: redeem, session, sandbox.
 *
 *   `candidate`   — starts a candidate-side sitting directly. The dev server
 *                   runs the built-in writer and browser speech, so readiness
 *                   deliberately withdraws that mode: there is no key to hand
 *                   it and no browser gesture that would change its mind. The
 *                   readiness check is POLICY, and the suite covers it in its
 *                   own test; this is here so the interview BEHIND the policy
 *                   is exercised end to end as well.
 *
 *   `rush`        — moves a sitting's clock back so the suite reaches the
 *                   fifteen-minute box and the end of an eleven-minute script
 *                   without waiting for either. It moves `startedAt` and
 *                   `capAt` together, so every rule still reads a consistent
 *                   clock and nothing is bypassed.
 *
 * Refuses to run against a production database, for the same reason the
 * simulation harness does.
 */

function assertNotProduction(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('demoInterviewFixture writes test data; it will not run with NODE_ENV=production');
  }
}

async function makeLink(): Promise<string> {
  const email = `demoint-${Date.now()}@questor.local`;
  const token = mintDemoToken();
  const provisioned = await provisionDemoTenant({ name: 'Demo Visitor', email, company: 'Demo Co' });
  await prisma.demoGrant.create({
    data: {
      name: 'Demo Visitor', email, company: 'Demo Co', status: 'sent',
      linkTokenHash: hashDemoToken(token), linkExpiresAt: new Date(Date.now() + 60 * 60_000),
      tenantId: provisioned.tenantId, userId: provisioned.userId, requestIpHash: hashRequestIp('127.0.0.1'),
    },
  });
  return token;
}

/** The newest sandbox, which is the one the suite has just opened. */
async function newestDemoTenant(): Promise<string> {
  const tenant = await prisma.tenant.findFirst({ where: { isDemo: true }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  if (!tenant) throw new Error('no demo sandbox to work with');
  return tenant.id;
}

async function startCandidate(): Promise<string> {
  const tenantId = await newestDemoTenant();
  const grant = await prisma.demoGrant.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  if (!grant) throw new Error('no demo grant to work with');
  const started = await startCandidateMode({ tenantId, demoGrantId: grant.id });
  if (!started.portalUrl) throw new Error('candidate mode produced no portal link');
  return started.portalUrl;
}

/**
 * Wind a sitting's clock back by `ms`.
 *
 * `to: 'close'` lands just past the point the interviewer must stop asking;
 * `to: 'played'` lands past the end of the written script.
 */
async function rush(to: 'close' | 'played'): Promise<string> {
  const run = await prisma.demoInterviewRun.findFirst({ where: { endedAt: null }, orderBy: { startedAt: 'desc' } });
  if (!run) throw new Error('no open demo interview to rush');
  const back = to === 'close' ? DEMO_CAP_MS - DEMO_CLOSING_RESERVE_MS + 5_000 : 12 * 60_000;
  await prisma.demoInterviewRun.update({
    where: { id: run.id },
    data: {
      startedAt: new Date(run.startedAt.getTime() - back),
      capAt: new Date(run.capAt.getTime() - back),
    },
  });
  return run.id;
}

/**
 * The answer, on its own line behind a marker.
 *
 * The services this reaches log through pino, which also writes to stdout, so
 * "the last line" is whoever spoke last rather than the answer. The caller
 * looks for the marker instead.
 */
const ANSWER = 'QUESTOR_FIXTURE_ANSWER:';

async function main(): Promise<void> {
  assertNotProduction();
  const command = process.argv[2] ?? 'link';
  const answer = command === 'link' ? await makeLink()
    : command === 'candidate' ? await startCandidate()
      : command === 'rush-close' ? await rush('close')
        : command === 'rush-played' ? await rush('played')
          : null;
  if (answer === null) throw new Error(`unknown command: ${command}`);
  process.stdout.write(`
${ANSWER}${answer}
`);
}

main().finally(async () => { await prisma.$disconnect(); });
