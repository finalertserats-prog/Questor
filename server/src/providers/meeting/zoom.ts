import { isVendorConfigured, readEnv } from './connectorEnv.js';
import { callJson, callNoContent } from './vendorApi.js';
import { httpsUrlOrNull, missingJoinUrl } from './vendorHttp.js';
import type { MeetingDetails, MeetingVendor } from './types.js';

// Zoom meetings via a Server-to-Server OAuth app.
// https://developers.zoom.us/docs/api/meetings/#tag/meetings/POST/users/{userId}/meetings

const API = 'https://api.zoom.us/v2';
const SCHEDULED_MEETING = 2;

// Zoom documents start_time as yyyy-MM-ddTHH:mm:ssZ (no milliseconds).
const zoomTime = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const meetingUrl = (id: string) => `${API}/meetings/${encodeURIComponent(id)}`;

const NOT_FOUND_HOST = 'Zoom could not find the host user configured for meetings. An admin should check ZOOM_HOST_USER_ID.';

export const zoomVendor: MeetingVendor = {
  id: 'zoom',
  label: 'Zoom',
  isConfigured: () => isVendorConfigured('zoom'),

  async create(details: MeetingDetails) {
    const data = await callJson({
      provider: 'zoom',
      operation: 'create',
      method: 'POST',
      url: `${API}/users/${encodeURIComponent(readEnv('ZOOM_HOST_USER_ID'))}/meetings`,
      idempotent: false,
      hints: { notFound: NOT_FOUND_HOST },
      body: {
        topic: details.title,
        // Participants can read the agenda; the candidate-page link is for
        // interviewers only, so it stays out.
        agenda: 'Interview scheduled in Questor.',
        type: SCHEDULED_MEETING,
        start_time: zoomTime(details.startsAt),
        duration: details.durationMinutes,
        timezone: 'UTC',
        // The candidate should not be alone in the meeting before the interviewers.
        settings: { join_before_host: false, waiting_room: true },
      },
    });
    const joinUrl = httpsUrlOrNull(data.join_url);
    const id = typeof data.id === 'number' || typeof data.id === 'string' ? String(data.id) : '';
    if (!joinUrl || !id) {
      if (id) await this.cancel(id).catch(() => undefined);
      throw missingJoinUrl('zoom');
    }
    return { externalId: id, joinUrl };
  },

  async update(externalId: string, details: MeetingDetails) {
    // PATCH with absolute values: repeating it lands the same state.
    await callNoContent({
      provider: 'zoom',
      operation: 'update',
      method: 'PATCH',
      url: meetingUrl(externalId),
      idempotent: true,
      hints: { notFound: 'The Zoom meeting no longer exists. Add a new meeting link for this round.' },
      body: { start_time: zoomTime(details.startsAt), duration: details.durationMinutes, timezone: 'UTC' },
    });
  },

  async cancel(externalId: string) {
    await callNoContent({
      provider: 'zoom', operation: 'cancel', method: 'DELETE', url: meetingUrl(externalId), idempotent: true, alsoOk: [404],
    });
  },
};
