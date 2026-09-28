import { prisma, parseJsonOptional } from '../db.js';
import { config } from '../config.js';
import { findConnection, tenantAtsReady } from './atsConnections.js';
import { roundMeetingStatus } from '../providers/meeting/roundMeetings.js';
import { INACTIVITY_MS } from './incompleteInterviews.js';
import { plural, type CheckDef, type SectionDef } from './systemHealthTypes.js';

/**
 * Checks any admin may see, about their own organisation only. Every query is
 * filtered by the caller's tenant; nothing here reads another organisation's
 * rows or any deployment setting beyond what /api/admin/providers already shows.
 */

/** A pending delivery this far past its due time means the delivery job is not keeping up. */
export const WEBHOOK_OVERDUE_GRACE_MS = 5 * 60_000;
export const WEBHOOK_OVERDUE_FAIL = 50;
/** Deliveries that exhausted their retries in the last day. */
export const WEBHOOK_FAILED_FAIL = 10;
/** A live interview with no activity for this long was abandoned and the sweep did not close it. */
export const ASSESSING_IDLE_WARN_MS = 2 * 60 * 60_000;
export const FEEDBACK_FAILED_WINDOW_MS = 7 * 24 * 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

const webhookDeliveries: CheckDef = {
  id: 'webhook-deliveries',
  label: 'Webhook deliveries',
  run: async ({ deps, tenantId }) => {
    const now = deps.now().getTime();
    const mine = { endpoint: { tenantId } };
    const [endpoints, pending, overdue, failed] = await Promise.all([
      prisma.webhookEndpoint.count({ where: { tenantId, active: true } }),
      prisma.webhookDelivery.count({ where: { ...mine, status: 'pending' } }),
      prisma.webhookDelivery.count({ where: { ...mine, status: 'pending', nextAttemptAt: { lte: new Date(now - WEBHOOK_OVERDUE_GRACE_MS) } } }),
      prisma.webhookDelivery.count({ where: { ...mine, status: 'failed', createdAt: { gte: new Date(now - DAY_MS) } } }),
    ]);
    if (endpoints === 0 && pending === 0 && failed === 0) {
      return { status: 'info', value: 0, summary: 'No webhooks are set up.' };
    }
    const summary = `${plural(failed, 'delivery', 'deliveries')} failed in the last 24 hours; ${pending} waiting, ${overdue} overdue.`;
    const action = 'Check that each receiver is up and verifies the v2 signature (Webhooks, below). Failed deliveries are not retried.';
    if (failed >= WEBHOOK_FAILED_FAIL || overdue >= WEBHOOK_OVERDUE_FAIL) return { status: 'fail', value: failed, summary, action };
    if (failed > 0 || overdue > 0) return { status: 'warn', value: failed, summary, action };
    return { status: 'ok', value: 0, summary: pending ? `All delivering; ${pending} waiting for their next attempt.` : 'All delivering.' };
  },
};

const webhookV1: CheckDef = {
  id: 'webhook-v1',
  label: 'Webhooks on the old signature',
  run: async ({ tenantId }) => {
    const flagged = await prisma.webhookEndpoint.count({ where: { tenantId, active: true, sendLegacySignature: true } });
    const sending = config.webhookV1Signature === 'off' ? 0 : flagged;
    if (sending === 0) return { status: 'info', value: 0, summary: 'None of your webhooks receive the retired v1 signature.' };
    return {
      status: 'info', value: sending,
      summary: `${plural(sending, 'webhook')} still receive the retired v1 signature.`,
      action: 'Once each receiver verifies v2, choose "Stop sending v1" for it under Webhooks.',
    };
  },
};

