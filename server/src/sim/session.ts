/**
 * Provision a real interview session for an arbitrary generated role and
 * candidate.
 *
 * Deliberately separate from `seed/demoData.ts` rather than a generalisation of
 * it: that file is the fixture the API tests and the E2E script depend on, and
 * making it parameterised to serve the harness would put every one of those
 * tests at the mercy of a change made for a simulation.
 *
 * What it does share is demoData's refusal to run against production. This
 * writes candidates, transcripts and assessments into whatever database it is
 * pointed at, and pointing it at a live one would file synthetic people
 * alongside real ones in a recruiter's queue.
 */
import { nanoid } from 'nanoid';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { hashPassword } from '../services/auth.js';
import { assignRole, assignCandidate } from '../services/access.js';
import { extractRole } from '../engines/roleIntelligence.js';
import { normalizeProfile } from '../engines/resumeParser.js';
import { computeFitScore } from '../engines/fitScoring.js';
import { buildInterviewPlan } from '../engines/interviewPlanner.js';
import type { RoleSpec } from './roleFactory.js';
import type { CandidateSpec } from './candidateFactory.js';

const SIM_TENANT_NAME = 'Questor Simulation Harness';
const SIM_USER_EMAIL = 'sim@questor.local';

function assertNotProduction(): void {
  if (config.nodeEnv === 'production' && process.env.ALLOW_SIM_SEED !== 'true') {
    throw new Error(
      'Refusing to run the interview simulation with NODE_ENV=production. It writes synthetic candidates, ' +
      'transcripts and assessments, which would appear alongside real ones. Set ALLOW_SIM_SEED=true only if ' +
      'that is genuinely what you want.',
    );
  }
}

/**
 * Shared across concurrent cells, so the sweep initialises the tenant once.
 *
 * Without this, `ensureSimTenant` is a check-then-act race: three cells start
 * together, all three find no tenant, all three try to create the operator, and
 * two die on the unique constraint over `email`. That is exactly what happened —
 * two of six cells in a baseline run were lost to it before a single question
 * was asked.
 */
let simTenantInit: Promise<{ tenantId: string; userId: string }> | null = null;

/** One tenant and one operator for the whole sweep, created on first use. */
export function ensureSimTenant(): Promise<{ tenantId: string; userId: string }> {
  if (!simTenantInit) {
    // Cleared on failure so a transient error does not poison every later cell
    // with the same rejected promise.
    simTenantInit = createSimTenant().catch((e) => {
      simTenantInit = null;
      throw e;
    });
  }
  return simTenantInit;
}

/** Test hook: forget the cached tenant so a fresh database can be initialised. */
export function _resetSimTenant(): void {
  simTenantInit = null;
}

async function createSimTenant(): Promise<{ tenantId: string; userId: string }> {
  assertNotProduction();
  const existing = await prisma.tenant.findFirst({ where: { name: SIM_TENANT_NAME } });
  if (existing) {
    const user = await prisma.user.findFirst({ where: { tenantId: existing.id, email: SIM_USER_EMAIL } });
    if (user) return { tenantId: existing.id, userId: user.id };
  }

  const tenant = existing ?? await prisma.tenant.create({
    data: {
      name: SIM_TENANT_NAME,
      region: 'in',
      policyJson: JSON.stringify({
        disclosureText:
          "Hello, I'm Schranders, an AI interviewer for this first-round conversation. While you speak, your voice " +
          'is transcribed; no audio recording is kept, and the written transcript is what our hiring team reviews. ' +
          "I'll ask about your relevant experience — take your time, and ask me to repeat anything.",
        recordingDefault: true,
        retentionDaysRecording: 7,
        retentionDaysTranscript: 30,
        allowedModules: [],
        languages: ['en'],
        humanReviewRequired: true,
      }),
    },
  });
  const user = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: SIM_USER_EMAIL,
      name: 'Simulation Operator',
      // Random every run: this account is never meant to be logged into, and a
      // known password on a seeded account is how demo credentials end up
      // working somewhere they should not.
      passwordHash: hashPassword(nanoid(32)),
      role: 'admin',
    },
  });
  return { tenantId: tenant.id, userId: user.id };
}

export interface SimSessionIds {
  tenantId: string;
  userId: string;
  roleId: string;
  scorecardId: string;
  candidateId: string;
  sessionId: string;
}

/** Build role, scorecard, candidate, fit, plan and session — the real objects. */
export async function createSimSession(opts: {
  role: RoleSpec;
  candidate: CandidateSpec;
  durationMinutes?: number;
}): Promise<SimSessionIds> {
  assertNotProduction();
  const { tenantId, userId } = await ensureSimTenant();
  const durationMinutes = opts.durationMinutes ?? 20;

  // The real extraction path, LLM-augmented where a provider is configured and
  // heuristic otherwise — the harness should exercise what production runs.
  const extraction = await extractRole(opts.role.jdText, opts.role.title);

  const role = await prisma.role.create({
    data: {
      tenantId, title: extraction.title, level: extraction.level, location: extraction.location,
      employmentType: extraction.employmentType, sourceType: 'paste', sourceText: opts.role.jdText,
      status: 'approved', createdById: userId,
    },
  });
  const scorecard = await prisma.roleScorecardVersion.create({
    data: {
      roleId: role.id, version: 1, status: 'approved',
      profileJson: JSON.stringify(extraction.profile), approvedById: userId, approvedAt: new Date(),
    },
  });
  await assignRole(role.id, userId, 'owner');

  const candidate = await prisma.candidate.create({
    data: { tenantId, roleId: role.id, fullName: opts.candidate.fullName, email: opts.candidate.email, phone: '' },
  });
  await assignCandidate(candidate.id, userId, 'owner');

  const profile = normalizeProfile(opts.candidate.resumeText);
  const { fit } = computeFitScore(profile, opts.candidate.resumeText, extraction.profile);
  await prisma.candidateProfileVersion.create({
    data: {
      candidateId: candidate.id, version: 1, rawText: opts.candidate.resumeText,
      profileJson: JSON.stringify(profile), fitScoreJson: JSON.stringify(fit),
    },
  });

  const plan = buildInterviewPlan({ role: extraction.profile, fit, durationMinutes, language: 'en', modules: [] });
  const session = await prisma.interviewSession.create({
    data: {
      tenantId, candidateId: candidate.id, roleId: role.id, scorecardId: scorecard.id,
      state: 'ACCEPTED', provider: 'hosted', language: 'en', durationMinutes,
      personaJson: JSON.stringify({ name: 'Schranders', tone: 'warm' }),
      consentJson: JSON.stringify({
        disclosureText: '',
        recordingRequested: true, recording: true, humanReviewRequired: true,
        consentVersion: 'v1', consentedAt: new Date().toISOString(), channel: 'simulation',
      }),
      recordingConsent: true,
    },
  });
  await prisma.interviewPlanVersion.create({
    data: { sessionId: session.id, version: 1, planJson: JSON.stringify(plan) },
  });

  return {
    tenantId, userId, roleId: role.id, scorecardId: scorecard.id,
    candidateId: candidate.id, sessionId: session.id,
  };
}
