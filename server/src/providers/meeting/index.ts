import { config } from '../../config.js';

// Meeting adapters (BRD FR-041, Section 13). Each adapter publishes its
// capabilities and graceful-fallback behavior. `hosted` (Questor browser room)
// is the MVP default and fully implemented via the realtime socket layer.
// Teams / Zoom / Meet adapters are capability-declared connector seams to plug
// in once the enterprise SDK credentials/licenses are available.

export interface MeetingCapability {
  provider: string;
  configured: boolean;
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

export function meetingCapability(provider = config.meeting.provider): MeetingCapability {
  switch (provider) {
    case 'teams':
      return {
        provider: 'teams',
        configured: false,
        capabilities: { createSpace: true, liveMedia: true, recording: true, transcript: true, botJoin: true },
        fallback: 'On missing Graph/RT-media credentials, fall back to hosted room.',
        reference: 'https://learn.microsoft.com/en-us/microsoftteams/platform/bots/calls-and-meetings/real-time-media-concepts',
      };
    case 'zoom':
      return {
        provider: 'zoom',
        configured: false,
        capabilities: { createSpace: true, liveMedia: true, recording: true, transcript: true, botJoin: true },
        fallback: 'On missing Meeting SDK / RTMS credentials, fall back to hosted room.',
        reference: 'https://developers.zoom.us/docs/rtms/meetings/',
      };
    case 'meet':
      return {
        provider: 'meet',
        configured: false,
        capabilities: { createSpace: true, liveMedia: false, recording: true, transcript: true, botJoin: false },
        fallback: 'Meet API supports post-conference records/transcripts; live bot media limited — use hosted room for live.',
        reference: 'https://developers.google.com/workspace/meet/api/reference/rest/v2',
      };
    default:
      return {
        provider: 'hosted',
        configured: true,
        capabilities: { createSpace: true, liveMedia: true, recording: true, transcript: true, botJoin: true },
        fallback: 'Native Questor room; no external dependency.',
        reference: 'internal',
      };
  }
}

export function allMeetingCapabilities(): MeetingCapability[] {
  return ['hosted', 'teams', 'zoom', 'meet'].map((p) => meetingCapability(p));
}
