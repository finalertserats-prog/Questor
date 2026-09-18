/**
 * The role page's decisions, kept free of React so they can be unit tested
 * (see web/tests/roleDetailModel.test.ts).
 */

/**
 * The approve request names exactly what the person looked at. Without it the
 * server approved whatever version was newest when the request landed, which
 * after a colleague's save is not the one on this screen.
 */
export function approvePayload(scorecard: { readonly id: string; readonly version: number }): { scorecardId: string; version: number } {
  return { scorecardId: scorecard.id, version: scorecard.version };
}

export type RoleStatusTarget = 'archived' | 'active';

/** What the archive control offers for a role in `status`. */
export function archiveAction(status: string): { label: string; next: RoleStatusTarget } {
  return status === 'archived'
    ? { label: 'Unarchive role', next: 'active' }
    : { label: 'Archive role', next: 'archived' };
}

/** Which load a response belongs to: the role id asked for, and the order it was asked in. */
export interface LoadTicket {
  readonly id: string | undefined;
  readonly seq: number;
}

/**
 * Whether a response may write to the page: only the newest request, and only
 * for the id still on screen. A slow response for the previous role, or an
 * older reload of this one, is dropped.
 */
export function isCurrentResponse(response: LoadTicket, latest: LoadTicket): boolean {
  return response.id === latest.id && response.seq === latest.seq;
}
