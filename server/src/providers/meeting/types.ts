// Shared shapes for creating real meetings for human interview rounds.

/** Where a human round's meeting link comes from. `manual` = a recruiter pastes it. */
export const ROUND_MEETING_PROVIDERS = ['manual', 'teams', 'zoom', 'meet'] as const;
export type RoundMeetingProviderId = (typeof ROUND_MEETING_PROVIDERS)[number];
export type VendorId = Exclude<RoundMeetingProviderId, 'manual'>;

export function isRoundMeetingProviderId(value: unknown): value is RoundMeetingProviderId {
  return typeof value === 'string' && (ROUND_MEETING_PROVIDERS as readonly string[]).includes(value);
}

export const PROVIDER_LABEL: Readonly<Record<RoundMeetingProviderId, string>> = {
  manual: 'Manual link',
  teams: 'Microsoft Teams',
  zoom: 'Zoom',
  meet: 'Google Meet',
};

/**
 * What a vendor is told about a round. Deliberately free of candidate personal
 * data: the event lives in a third-party calendar that Questor's erasure and
 * retention cannot reach once the round row is gone.
 */
export interface MeetingDetails {
  readonly title: string;
  readonly description: string;
  readonly startsAt: Date;
  readonly durationMinutes: number;
  /** Stable per attempt; Google uses it to de-duplicate conference creation. */
  readonly requestId: string;
}

export interface CreatedMeeting {
  readonly externalId: string;
  readonly joinUrl: string;
}

export interface MeetingVendor {
  readonly id: VendorId;
  readonly label: string;
  /** Every variable creation needs is set. Never exposes values. */
  isConfigured(): boolean;
  create(details: MeetingDetails): Promise<CreatedMeeting>;
  update(externalId: string, details: MeetingDetails): Promise<void>;
  /** Resolves when the meeting is gone, including when it already was. */
  cancel(externalId: string): Promise<void>;
}
