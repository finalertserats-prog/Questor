import { prisma, parseJson } from '../db.js';

/**
 * HR as a silent observer of the AI interview.
 *
 * Observation is only allowed when the candidate was told, before consenting,
 * that a member of the hiring team may watch. This module owns that notice so
 * the scheduler, the candidate portal, the observe endpoint and the socket all
 * agree on it. The consent gate itself lives here too, because it used to be
 * private to the HTTP router while the socket, the transport the interview
 * actually runs over, enforced nothing.
 */

export const OBSERVER_NOTICE = 'A member of the hiring team may observe this interview live.';

export function hasObserverNotice(disclosureText: string): boolean {
  return disclosureText.includes(OBSERVER_NOTICE);
}

/** The disclosure with the observer notice appended, unless it already has it. */
export function withObserverNotice(disclosureText: string): string {
  if (hasObserverNotice(disclosureText)) return disclosureText;
  return disclosureText.trim().length > 0 ? `${disclosureText.trim()} ${OBSERVER_NOTICE}` : OBSERVER_NOTICE;
}

/** States in which the candidate may be on the call right now. */
export const LIVE_INTERVIEW_STATES = new Set([
  'READY_CHECK', 'WAITING', 'CONNECTING', 'DISCLOSURE', 'CONSENTED', 'WARMUP',
  'ASSESSING', 'CANDIDATE_QUESTIONS', 'CLOSING',
]);

export async function mayObserveLive(session: { id: string; consentJson: string }): Promise<boolean> {
  const consent = parseJson<Record<string, unknown>>(session.consentJson, {});
  // Two conditions. The consent flag comes from the portal page and could be
  // sent by anyone holding the candidate's link, so on its own it proves
  // nothing. The server-side proof is the transcript: an AI turn in which the
  // interviewer actually told the candidate they may be observed.
  const spokenNotice = await prisma.turn.findFirst({
    where: { sessionId: session.id, speaker: 'agent', text: { contains: OBSERVER_NOTICE } },
    orderBy: { index: 'asc' },
    select: { index: true },
  });
  // The notice being in the transcript is not enough on its own: staff can
  // start an interview with no candidate present. So the candidate must also
  // have answered after hearing it...
  const answeredAfterNotice = spokenNotice
    ? await prisma.turn.findFirst({
      where: { sessionId: session.id, speaker: 'candidate', index: { gt: spokenNotice.index } },
      select: { id: true },
    })
    : null;
  // ...and the interview must not have been started or answered from the
  // recruiter console, where nobody may be on the other end to have heard it.
  const staffDriven = await prisma.auditEvent.findFirst({
    where: { entityId: session.id, action: { in: ['interview.started.by_recruiter', 'interview.turn.by_recruiter'] } },
    select: { id: true },
  });
  return consent.observerDisclosed === true && answeredAfterNotice !== null && staffDriven === null;
}
