import { config } from '../../config.js';
import { envPresence, isConfigured, type EnvPresence, type MeetingAdapterId } from './connectorEnv.js';

// Meeting adapters (BRD FR-041, Section 13). Each adapter publishes its
// capabilities and graceful-fallback behavior. `hosted` (Questor browser room)
// is the MVP default and fully implemented via the realtime socket layer.
// Teams / Zoom / Meet do not host the AI interview; their credentials can be
// verified here (Admin → Connectors → Test connection), and they create the
// meeting links for human interview rounds (see roundMeetings.ts).

export interface MeetingCapability {
  provider: string;
  /** True when every variable the adapter needs is set. Never carries values. */
  configured: boolean;
  /** Whether MEETING_PROVIDER currently selects this adapter. */
  selected: boolean;
  /**
   * Variable names and whether each is set — names only, never values, and
   * only for callers that asked for it. Which vendor credentials a deployment
   * holds is setup detail for admins, so it is absent by default rather than
   * filtered out at each route.
   */
  env?: EnvPresence[];
  capabilities: {
    createSpace: boolean;
    liveMedia: boolean;
    recording: boolean;
    transcript: boolean;
    botJoin: boolean;
  };
  fallback: string;
  reference: string;
}

const VENDOR_ADAPTERS: readonly string[] = ['teams', 'zoom', 'meet'];

function status(id: MeetingAdapterId) {
  const selectedId = VENDOR_ADAPTERS.includes(config.meeting.provider) ? config.meeting.provider : 'hosted';
  return { configured: isConfigured(id), selected: selectedId === id, env: envPresence(id) };
}

function capabilityWithEnv(provider: string): MeetingCapability {
  switch (provider) {
    case 'teams':
      return {
        provider: 'teams',
        ...status('teams'),
        capabilities: { createSpace: true, liveMedia: true, recording: true, transcript: true, botJoin: true },
        fallback: 'On missing Graph/RT-media credentials, fall back to hosted room.',
        reference: 'https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/real-time-media-concepts',
      };
    case 'zoom':
      return {
        provider: 'zoom',
        ...status('zoom'),
        capabilities: { createSpace: true, liveMedia: true, recording: true, transcript: true, botJoin: true },
        fallback: 'On missing Meeting SDK / RTMS credentials, fall back to hosted room.',
        reference: 'https://developers.zoom.us/docs/rtms/meetings/',
      };
    case 'meet':
      return {
        provider: 'meet',
        ...status('meet'),
        capabilities: { createSpace: true, liveMedia: false, recording: true, transcript: true, botJoin: false },
        fallback: 'Meet API supports post-conference records/transcripts; live bot media limited — use hosted room for live.',
        reference: 'https://developers.google.com/workspace/meet/api/reference/rest/v2',
      };
    default:
      return {
        provider: 'hosted',
        ...status('hosted'),
        capabilities: { createSpace: true, liveMedia: true, recording: true, transcript: true, botJoin: true },
        fallback: 'Native Questor room; no external dependency.',
        reference: 'internal',
      };
  }
}

/**
 * The adapter's capabilities, without the variable-presence list unless it is
 * asked for. The default is the safe one: every route that returns a capability
 * to a non-admin (interview creation, for one) gets no configuration detail
 * without having to remember to strip it.
 */
export function meetingCapability(provider = config.meeting.provider, options: { includeEnv?: boolean } = {}): MeetingCapability {
  const capability = capabilityWithEnv(provider);
  if (options.includeEnv) return capability;
  const { env: _env, ...withoutEnv } = capability;
  return withoutEnv;
}

export function allMeetingCapabilities(): MeetingCapability[] {
  return ['hosted', 'teams', 'zoom', 'meet'].map((p) => capabilityWithEnv(p));
}