const ats: CheckDef = {
  id: 'ats',
  label: 'ATS connection',
  run: async ({ tenantId }) => {
    const connection = await findConnection(tenantId);
    const manage = 'Open Settings, ATS connection.';
    if (!connection || connection.status === 'disconnected') {
      return { status: 'info', value: 'none', summary: 'No ATS is connected.' };
    }
    if (connection.status === 'failed') {
      return { status: 'fail', value: 'failed', summary: `The last connection test to ${connection.provider} failed.`, action: `${manage} Check the address and key, then test again.` };
    }
    if (!(await tenantAtsReady(tenantId))) {
      return { status: 'fail', value: 'unusable', summary: 'The saved ATS key cannot be used.', action: `${manage} Enter the API key again.` };
    }
    if (connection.status === 'untested') {
      return { status: 'info', value: 'untested', summary: `${connection.provider} is connected but has not been tested.`, action: `${manage} Run "Test connection".` };
    }
    return { status: 'ok', value: 'ok', summary: `${connection.provider} is connected and its last test passed.` };
  },
};

const roundMeetings: CheckDef = {
  id: 'round-meetings',
  label: 'Meeting links for human rounds',
  run: async ({ tenantId }) => {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { policyJson: true } });
    const policy = parseJsonOptional<Record<string, unknown>>(tenant?.policyJson, {}, { model: 'Tenant', id: tenantId, field: 'policyJson' });
    const status = roundMeetingStatus(policy);
    if (status.configured) return { status: 'ok', value: status.provider, summary: `${status.label} is selected and ready.` };
    return {
      status: 'warn', value: status.provider,
      summary: `${status.label} is selected but not set up on this deployment, so no meeting link can be created.`,
      action: 'Choose another provider under Connectors, or ask the operator to set this one up.',
    };
  },
};

const stuckFinishing: CheckDef = {
  id: 'interviews-stuck',
  label: 'Interviews stuck finishing',
  run: async ({ deps, tenantId }) => {
    const before = new Date(deps.now().getTime() - INACTIVITY_MS);
    const count = await prisma.interviewSession.count({
      where: { tenantId, state: { in: ['CLOSING', 'PROCESSING'] }, updatedAt: { lt: before } },
    });
    if (count === 0) return { status: 'ok', value: 0, summary: 'None.' };
    return {
      status: 'fail', value: count,
      summary: `${plural(count, 'interview')} ended but ${count === 1 ? 'has' : 'have'} not been processed for over ${Math.round(INACTIVITY_MS / 60_000)} min.`,
      detail: 'The interrupted-interview sweep should have moved these to Technical failure; it may not be running.',
      action: 'Check Background jobs (operator), then open the interviews list.',
    };
  },
};

const technicalFailures: CheckDef = {
  id: 'technical-failures',
  label: 'Technical failures',
  run: async ({ deps, tenantId }) => {
    const since = new Date(deps.now().getTime() - DAY_MS);
    const count = await prisma.interviewSession.count({ where: { tenantId, state: 'TECHNICAL_FAILURE', updatedAt: { gte: since } } });
    if (count === 0) return { status: 'ok', value: 0, summary: 'None in the last 24 hours.' };
    return {
      status: 'warn', value: count, summary: `${plural(count, 'interview')} ended in a technical failure in the last 24 hours.`,
      action: 'Open each one; a technical failure is not the candidate’s fault, so offer them a retake.',
    };
  },
};

const idleLive: CheckDef = {
  id: 'interviews-idle',
  label: 'Live interviews gone quiet',
  run: async ({ deps, tenantId }) => {
    const before = new Date(deps.now().getTime() - ASSESSING_IDLE_WARN_MS);
    const count = await prisma.interviewSession.count({
      where: { tenantId, state: 'ASSESSING', updatedAt: { lt: before }, turns: { none: { createdAt: { gte: before } } } },
    });
    if (count === 0) return { status: 'ok', value: 0, summary: 'None.' };
    return {
      status: 'warn', value: count,
      summary: `${plural(count, 'interview')} still shown as in progress with no activity for over 2 hours.`,
      detail: 'The sweep normally closes these out after an hour, so it may not be running.',
      action: 'Check Background jobs (operator), then contact the candidates.',
    };
  },
};

