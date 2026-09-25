import { useCallback, useState } from 'react';
import { EMPTY_ANNOUNCER, say, type AnnouncerState, type RoomEvent } from './roomAnnouncements';

/**
 * The room's two voices for a screen reader: one that waits for a gap, and one
 * that interrupts. What may go into them — and what may never — is decided by
 * roomAnnouncements.ts; this only renders it.
 *
 * Two nodes per channel, because a live region announces a CHANGE. Saying
 * "Got it — one moment." into the same node after a second answer would be
 * silent; alternating nodes makes the identical message a real change.
 */
export function RoomAnnouncer({ state }: { readonly state: AnnouncerState }) {
  return (
    <div className="visually-hidden" data-testid="room-announcer">
      <div role="status" aria-live="polite" aria-atomic="true">{state.polite[0]}</div>
      <div role="status" aria-live="polite" aria-atomic="true">{state.polite[1]}</div>
      <div role="alert" aria-live="assertive" aria-atomic="true">{state.assertive[0]}</div>
      <div role="alert" aria-live="assertive" aria-atomic="true">{state.assertive[1]}</div>
    </div>
  );
}

export interface Announcer {
  readonly state: AnnouncerState;
  /** Announce an event, or nothing when there is none. A repeat of the same event is dropped. */
  readonly announce: (event: RoomEvent | null) => void;
}

export function useAnnouncer(): Announcer {
  const [state, setState] = useState<AnnouncerState>(EMPTY_ANNOUNCER);
  const announce = useCallback((event: RoomEvent | null) => { setState((current) => say(current, event)); }, []);
  return { state, announce };
}
