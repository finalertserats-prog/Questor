/**
 * Display logic for a human round's meeting, kept free of React so it can be
 * unit tested (see web/tests/roundMeetingModel.test.ts). Mirrors the statuses in
 * server/src/services/roundMeeting.ts.
 */

export type MeetingStatus =
  | 'LINKED' | 'MANUAL' | 'NEEDS_LINK' | 'CREATING' | 'OUT_OF_SYNC' | 'CANCELLED' | 'CANCEL_FAILED';

export interface RoundMeetingView {
  readonly provider: string | null;
  readonly status: MeetingStatus;
  readonly url: string | null;
  readonly error: string | null;
  /** A creation that never finished; the fallbacks are offered again. */
  readonly stuck?: boolean;
}

export interface MeetingProviderInfo {
  readonly provider: string;
  readonly label: string;
  readonly configured: boolean;
}

export interface MeetingOutcome {
  readonly ok: boolean;
  readonly provider: string;
  readonly status: MeetingStatus | null;
  readonly url: string | null;
  readonly message: string;
}

const LABELS: Readonly<Record<string, string>> = {
  manual: 'Manual link',
  teams: 'Microsoft Teams',
  zoom: 'Zoom',
  meet: 'Google Meet',
};

export function providerLabel(provider: string | null): string {
  return (provider && LABELS[provider]) || 'Meeting';
}

/** Only https links are ever rendered, whatever the server sent. */
export function safeMeetingUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Null when the link is acceptable; otherwise what to fix. Matches the server's check. */
export function meetingLinkProblem(input: string): string | null {
  const value = input.trim();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'Enter the full meeting link, starting with https://';
  }
  return parsed.protocol === 'https:' ? null : 'Meeting links must start with https://';
}

export interface MeetingSummary {
  readonly text: string;
  readonly tone: 'ok' | 'info' | 'error';
  readonly link: string | null;
  readonly canRetry: boolean;
  readonly canAddLink: boolean;
}

/**
 * `vendorReady`: the organisation now has a working provider, so a round that
 * was scheduled without one can still get a generated meeting.
 */
export function meetingSummary(meeting: RoundMeetingView, roundStatus: string, vendorReady = false): MeetingSummary {
  const scheduled = roundStatus === 'SCHEDULED';
  const label = providerLabel(meeting.provider);
  const link = scheduled ? safeMeetingUrl(meeting.url) : null;
  switch (meeting.status) {
    case 'LINKED':
      return { text: `${label} meeting`, tone: 'ok', link, canRetry: false, canAddLink: false };
    case 'MANUAL':
      return { text: 'Meeting link added by hand', tone: 'ok', link, canRetry: false, canAddLink: scheduled };
    case 'CREATING':
      return meeting.stuck
        ? { text: `Creating the ${label} meeting did not finish. Try again, or add a link manually.`, tone: 'error', link: null, canRetry: scheduled, canAddLink: scheduled }
        : { text: `${label} meeting is being created…`, tone: 'info', link: null, canRetry: false, canAddLink: false };
    case 'NEEDS_LINK': {
      // A vendor failure can be retried; with no vendor there is nothing to retry.
      const vendorFailed = meeting.provider !== 'manual' && meeting.error !== null;
      return {
        text: meeting.error ?? 'No meeting link yet. Add one for this round.',
        tone: vendorFailed ? 'error' : 'info',
        link: null,
        canRetry: scheduled && (vendorFailed || vendorReady),
        canAddLink: scheduled,
      };
    }
    case 'OUT_OF_SYNC':
      return { text: meeting.error ?? `The ${label} meeting still has the old time.`, tone: 'error', link, canRetry: scheduled, canAddLink: false };
    case 'CANCEL_FAILED':
      return { text: meeting.error ?? `The ${label} meeting could not be removed.`, tone: 'error', link: null, canRetry: true, canAddLink: false };
    case 'CANCELLED':
      return { text: `${label} meeting removed`, tone: 'info', link: null, canRetry: false, canAddLink: false };
    default: {
      const unreachable: never = meeting.status;
      return { text: String(unreachable), tone: 'info', link: null, canRetry: false, canAddLink: false };
    }
  }
}

/** What the schedule form says will happen about the meeting. */
export function scheduleHint(info: MeetingProviderInfo | null): string {
  if (!info || info.provider === 'manual') {
    return 'Paste the meeting link below, or add it later. No meeting provider is selected for your organisation.';
  }
  if (!info.configured) {
    return `${info.label} is selected but not fully set up on the server, so no meeting will be created. Paste a link below, or ask an admin to finish the setup.`;
  }
  return `A ${info.label} meeting will be created when you schedule. To use your own link instead, paste it below.`;
}
