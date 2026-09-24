import { prisma, parseJsonStrict } from '../db.js';
import { HttpError } from '../middleware/index.js';
import { logger } from '../logger.js';
import { buildInterviewPlan } from '../engines/interviewPlanner.js';
import { withObserverNotice } from './observerPolicy.js';
import { invitationLink } from './invitations.js';
import { DEMO_CAP_MS, type DemoMode } from '../domain/demoInterview.js';
import { DEMO_SCRIPT_CANDIDATE, DEMO_SCRIPT_ID } from '../domain/demoObserverScript.js';
import { startRun, liveRunForGrant, reserveSitting, type DemoRunRow } from './demoInterviewRun.js';
import { consume } from '../middleware/rateLimit.js';
import { Prisma } from '@prisma/client';
import type { RoleSuccessProfile } from '../domain/types.js';

/**
 * Opening a demo interview, in whichever mode the visitor chose.
 *
 * Both modes run against the sandbox's own role, so a visitor who has been
 * reading the Senior Data Engineer role in the console then watches or sits an
 * interview for that same role. Neither mode invents an organisation, a
 * candidate with a real address, or a role that is not already in front of them.
 */

/** The interview is planned for the box it has to fit in, not the role's 45. */
export const DEMO_PLAN_MINUTES = Math.round(DEMO_CAP_MS / 60_000);

interface Sandbox {
  readonly tenantId: string;
  readonly roleId: string;
  readonly scorecardId: string;
  readonly profile: RoleSuccessProfile;
  readonly personaJson: string;
  readonly disclosureText: string;
}

/**
 * The sandbox's role, scorecard and interviewer, read once.
 *
 * Throws 409 rather than 500 when the sandbox is not there: the demo tenant
 * being mid-purge is a designed state, not a fault, and the caller turns this
 * into the page that says so.
 */
async function loadSandbox(tenantId: string): Promise<Sandbox> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { isDemo: true, demoExpiresAt: true } });
  if (!tenant?.isDemo) throw new HttpError(409, 'This demo sandbox is no longer available.', 'sandbox_gone');
  if (tenant.demoExpiresAt && tenant.demoExpiresAt.getTime() <= Date.now()) {
    throw new HttpError(409, 'This demo sandbox is no longer available.', 'sandbox_gone');
  }
  const session = await prisma.interviewSession.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
    select: {
      roleId: true, scorecardId: true, personaJson: true, consentJson: true,
      scorecard: { select: { profileJson: true } },
    },
  });
  if (!session) throw new HttpError(409, 'This demo sandbox is no longer available.', 'sandbox_gone');
  const profile = parseJsonStrict<RoleSuccessProfile>(session.scorecard.profileJson, {
    model: 'RoleScorecardVersion', id: session.scorecardId, field: 'profileJson',
  });
  const consent = parseJsonStrict<{ disclosureText?: string }>(session.consentJson, {
    model: 'InterviewSession', id: session.scorecardId, field: 'consentJson',
  });
  return {
    tenantId,
    roleId: session.roleId,
    scorecardId: session.scorecardId,
    profile,
    personaJson: session.personaJson,
    disclosureText: consent.disclosureText ?? '',
  };
}

/**
 * Hold the visitor's one starting slot while a start is in flight.
 *
 * Checking for an open sitting and then creating one is read-then-write: two
 * tabs, or a double press, both see nothing open and both create. The shared
 * atomic counter is the same mechanism the demo creation caps already use for
 * exactly this, which is why it is reached for rather than a second one.
 */
async function holdStartSlot(demoGrantId: string, mode: DemoMode): Promise<boolean> {
  const verdict = await consume('demo-interview-start', `${demoGrantId}:${mode}`, 30_000, 1, { failClosed: true });
  return verdict.allowed;
}

export interface StartedDemoInterview {
  readonly run: DemoRunRow;
  /** Candidate mode only: where the visitor goes to sit the interview. */
  readonly portalUrl: string | null;
}

/**
 * "Be the candidate" — the real interview, against the sandbox's role.
 *
 * Re-uses the invitation the sandbox was built with rather than minting a
 * second one, so the link the console already shows is the link that works.
 * The plan is rebuilt for fifteen minutes: the sandbox's session was planned
 * for forty-five, and a plan that expects forty-five minutes of blocks paces
 * the interviewer as if it had them.
 */
