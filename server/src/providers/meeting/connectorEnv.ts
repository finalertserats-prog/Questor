// Which server/.env variables each meeting adapter needs.
//
// Read from process.env at call time (not frozen into config at import) so an
// admin's status view reflects the running process, and so tests can stub a
// variable without re-importing the app.
//
// Only presence is ever exposed. A value — even a partial one — never leaves
// this module: the admin API reports names and booleans, nothing else.

export const MEETING_ADAPTER_IDS = ['hosted', 'teams', 'zoom', 'meet'] as const;
export type MeetingAdapterId = (typeof MEETING_ADAPTER_IDS)[number];

export const MEETING_ENV: Readonly<Record<MeetingAdapterId, readonly string[]>> = {
  // The built-in room has no vendor and therefore no credentials.
  hosted: [],
  // Microsoft Entra app registration, client-credentials flow against Graph.
  teams: ['MS_GRAPH_TENANT_ID', 'MS_GRAPH_CLIENT_ID', 'MS_GRAPH_CLIENT_SECRET'],
  // Zoom Server-to-Server OAuth app.
  zoom: ['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET'],
  // Google Cloud service account with Workspace domain-wide delegation.
  meet: ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', 'GOOGLE_IMPERSONATED_USER'],
};

export interface EnvPresence {
  readonly name: string;
  readonly present: boolean;
}

export function isMeetingAdapterId(value: string): value is MeetingAdapterId {
  return (MEETING_ADAPTER_IDS as readonly string[]).includes(value);
}

export function readEnv(name: string): string {
  return (process.env[name] ?? '').trim();
}

export function envPresence(id: MeetingAdapterId): EnvPresence[] {
  return MEETING_ENV[id].map((name) => ({ name, present: readEnv(name) !== '' }));
}

export function missingEnv(id: MeetingAdapterId): string[] {
  return envPresence(id).filter((v) => !v.present).map((v) => v.name);
}

export function isConfigured(id: MeetingAdapterId): boolean {
  return missingEnv(id).length === 0;
}
