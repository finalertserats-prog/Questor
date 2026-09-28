import { prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getEmail } from '../providers/email/index.js';
import { brandedEmail, emailButton, escapeHtml, headerSafe } from '../providers/email/branding.js';

/**
 * Tell the hiring team about the moments that need a person.
 *
 * A webhook and an audit row were all these produced, so without a webhook
 * consumer HR only found a finished interview, a candidate asking for a
 * conversation or an accommodation request by opening that candidate. The mail
 * goes to the candidate's owners, or to the organisation's admins when nobody
 * owns them, and links into the app. It never carries the candidate's portal
 * link, and never the text of an accommodation request: that can describe a
 * health condition, and belongs behind sign-in, not in a mailbox.
 */

export type HiringTeamEvent = 'assessment_ready' | 'human_request' | 'accommodation_request';

export interface HiringTeamNotice {
  readonly tenantId: string;
  readonly candidateId: string;
  readonly event: HiringTeamEvent;
  readonly sessionId?: string;
  readonly assessmentId?: string;
}

/** Owners first; the tenant's admins only when the candidate has no owner. */
export async function hiringTeamRecipients(tenantId: string, candidateId: string): Promise<string[]> {
  const owners = await prisma.candidateAssignment.findMany({
    where: { candidateId, relation: 'owner', user: { tenantId } },
    select: { user: { select: { email: true } } },
  });
  const emails = owners.length > 0
    ? owners.map((o) => o.user.email)
    : (await prisma.user.findMany({ where: { tenantId, role: 'admin' }, select: { email: true } })).map((u) => u.email);
  return [...new Set(emails)].sort();
}

function appLink(path: string): string {
  return `${config.webOrigin.replace(/\/+$/, '')}${path}`;
}

function render(notice: HiringTeamNotice, candidateName: string, roleTitle: string | null) {
  const who = roleTitle ? `${candidateName} (${roleTitle})` : candidateName;
  switch (notice.event) {
    case 'assessment_ready':
      return {
        subject: `Assessment ready to review: ${candidateName}`,
        intro: `The AI interview with ${who} has been assessed and is waiting for a person to review it.`,
        link: appLink(notice.assessmentId ? `/assessments/${notice.assessmentId}` : `/candidates/${notice.candidateId}`),
        label: 'Review the assessment',
      };
    case 'human_request':
      return {
        subject: `${candidateName} asked to talk to a person`,
        intro: `${who} read their interview feedback and asked to speak to someone on the hiring team.`,
        link: appLink(`/candidates/${notice.candidateId}`),
        label: 'Open the candidate',
      };
    case 'accommodation_request':
      return {
        subject: `Accommodation request from ${candidateName}`,
        intro: `${who} asked for an accommodation before their interview. The interview is paused until someone on the hiring team follows up. Sign in to read the request.`,
        link: appLink(notice.sessionId ? `/interviews/${notice.sessionId}` : `/candidates/${notice.candidateId}`),
        label: 'Read the request',
      };
  }
}

/**
 * Sends the notice. Never throws: the moment it reports has already happened
 * and been recorded, and a mail fault must not undo or fail it.
 */
export async function notifyHiringTeam(notice: HiringTeamNotice): Promise<{ sentTo: number }> {
  try {
    const email = getEmail();
    if (!email.delivers) return { sentTo: 0 };
    const candidate = await prisma.candidate.findFirst({
      where: { id: notice.candidateId, tenantId: notice.tenantId },
      select: { fullName: true, role: { select: { title: true } } },
    });
    if (!candidate) return { sentTo: 0 };
    const recipients = await hiringTeamRecipients(notice.tenantId, notice.candidateId);
    const view = render(notice, headerSafe(candidate.fullName), candidate.role ? headerSafe(candidate.role.title) : null);
    let sentTo = 0;
    for (const to of recipients) {
      try {
        await email.send(brandedEmail({
          to,
          subject: headerSafe(view.subject),
          text: `${view.intro}\n\n${view.label}: ${view.link}`,
          html: `<p>${escapeHtml(view.intro)}</p>${emailButton(view.link, view.label)}`,
        }));
        sentTo += 1;
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err), event: notice.event, candidateId: notice.candidateId }, 'Hiring team notice failed to send');
      }
    }
    return { sentTo };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err), event: notice.event, candidateId: notice.candidateId }, 'Hiring team notice could not be prepared');
    return { sentTo: 0 };
  }
}