const feedbackDrafts: CheckDef = {
  id: 'feedback-drafts',
  label: 'Feedback drafts',
  run: async ({ deps, tenantId }) => {
    const since = new Date(deps.now().getTime() - FEEDBACK_FAILED_WINDOW_MS);
    // A failed draft has no timestamp of its own; it is prepared the moment the
    // candidate answers, so the answer's time stands in for it.
    const count = await prisma.candidateFeedbackOptIn.count({ where: { tenantId, draftStatus: 'FAILED', decidedAt: { gte: since } } });
    if (count === 0) return { status: 'ok', value: 0, summary: 'No drafts failed in the last 7 days.' };
    return {
      status: 'warn', value: count,
      summary: `${plural(count, 'candidate')} asked for written feedback in the last 7 days, but the draft could not be prepared.`,
      action: 'Open those interviews and write the feedback by hand.',
    };
  },
};

/**
 * Feedback emails go out with no human check, so one the provider refused (or
 * whose send cannot be confirmed) is otherwise seen only on that one
 * assessment's page. Counted by the last attempt, within the same window.
 */
const feedbackEmails: CheckDef = {
  id: 'feedback-emails',
  label: 'Feedback emails',
  run: async ({ deps, tenantId }) => {
    const since = new Date(deps.now().getTime() - FEEDBACK_FAILED_WINDOW_MS);
    const [failed, unconfirmed] = await Promise.all([
      prisma.candidateFeedbackEmail.count({ where: { tenantId, status: 'FAILED', updatedAt: { gte: since } } }),
      prisma.candidateFeedbackEmail.count({ where: { tenantId, status: 'SENT_UNVERIFIED', updatedAt: { gte: since } } }),
    ]);
    const count = failed + unconfirmed;
    if (count === 0) return { status: 'ok', value: 0, summary: 'No feedback emails failed in the last 7 days.' };
    return {
      status: 'warn', value: count,
      summary: `In the last 7 days, ${plural(failed, 'feedback email')} could not be sent and ${unconfirmed} may not have arrived.`,
      detail: 'Candidates were told nothing for these. The email provider may be refusing mail.',
      action: 'Open each interview\'s feedback panel to resend, and check the email settings.',
    };
  },
};

const legalHolds: CheckDef = {
  id: 'legal-holds',
  label: 'Legal holds',
  run: async ({ tenantId }) => {
    const [sessions, artifacts, rounds] = await Promise.all([
      prisma.interviewSession.count({ where: { tenantId, legalHold: true } }),
      prisma.artifact.count({ where: { tenantId, legalHold: true } }),
      prisma.roundObservation.count({ where: { tenantId, legalHold: true } }),
    ]);
    const total = sessions + artifacts + rounds;
    return {
      status: 'info', value: total,
      summary: total ? `${plural(total, 'record')} under legal hold (${sessions} interviews, ${artifacts} files, ${rounds} observed rounds).` : 'Nothing is under legal hold.',
      detail: total ? 'Held records are never deleted by the retention sweep. Release each hold once it is no longer needed.' : undefined,
    };
  },
};

const noResume: CheckDef = {
  id: 'candidates-without-resume',
  label: 'Candidates without a resume',
  run: async ({ tenantId }) => {
    const count = await prisma.candidate.count({ where: { tenantId, profiles: { none: { rawText: { not: '' } } } } });
    return {
      status: 'info', value: count,
      summary: count ? `${plural(count, 'candidate')} ${count === 1 ? 'has' : 'have'} no resume text.` : 'Every candidate has a resume.',
      detail: count ? 'Their interviews cannot be tailored to their experience. Add a resume from the candidate page.' : undefined,
    };
  },
};

export const tenantSection: SectionDef = {
  id: 'organisation',
  title: 'Your organisation',
  checks: [webhookDeliveries, webhookV1, ats, roundMeetings, stuckFinishing, technicalFailures, idleLive, feedbackDrafts, feedbackEmails, legalHolds, noResume],
};
