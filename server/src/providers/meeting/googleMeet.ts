import { isVendorConfigured } from './connectorEnv.js';
import { callJson, callNoContent } from './vendorApi.js';
import { httpsUrlOrNull, missingJoinUrl } from './vendorHttp.js';
import type { MeetingDetails, MeetingVendor } from './types.js';

// Google Meet links via the Calendar API: an event in the impersonated
// Workspace user's primary calendar with a Meet conference attached.
// https://developers.google.com/workspace/calendar/api/guides/create-events#conferencing

const EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const eventUrl = (id: string) => `${EVENTS}/${encodeURIComponent(id)}`;

const googleTime = (date: Date) => ({ dateTime: date.toISOString(), timeZone: 'UTC' });
const endOf = (details: MeetingDetails) => new Date(details.startsAt.getTime() + details.durationMinutes * 60_000);

const NOT_FOUND_CALENDAR = 'Google could not find the calendar of the user meetings are created as. An admin should check GOOGLE_IMPERSONATED_USER.';

function meetLinkOf(event: Record<string, unknown>): string | null {
  const direct = httpsUrlOrNull(event.hangoutLink);
  if (direct) return direct;
  const entryPoints = (event.conferenceData as { entryPoints?: unknown } | undefined)?.entryPoints;
  if (!Array.isArray(entryPoints)) return null;
  const video = entryPoints.find((e: { entryPointType?: unknown }) => e?.entryPointType === 'video') as { uri?: unknown } | undefined;
  return httpsUrlOrNull(video?.uri);
}

export const meetVendor: MeetingVendor = {
  id: 'meet',
  label: 'Google Meet',
  isConfigured: () => isVendorConfigured('meet'),

  async create(details: MeetingDetails) {
    const query = new URLSearchParams({ conferenceDataVersion: '1', sendUpdates: 'none' });
    const event = await callJson({
      provider: 'meet',
      operation: 'create',
      method: 'POST',
      url: `${EVENTS}?${query.toString()}`,
      idempotent: false,
      hints: { notFound: NOT_FOUND_CALENDAR },
      body: {
        summary: details.title,
        description: details.description,
        start: googleTime(details.startsAt),
        end: googleTime(endOf(details)),
        conferenceData: {
          createRequest: { requestId: details.requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } },
        },
      },
    });
    const id = typeof event.id === 'string' ? event.id : '';
    if (!id) throw missingJoinUrl('meet');

    // Conference creation is asynchronous; a "pending" event gets its link shortly.
    let joinUrl = meetLinkOf(event);
    if (!joinUrl) {
      const readBack = await callJson({ provider: 'meet', operation: 'read', method: 'GET', url: eventUrl(id), idempotent: true })
        .catch(() => ({} as Record<string, unknown>));
      joinUrl = meetLinkOf(readBack);
    }
    if (!joinUrl) {
      await this.cancel(id).catch(() => undefined);
      throw missingJoinUrl('meet');
    }
    return { externalId: id, joinUrl };
  },

  async update(externalId: string, details: MeetingDetails) {
    await callNoContent({
      provider: 'meet',
      operation: 'update',
      method: 'PATCH',
      url: `${eventUrl(externalId)}?sendUpdates=none`,
      // Absolute start/end: repeating the PATCH lands the same state.
      idempotent: true,
      hints: { notFound: 'The Google Calendar event no longer exists. Add a new meeting link for this round.' },
      body: { start: googleTime(details.startsAt), end: googleTime(endOf(details)) },
    });
  },

  async cancel(externalId: string) {
    // 410 Gone is how Calendar answers for an event that was already deleted.
    await callNoContent({
      provider: 'meet', operation: 'cancel', method: 'DELETE', url: eventUrl(externalId), idempotent: true, alsoOk: [404, 410],
    });
  },
};
