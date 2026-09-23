/**
 * What happens to candidates when several are interviewing at once.
 *
 * Not a benchmark of the machine — a check on the thing that actually harmed
 * someone before: an answer submitted and lost. Every turn is checked for a
 * recorded reply, and any that vanished are reported separately from slow ones,
 * because a slow interview is an annoyance and a lost answer is a person's
 * interview.
 *
 * Drives the real portal endpoints over HTTP, exactly as a candidate's browser
 * does, against a server the caller has already started. Point that server at a
 * throwaway database: this creates tenants and never deletes them.
 *
 *   LOAD_BASE=http://127.0.0.1:4300 npx tsx sim/loadPortal.ts --concurrency 20 --turns 3
 */
import { nanoid } from 'nanoid';
import { prisma } from '../src/db.js';
import { invitationSecretColumns, mintInvitationToken } from '../src/services/invitations.js';
import { hashPassword } from '../src/services/auth.js';
import { extractRoleHeuristic } from '../src/engines/roleIntelligence.js';
import { normalizeProfile } from '../src/engines/resumeParser.js';
import { computeFitScore } from '../src/engines/fitScoring.js';
import { buildInterviewPlan } from '../src/engines/interviewPlanner.js';
import { DEMO_JD, DEMO_RESUME } from '../src/seed/demoData.js';
import { consentIntro } from '../src/domain/interviewerModel.js';

const BASE = process.env.LOAD_BASE ?? 'http://127.0.0.1:4300';
/** The interviewer this harness's sessions are assigned, named once. */
const INTERVIEWER_NAME = 'Maya';
// Built from consentIntro(), never retyped. POST /consent refuses any session
// whose stored disclosure does not open with the current wording
// (routes/portal.ts, domain/interviewerModel.ts), so the hand-written copy
// this used to carry made every consent answer 409 disclosure_missing and
// every turn after it 409 — the harness reported latency for a run in which
// no interview ever started (docs/qa/resilience-2026-09-23.md §5). Derived,
// a future change to the wording breaks this loudly instead.
const DISCLOSURE =
  `${consentIntro(INTERVIEWER_NAME)} While you speak, your voice is captured and written down. ` +
  'No recording of your voice is stored — the written transcript is what is kept.';
const ANSWER =
  'We had a nightly pipeline that silently dropped late-arriving events. I noticed it through a freshness check, ' +
  'made the load idempotent on merge keys so a backfill was safe, re-ran the affected partitions, and told the ' +
  'analytics team what had been wrong and for how long. Afterwards I added a data-contract test so it would fail ' +
  'loudly rather than quietly.';

interface Sample {
  readonly step: string;
  readonly ms: number;
  readonly ok: boolean;
  readonly status: number;
}

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  const value = index > 0 ? Number(process.argv[index + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * One tenant, many candidates — which is what a busy hiring day actually looks
 * like, and what puts several interviews on the same rows at the same time.
 */
async function seed(count: number): Promise<string[]> {
  const stamp = `${Date.now().toString(36)}${nanoid(4).toLowerCase()}`;
  const extraction = extractRoleHeuristic(DEMO_JD, 'Senior Data Engineer');

  const tenant = await prisma.tenant.create({
    data: {
      name: `Load test ${stamp}`,
      region: 'in',
      policyJson: JSON.stringify({ disclosureText: DISCLOSURE, recordingDefault: false, humanReviewRequired: true, languages: ['en'] }),
    },
  });
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `load-${stamp}@questor.local`,
      name: 'Load test',
      // Never a usable password: this account exists to own the fixtures.
      passwordHash: hashPassword(nanoid(32)),
      role: 'admin',
    },
  });
  const role = await prisma.role.create({
    data: {
      tenantId: tenant.id, title: extraction.title, level: extraction.level, location: extraction.location,
      employmentType: extraction.employmentType, sourceType: 'paste', sourceText: DEMO_JD, status: 'approved', createdById: user.id,
    },
  });
  const scorecard = await prisma.roleScorecardVersion.create({
    data: { roleId: role.id, version: 1, status: 'approved', profileJson: JSON.stringify(extraction.profile), approvedById: user.id, approvedAt: new Date() },
  });

  // The same résumé and plan for everyone: the variable under test is
  // concurrency, not how different candidates read.
  const profile = normalizeProfile(DEMO_RESUME);
  const { fit } = computeFitScore(profile, DEMO_RESUME, extraction.profile);
  const plan = buildInterviewPlan({ role: extraction.profile, fit, durationMinutes: 45, language: 'en', modules: [] });

  const tokens: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const candidate = await prisma.candidate.create({
      data: { tenantId: tenant.id, roleId: role.id, fullName: `Load Candidate ${i + 1}`, email: `load-${stamp}-${i}@example.test`, phone: '' },
    });
    await prisma.candidateProfileVersion.create({
      data: { candidateId: candidate.id, version: 1, rawText: DEMO_RESUME, profileJson: JSON.stringify(profile), fitScoreJson: JSON.stringify(fit) },
    });
    const session = await prisma.interviewSession.create({
      data: {
        tenantId: tenant.id, candidateId: candidate.id, roleId: role.id, scorecardId: scorecard.id,
        state: 'ACCEPTED', provider: 'hosted', language: 'en', durationMinutes: 45,
        personaJson: JSON.stringify({ interviewerId: 'maya', name: INTERVIEWER_NAME, tone: 'warm' }),
        consentJson: JSON.stringify({ disclosureText: DISCLOSURE, recordingRequested: false, humanReviewRequired: true }),
        recordingConsent: false,
      },
    });
    await prisma.interviewPlanVersion.create({ data: { sessionId: session.id, version: 1, planJson: JSON.stringify(plan) } });
    const token = mintInvitationToken();
    await prisma.invitation.create({
      data: { sessionId: session.id, ...invitationSecretColumns(token), status: 'accepted', sentAt: new Date(), acceptedAt: new Date(), expiresAt: new Date(Date.now() + 14 * 864e5) },
    });
    tokens.push(token);
  }
  return tokens;
}

