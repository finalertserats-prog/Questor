/**
 * What the candidate's consent screen may do next, and whether the interview
 * room is allowed to listen. Kept free of React so it can be unit tested (see
 * web/tests/portalConsentModel.test.ts).
 */

/** The server's own floor for an accommodation request (server routes/portal.ts). */
export const MIN_ACCOMMODATION_CHARS = 10;

export interface ConsentChoices {
  readonly accepted: boolean;
  readonly accommodation: string;
}

/** What pressing the one button on the consent step would do. */
export type ConsentAction = 'consent' | 'accommodation' | 'none';

/**
 * WHY the voice-capture tick is not part of this: a candidate who declines it
 * still gets an interview — they type their answers instead. Requiring it would
 * turn a choice about a microphone into a condition of being interviewed at
 * all. Agreeing to the AI round ("I understand") is the thing that opens the
 * door.
 *
 * WHY a short accommodation request blocks: the server refuses anything under
 * its own minimum, so a shorter one used to be posted, dropped and the
 * candidate moved along as though they had never asked.
 */
export function consentAction({ accepted, accommodation }: ConsentChoices): ConsentAction {
  const written = accommodation.trim().length;
  if (written > 0 && written < MIN_ACCOMMODATION_CHARS) return 'none';
  if (written >= MIN_ACCOMMODATION_CHARS) return 'accommodation';
  return accepted ? 'consent' : 'none';
}

export function canSubmitConsent(draft: ConsentChoices & { readonly busy: boolean }): boolean {
  return !draft.busy && consentAction(draft) !== 'none';
}

/** The line under the accommodation field, which says what the press will do. */
export function accommodationHint(accommodation: string): string {
  const written = accommodation.trim().length;
  if (written === 0) {
    return `Optional. Write at least ${MIN_ACCOMMODATION_CHARS} characters and we will route your request to our team instead of starting the AI interview.`;
  }
  if (written < MIN_ACCOMMODATION_CHARS) {
    return `A little more — at least ${MIN_ACCOMMODATION_CHARS} characters — so your request reaches our team rather than being dropped.`;
  }
  return 'This goes to our team instead of starting the AI interview.';
}

/**
 * May the interview room capture audio?
 *
 * Only an explicit yes counts. An older server sends no such field, and an
 * absent answer is not consent — the room types instead.
 */
export function shouldCaptureAudio(recordingConsented: unknown): boolean {
  return recordingConsented === true;
}