export async function startCandidateMode(opts: {
  tenantId: string;
  demoGrantId: string;
  extendTime?: boolean;
}): Promise<StartedDemoInterview> {
  const sandbox = await loadSandbox(opts.tenantId);
  const session = await prisma.interviewSession.findFirst({
    where: { tenantId: opts.tenantId, invitation: { isNot: null } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, state: true, invitation: { select: { tokenSealed: true, token: true, expiresAt: true } } },
  });
  if (!session?.invitation) throw new HttpError(409, 'The sample interview is not available.', 'sandbox_gone');

  const existing = await prisma.demoInterviewRun.findUnique({ where: { sessionId: session.id }, select: { id: true } });
  if (existing) {
    const run = await liveRunForGrant(opts.demoGrantId);
    if (run && run.sessionId === session.id) {
      return { run, portalUrl: invitationLink(session.invitation) };
    }
    throw new HttpError(409, 'This demo interview has already been taken.', 'already_taken');
  }
  if (!(await holdStartSlot(opts.demoGrantId, 'candidate'))) {
    throw new HttpError(409, 'This demo interview is already starting.', 'already_starting');
  }

  // The whole sitting's model allowance, claimed from the day now. Refused
  // means the day is full: the mode is withdrawn rather than started and
  // silently degraded, which is the rule the owner set.
  const reservedCalls = await reserveSitting();
  if (reservedCalls <= 0) throw new HttpError(409, 'Watch an interview instead.', 'offer_observer');

  const plan = buildInterviewPlan({ role: sandbox.profile, durationMinutes: DEMO_PLAN_MINUTES, language: 'en', modules: [] });
  await prisma.$transaction([
    prisma.interviewSession.update({ where: { id: session.id }, data: { durationMinutes: DEMO_PLAN_MINUTES } }),
    prisma.interviewPlanVersion.upsert({
      where: { sessionId: session.id },
      create: { sessionId: session.id, version: 1, planJson: JSON.stringify(plan) },
      update: { planJson: JSON.stringify(plan) },
    }),
  ]);

  try {
    const run = await startRun({
      tenantId: opts.tenantId,
      demoGrantId: opts.demoGrantId,
      sessionId: session.id,
      mode: 'candidate',
      extendTime: opts.extendTime,
      reservedCalls,
    });
    return { run, portalUrl: invitationLink(session.invitation) };
  } catch (err) {
    // `sessionId` is unique: a racing start got there first. Hand back what it
    // made rather than an internal error — pressing a button twice is not a
    // failure the visitor should read about.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const run = await liveRunForGrant(opts.demoGrantId);
      if (run) return { run, portalUrl: invitationLink(session.invitation) };
      throw new HttpError(409, 'This demo interview has already been taken.', 'already_taken');
    }
    throw err;
  }
}

/**
 * "Watch one happen" — a written interview, played out in real time.
 *
 * Creates its own candidate and session so the visitor's own sample interview
 * is left untouched: someone who watches one and then sits one must find the
 * second waiting for them, not already used up.
 *
 * The candidate is named as simulated in the row itself, and the address is on
 * a domain that cannot receive mail, so no part of the product can write to a
 * person who does not exist.
 */
export async function startObserverMode(opts: {
  tenantId: string;
  demoGrantId: string;
  extendTime?: boolean;
  now?: Date;
}): Promise<StartedDemoInterview> {
  const now = opts.now ?? new Date();
  const sandbox = await loadSandbox(opts.tenantId);

  const open = await liveRunForGrant(opts.demoGrantId);
  if (open?.mode === 'observer') return { run: open, portalUrl: null };
  if (!(await holdStartSlot(opts.demoGrantId, 'observer'))) {
    const racing = await liveRunForGrant(opts.demoGrantId);
    if (racing) return { run: racing, portalUrl: null };
    throw new HttpError(409, 'This demo interview is already starting.', 'already_starting');
  }

  const plan = buildInterviewPlan({ role: sandbox.profile, durationMinutes: DEMO_PLAN_MINUTES, language: 'en', modules: [] });
  const created = await prisma.$transaction(async (tx) => {
    const candidate = await tx.candidate.create({
      data: {
        tenantId: opts.tenantId,
        roleId: sandbox.roleId,
        fullName: DEMO_SCRIPT_CANDIDATE.fullName,
        email: DEMO_SCRIPT_CANDIDATE.email,
        emailNormalized: DEMO_SCRIPT_CANDIDATE.email,
        phone: '',
      },
    });
    const session = await tx.interviewSession.create({
      data: {
        tenantId: opts.tenantId,
        candidateId: candidate.id,
        roleId: sandbox.roleId,
        scorecardId: sandbox.scorecardId,
        // Straight into the questioning: the script's first line is the
        // opening, and there is nobody to take through a consent screen.
        state: 'ASSESSING',
        provider: 'hosted',
        language: 'en',
        durationMinutes: DEMO_PLAN_MINUTES,
        startedAt: now,
        personaJson: sandbox.personaJson,
        // The observation notice is carried in the recorded disclosure AND
        // spoken in the script's opening turn, which is the same pair of
        // proofs a real observed interview has to produce.
        consentJson: JSON.stringify({
          disclosureText: withObserverNotice(sandbox.disclosureText),
          recordingRequested: false,
          recording: false,
          humanReviewRequired: true,
          observerDisclosed: true,
          consentVersion: 'v1',
          consentedAt: now.toISOString(),
          channel: 'simulation',
          simulated: true,
        }),
        recordingConsent: false,
      },
    });
    await tx.interviewPlanVersion.create({ data: { sessionId: session.id, version: 1, planJson: JSON.stringify(plan) } });
    return session.id;
  });

  logger.info({ tenantId: opts.tenantId, sessionId: created }, 'Started a scripted demo interview for an observer');
  const run = await startRun({
    tenantId: opts.tenantId,
    demoGrantId: opts.demoGrantId,
    sessionId: created,
    mode: 'observer',
    scriptId: DEMO_SCRIPT_ID,
    extendTime: opts.extendTime,
    now,
  });
  return { run, portalUrl: null };
}

export async function startDemoInterview(opts: {
  mode: DemoMode;
  tenantId: string;
  demoGrantId: string;
  extendTime?: boolean;
}): Promise<StartedDemoInterview> {
  return opts.mode === 'candidate' ? startCandidateMode(opts) : startObserverMode(opts);
}