async function call(step: string, path: string, body: unknown, samples: Sample[]): Promise<Response | null> {
  const started = performance.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    samples.push({ step, ms: performance.now() - started, ok: res.ok, status: res.status });
    return res;
  } catch {
    // A refused or dropped connection is the worst outcome and must not be
    // silently missing from the percentiles.
    samples.push({ step, ms: performance.now() - started, ok: false, status: 0 });
    return null;
  }
}

/** One candidate's interview: consent, start, then answer T times. */
async function runCandidate(token: string, turns: number, samples: Sample[]): Promise<{ submitted: number; recorded: number }> {
  await call('consent', `/api/portal/${token}/consent`, { recordingConsent: false, accepted: true }, samples);
  await call('start', `/api/portal/${token}/start`, {}, samples);

  let submitted = 0;
  let recorded = 0;
  for (let i = 0; i < turns; i += 1) {
    submitted += 1;
    const res = await call('turn', `/api/portal/${token}/turn`, { text: ANSWER, startMs: i * 45_000, endMs: i * 45_000 + 30_000 }, samples);
    if (!res || !res.ok) continue;
    const payload = (await res.json().catch(() => null)) as { turn?: unknown; agent?: unknown } | null;
    // The server answering 200 is not the same as the answer being kept.
    if (payload && (payload.turn || payload.agent)) recorded += 1;
  }
  return { submitted, recorded };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function report(step: string, samples: Sample[]): void {
  const forStep = samples.filter((s) => s.step === step);
  if (forStep.length === 0) return;
  const times = forStep.map((s) => s.ms);
  const failed = forStep.filter((s) => !s.ok);
  console.log(
    `  ${step.padEnd(8)} n=${String(forStep.length).padStart(4)}  ` +
    `p50 ${percentile(times, 0.5).toFixed(0).padStart(5)}ms  ` +
    `p95 ${percentile(times, 0.95).toFixed(0).padStart(5)}ms  ` +
    `max ${Math.max(...times).toFixed(0).padStart(6)}ms  ` +
    `failed ${failed.length}${failed.length ? ` (statuses ${[...new Set(failed.map((f) => f.status))].join(', ')})` : ''}`,
  );
}

async function main(): Promise<void> {
  const concurrency = arg('concurrency', 20);
  const turns = arg('turns', 3);

  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!health?.ok) throw new Error(`No server answering at ${BASE}. Start one against a throwaway database first.`);

  const version = (await prisma.$queryRawUnsafe<{ v: string }[]>('SELECT version() AS v').catch(() => null))?.[0]?.v;
  console.log(`\n=== ${concurrency} concurrent interviews, ${turns} answers each — ${BASE}`);
  console.log(`    database: ${version ? version.split(',')[0] : 'version unavailable (not PostgreSQL?)'}\n`);

  process.stdout.write(`Seeding ${concurrency} candidates… `);
  const seedStarted = performance.now();
  const tokens = await seed(concurrency);
  console.log(`${((performance.now() - seedStarted) / 1000).toFixed(1)}s`);

  const samples: Sample[] = [];
  const started = performance.now();
  const results = await Promise.all(tokens.map((token) => runCandidate(token, turns, samples)));
  const elapsed = (performance.now() - started) / 1000;

  const submitted = results.reduce((sum, r) => sum + r.submitted, 0);
  const recorded = results.reduce((sum, r) => sum + r.recorded, 0);

  console.log(`\nLatency by step (${samples.length} requests in ${elapsed.toFixed(1)}s):`);
  for (const step of ['consent', 'start', 'turn']) report(step, samples);

  const lost = submitted - recorded;
  console.log(`\nAnswers submitted: ${submitted}`);
  console.log(`Answers recorded:  ${recorded}`);
  console.log(lost === 0 ? '\nNo answer was lost.' : `\n${lost} ANSWER(S) LOST — a candidate said something and Questor did not keep it.`);

  await prisma.$disconnect();
  process.exit(lost === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(2);
});
