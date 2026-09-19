import { isVendorConfigured, readEnv } from './connectorEnv.js';
import { callJson, callNoContent } from './vendorApi.js';
import { httpsUrlOrNull, missingJoinUrl } from './vendorHttp.js';
import type { MeetingDetails, MeetingVendor } from './types.js';

// Microsoft Teams meetings as calendar events with isOnlineMeeting, created in
// the organiser's calendar with an app-only Graph token.
// https://learn.microsoft.com/en-us/graph/api/user-post-events

const GRAPH = 'https://graph.microsoft.com/v1.0';

const eventsUrl = () => `${GRAPH}/users/${encodeURIComponent(readEnv('MS_GRAPH_ORGANIZER_USER_ID'))}/events`;
const eventUrl = (id: string) => `${eventsUrl()}/${encodeURIComponent(id)}`;

// Graph takes a local date-time plus a zone name; UTC keeps it unambiguous.
const graphTime = (date: Date) => ({ dateTime: date.toISOString().slice(0, -1), timeZone: 'UTC' });
const endOf = (details: MeetingDetails) => new Date(details.startsAt.getTime() + details.durationMinutes * 60_000);

const NOT_FOUND_ORGANISER = 'Microsoft Teams could not find the organiser configured for meetings. An admin should check MS_GRAPH_ORGANIZER_USER_ID.';

function joinUrlOf(event: Record<string, unknown>): string | null {
  const online = event.onlineMeeting as { joinUrl?: unknown } | null | undefined;
  return httpsUrlOrNull(online?.joinUrl);
}

export const teamsVendor: MeetingVendor = {
  id: 'teams',
  label: 'Microsoft Teams',
  isConfigured: () => isVendorConfigured('teams'),

  async create(details: MeetingDetails) {
    const event = await callJson({
      provider: 'teams',
      operation: 'create',
      method: 'POST',
      url: eventsUrl(),
      idempotent: false,
      hints: { notFound: NOT_FOUND_ORGANISER },
      body: {
        subject: details.title,
        body: { contentType: 'text', content: details.description },
        start: graphTime(details.startsAt),
        end: graphTime(endOf(details)),
        isOnlineMeeting: true,
        onlineMeetingProvider: 'teamsForBusiness',
        // No attendees: Questor does not hand candidate contact details to the
        // calendar; the recruiter shares the join link.
        allowNewTimeProposals: false,
      },
    });
    const id = typeof event.id === 'string' ? event.id : '';
    if (!id) throw missingJoinUrl('teams');

    // Graph occasionally returns the event before the Teams meeting is attached.
    let joinUrl = joinUrlOf(event);
    if (!joinUrl) {
      const readBack = await callJson({ provider: 'teams', operation: 'read', method: 'GET', url: eventUrl(id), idempotent: true })
        .catch(() => ({} as Record<string, unknown>));
      joinUrl = joinUrlOf(readBack);
    }
    if (!joinUrl) {
      // An event with no way in is worse than none: remove it before failing.
      await this.cancel(id).catch(() => undefined);
      throw missingJoinUrl('teams');
    }
    return { externalId: id, joinUrl };
  },

  async update(externalId: string, details: MeetingDetails) {
    await callNoContent({
      provider: 'teams',
      operation: 'update',
      method: 'PATCH',
      url: eventUrl(externalId),
      // Absolute start/end: repeating the PATCH lands the same state.
      idempotent: true,
      hints: { notFound: 'The Teams meeting no longer exists. Add a new meeting link for this round.' },
      body: { start: graphTime(details.startsAt), end: graphTime(endOf(details)) },
    });
  },

  async cancel(externalId: string) {
    await callNoContent({
      provider: 'teams', operation: 'cancel', method: 'DELETE', url: eventUrl(externalId), idempotent: true, alsoOk: [404],
    });
  },
};
