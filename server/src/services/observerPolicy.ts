/**
 * HR as a silent observer of the AI interview.
 *
 * Observation is only allowed when the candidate was told, before consenting,
 * that a member of the hiring team may watch. This module owns that notice so
 * the scheduler, the candidate portal and the observe endpoint all agree on it.
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
