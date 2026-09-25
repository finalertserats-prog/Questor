import { prisma, parseJsonOptional } from '../db.js';
import { personaNameOf } from '../domain/persona.js';
import {
  feedbackOutlook, interviewMinutes, retentionUntil, statusOutcome,
  type FeedbackView, type StatusOutcome,
} from '../domain/candidateStatusModel.js';
import { autoCandidateFeedbackEnabled } from './autoFeedbackModel.js';
import { readTenantPolicy } from './candidateFeedbackPolicy.js';
import { retentionDays } from './dataRights.js';
import { tenantTimeZone } from './tenantTimeZone.js';
import { formatScheduledTime } from './zonedTime.js';

/**
 * The candidate's own status page, assembled.
 *
 * Read-only and deliberately narrow. Everything this returns is a date, a
 * duration, a name the candidate already knows, or an enum about where the
 * process is. It never reads `recommendation`, `disposition`, `resultJson` or
 * any competency level, and it never touches another candidate's rows — see
 * domain/candidateStatusModel.ts for why that boundary is drawn in code rather
 * than in a reviewer's head.
 */

export interface StatusRound {
  readonly scheduledAt: Date;
  readonly timeZone: string | null;
  /** The booked time written out on the clock it was booked on. */
  readonly text: string;
  /** The people they will be talking to, when the round names them. */
  readonly interviewers: readonly string[];
  /** A meeting link exists, so the invitation is real rather than pencilled in. */
  readonly booked: boolean;
}

export interface CandidateStatusView {
  readonly candidateName: string;
  readonly roleTitle: string;
  readonly organisation: string;
  /** The AI interviewer they talked to, by the name it used. */
  readonly interviewer: string | null;
  readonly outcome: StatusOutcome;
  /** The zone every date below should be read on. */
  readonly timeZone: string | null;
  readonly appliedAt: Date | null;
  /** What that first date actually records, so the page can word it honestly. */
  readonly appliedKind: 'application' | 'invitation' | null;
  readonly interviewAt: Date | null;
  readonly interviewMinutes: number | null;
  /** When a person on the team completed their read of it. */
  readonly readByTeamAt: Date | null;
  readonly nextRound: StatusRound | null;
  /** Set only once the team's decision has actually reached the candidate. */
  readonly decisionSharedAt: Date | null;
  readonly feedback: FeedbackView;
  readonly talkToAPerson: { readonly requested: boolean; readonly requestedAt: Date | null };
  readonly retainUntil: Date;
}

type LoadedSession = {
  id: string;
  tenantId: string;
  candidateId: string;
  roleId: string;
  state: string;
  personaJson: string;
  startedAt: Date | null;
  completedAt: Date | null;
  retainUntil: Date | null;
  scheduledTimeZone: string | null;
  createdAt: Date;
  candidate: { fullName: string };
  role: { title: string };
  tenant: { name: string };
};

/** The select every caller needs; kept here so the route cannot widen it. */
export const STATUS_SESSION_SELECT = {
  id: true, tenantId: true, candidateId: true, roleId: true, state: true, personaJson: true,
  startedAt: true, completedAt: true, retainUntil: true, scheduledTimeZone: true, createdAt: true,
  candidate: { select: { fullName: true } },
  role: { select: { title: true } },
  tenant: { select: { name: true } },
} as const;

export async function buildCandidateStatus(
  s: LoadedSession,
  invitation: { sentAt: Date | null; createdAt: Date },
): Promise<CandidateStatusView> {
  const outcome = statusOutcome(s.state, s.completedAt);

  const [policy, pipeline, delivery, autoEmail, optIn, humanRequest, review, zone] = await Promise.all([
    readTenantPolicy(s.tenantId),
    prisma.candidatePipeline.findUnique({
      where: { candidateId_roleId: { candidateId: s.candidateId, roleId: s.roleId } },
      select: {
        createdAt: true, status: true, decidedAt: true,
        rounds: {
          where: { status: 'SCHEDULED', conductedBy: 'HUMAN' },
          orderBy: { scheduledAt: 'asc' },
          select: { scheduledAt: true, scheduledTimeZone: true, interviewersJson: true, meetingUrl: true, id: true },
        },
      },
    }),
    prisma.candidateFeedbackDelivery.findFirst({
      where: { assessment: { sessionId: s.id } },
      orderBy: { createdAt: 'desc' },
      select: { status: true, sentAt: true },
    }),
    prisma.candidateFeedbackEmail.findUnique({
      where: { sessionId: s.id },
      select: { status: true, sentAt: true, nextAttemptAt: true },
    }),
    prisma.candidateFeedbackOptIn.findUnique({ where: { sessionId: s.id }, select: { choice: true } }),
    prisma.candidateHumanRequest.findUnique({ where: { sessionId: s.id }, select: { status: true, requestedAt: true } }),
    prisma.humanReview.findFirst({
      where: { assessment: { sessionId: s.id }, status: 'COMPLETED', supersededAt: null },
      orderBy: { completedAt: 'desc' },
      select: { completedAt: true },
    }),
    s.scheduledTimeZone ? Promise.resolve(s.scheduledTimeZone) : tenantTimeZone(s.tenantId),
  ]);

  const feedback = feedbackOutlook({
    outcome,
    approvedFlowEnabled: policy.candidateFeedbackEnabled === true,
    autoEmailEnabled: autoCandidateFeedbackEnabled(policy),
    optInChoice: optIn?.choice ?? null,
    delivery,
    autoEmail,
  });

  // A round that has not happened yet, and only after this interview: a round
  // already in the past is not "what happens next", and one this session IS
  // would be the conversation they have just had.
  const upcoming = (pipeline?.rounds ?? []).find((r) => r.scheduledAt.getTime() > Date.now());

  return {
    candidateName: s.candidate.fullName,
    roleTitle: s.role.title,
    organisation: s.tenant.name,
    interviewer: personaNameOf(s.personaJson, s.id),
    outcome,
    timeZone: zone,
    appliedAt: pipeline?.createdAt ?? invitation.sentAt ?? invitation.createdAt,
    // "Applied" is only true when a pipeline row records an application. When
    // all we hold is the invitation we say so, rather than telling someone they
    // applied on a day they may not have.
    appliedKind: pipeline ? 'application' : 'invitation',
    interviewAt: s.completedAt,
    interviewMinutes: interviewMinutes(s.startedAt, s.completedAt),
    readByTeamAt: review?.completedAt ?? null,
    nextRound: upcoming
      ? {
        scheduledAt: upcoming.scheduledAt,
        timeZone: upcoming.scheduledTimeZone ?? zone,
        text: formatScheduledTime(upcoming.scheduledAt, upcoming.scheduledTimeZone ?? zone),
        interviewers: parseJsonOptional<string[]>(upcoming.interviewersJson, [], {
          model: 'InterviewRound', id: upcoming.id, field: 'interviewersJson',
        }).filter((name) => typeof name === 'string' && name.trim().length > 0),
        booked: Boolean(upcoming.meetingUrl),
      }
      : null,
    // Only once the words have actually reached them. A page that announced "a
    // decision has been made" and would not say what it was, hours before the
    // email, would be the worst screen in the product.
    decisionSharedAt: pipeline?.status === 'DECIDED' && pipeline.decidedAt && feedback.outlook === 'arrived'
      ? pipeline.decidedAt
      : null,
    feedback,
    talkToAPerson: {
      requested: humanRequest?.status === 'REQUESTED',
      requestedAt: humanRequest?.requestedAt ?? null,
    },
    retainUntil: retentionUntil(s, retentionDays()),
  };
}
