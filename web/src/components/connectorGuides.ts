/**
 * Setup guides for Admin → Connectors.
 *
 * Kept as data so tests can pin the variable names to exactly what the server
 * reads (server/src/config.ts, server/src/providers/meeting/connectorEnv.ts).
 * A guide that names a variable the server ignores is worse than no guide: the
 * admin sets it, restarts, and nothing happens.
 *
 * Placeholders are angle-bracketed descriptions, never realistic-looking values.
 */

export type ConnectorGroup = 'meeting' | 'email' | 'ats';

export interface EnvPresence {
  readonly name: string;
  readonly present: boolean;
}

export interface EnvVarGuide {
  readonly name: string;
  readonly placeholder: string;
  readonly note?: string;
}

export interface CallbackTemplate {
  readonly label: string;
  /** Path appended to the app's public URL. */
  readonly path: string;
}

export interface ConnectorGuide {
  readonly id: string;
  readonly group: ConnectorGroup;
  readonly title: string;
  readonly vendorAccount: string;
  readonly steps: readonly string[];
  readonly envVars: readonly EnvVarGuide[];
  readonly permissions: readonly string[];
  readonly callbacks: readonly CallbackTemplate[];
  /** Shown when there are no callbacks, so "none" is an explicit answer. */
  readonly callbackNote: string;
  readonly docsUrl: string;
  readonly docsLabel: string;
}

export const RESTART_NOTE =
  'Keys are set on the server, not here: add the variables to server/.env and restart the Questor server, then reload this page. Questor never stores connector credentials in the database and never shows their values.';

const APP_ONLY_AUTH = 'None needed. This connector uses app-only (server-to-server) authentication, so there is no sign-in redirect and no webhook to register.';

export const CONNECTOR_GUIDES: readonly ConnectorGuide[] = [
  {
    id: 'hosted',
    group: 'meeting',
    title: 'Questor hosted room',
    vendorAccount: 'None. This is the built-in browser interview room, and it is the default.',
    steps: [
      'No credentials and no vendor account are needed.',
      'Leave MEETING_PROVIDER unset (or set it to hosted) in server/.env.',
      'Make sure WEB_ORIGIN in server/.env is the public https address candidates open. Browsers only allow camera and microphone on https.',
      'Test connection checks that the database is reachable and that WEB_ORIGIN is valid (https in production).',
    ],
    envVars: [],
    permissions: [],
    callbacks: [{ label: 'Health check on the public URL', path: '/api/health' }],
    callbackNote: '',
    docsUrl: 'https://socket.io/docs/v4/',
    docsLabel: 'Socket.IO docs (the room\'s realtime layer)',
  },
  {
    id: 'zoom',
    group: 'meeting',
    title: 'Zoom',
    vendorAccount: 'A Zoom account where you are an admin (or have the "Server-to-Server OAuth app" role permission), with a Server-to-Server OAuth app created in the Zoom App Marketplace.',
    steps: [
      'Sign in at marketplace.zoom.us, open Develop → Build App and choose "Server-to-Server OAuth App".',
      'Copy the Account ID, Client ID and Client Secret from the App Credentials page.',
      'Under Scopes, add the scopes listed below, then Activate the app. An inactive app is rejected by the connection test.',
      'Pick the Zoom user who hosts interview meetings and set ZOOM_HOST_USER_ID to their email address or Zoom user ID.',
      'Add the variables to server/.env and restart the server. Then choose Zoom under "Meeting links for human rounds".',
    ],
    envVars: [
      { name: 'ZOOM_ACCOUNT_ID', placeholder: '<Account ID from App Credentials>' },
      { name: 'ZOOM_CLIENT_ID', placeholder: '<Client ID from App Credentials>' },
      { name: 'ZOOM_CLIENT_SECRET', placeholder: '<Client Secret from App Credentials>', note: 'secret — keep it only in server/.env' },
      { name: 'ZOOM_HOST_USER_ID', placeholder: '<email or user ID of the Zoom user who hosts the meetings>' },
    ],
    permissions: [
      'meeting:write:meeting:admin (create meetings for users in the account)',
      'meeting:update:meeting:admin (move a meeting when a round is rescheduled)',
      'meeting:delete:meeting:admin (remove a meeting when a round is cancelled)',
      'The connection test itself only obtains a token, so it passes before scopes are added.',
    ],
    callbacks: [],
    callbackNote: APP_ONLY_AUTH,
    docsUrl: 'https://developers.zoom.us/docs/internal-apps/s2s-oauth/',
    docsLabel: 'Zoom: Server-to-Server OAuth',
  },
  {
    id: 'teams',
    group: 'meeting',
    title: 'Microsoft Teams',
    vendorAccount: 'A Microsoft 365 tenant with Teams, and an app registration in Microsoft Entra ID created by someone who can grant admin consent.',
    steps: [
      'In the Microsoft Entra admin center open App registrations → New registration (single tenant).',
      'Copy the Directory (tenant) ID and Application (client) ID from the Overview page.',
      'Under Certificates & secrets create a client secret and copy its Value (not the Secret ID). Note the expiry date.',
      'Under API permissions add the Microsoft Graph Application permissions below, then click "Grant admin consent".',
      'Pick the Microsoft 365 user whose calendar holds interview meetings (for example an HR mailbox) and set MS_GRAPH_ORGANIZER_USER_ID to their user object ID or email. To keep the app out of other mailboxes, an Exchange admin can limit it with an application access policy (New-ApplicationAccessPolicy).',
      'Add the variables to server/.env and restart the server. Then choose Microsoft Teams under "Meeting links for human rounds".',
    ],
    envVars: [
      { name: 'MS_GRAPH_TENANT_ID', placeholder: '<Directory (tenant) ID>' },
      { name: 'MS_GRAPH_CLIENT_ID', placeholder: '<Application (client) ID>' },
      { name: 'MS_GRAPH_CLIENT_SECRET', placeholder: '<client secret Value>', note: 'secret — keep it only in server/.env' },
      { name: 'MS_GRAPH_ORGANIZER_USER_ID', placeholder: '<object ID or email of the calendar that holds the meetings>' },
    ],
    permissions: [
      'Calendars.ReadWrite (Application) — create, move and remove Teams meetings as calendar events',
      'Admin consent is required.',
    ],
    callbacks: [],
    callbackNote: APP_ONLY_AUTH,
    docsUrl: 'https://learn.microsoft.com/en-us/graph/auth-v2-service',
    docsLabel: 'Microsoft Graph: get access without a user',
  },
  {
    id: 'meet',
    group: 'meeting',
    title: 'Google Meet',
    vendorAccount: 'A Google Workspace domain (where you or your Workspace admin can configure domain-wide delegation) and a Google Cloud project.',
    steps: [
      'In the Google Cloud console create or pick a project and enable the "Google Calendar API".',
      'Create a service account, then create a JSON key for it and download the file.',
      'In the Google Workspace Admin console open Security → Access and data control → API controls → Domain-wide delegation, and add the service account\'s client ID with the scope below.',
      'Pick the Workspace user that meetings will be created as (for example an HR mailbox); the events go in their calendar.',
      'Copy client_email and private_key from the JSON file into server/.env (keep the private key in double quotes with its \\n sequences), then restart the server. Then choose Google Meet under "Meeting links for human rounds".',
    ],
    envVars: [
      { name: 'GOOGLE_SERVICE_ACCOUNT_EMAIL', placeholder: '<client_email from the JSON key file>' },
      { name: 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', placeholder: '<private_key from the JSON key file>', note: 'secret — keep it only in server/.env' },
      { name: 'GOOGLE_IMPERSONATED_USER', placeholder: '<Workspace user email meetings are created as>' },
    ],
    permissions: [
      'https://www.googleapis.com/auth/calendar.events',
    ],
    callbacks: [],
    callbackNote: APP_ONLY_AUTH,
    docsUrl: 'https://developers.google.com/workspace/calendar/api/guides/create-events',
    docsLabel: 'Google Calendar API: create events with Meet conferencing',
  },
  {
    id: 'email-sendgrid',
    group: 'email',
    title: 'Email via SendGrid',
    vendorAccount: 'A Twilio SendGrid account with a verified sender or authenticated domain.',
    steps: [
      'In SendGrid, verify the sender address or authenticate your domain.',
      'Create an API key with Restricted Access and only "Mail Send" enabled.',
      'Add the variables to server/.env and restart the server. Without them, invitations are only written to the server log and never reach candidates.',
    ],
    envVars: [
      { name: 'EMAIL_PROVIDER', placeholder: 'sendgrid' },
      { name: 'SENDGRID_API_KEY', placeholder: '<SendGrid API key>', note: 'secret — keep it only in server/.env' },
      { name: 'EMAIL_FROM', placeholder: '<verified sender address>' },
    ],
    permissions: ['Mail Send (restricted API key)'],
    callbacks: [],
    callbackNote: 'None needed.',
    docsUrl: 'https://www.twilio.com/docs/sendgrid/ui/account-and-settings/api-keys',
    docsLabel: 'SendGrid: API keys',
  },
  {
    id: 'email-smtp',
    group: 'email',
    title: 'Email via SMTP',
    vendorAccount: 'A mailbox on your own mail server or provider that allows authenticated SMTP sending.',
    steps: [
      'Get the SMTP host, port and a username and password (or app password) for the sending mailbox from your mail provider.',
      'Add the variables to server/.env and restart the server. Port 465 uses implicit TLS; other ports use STARTTLS.',
    ],
    envVars: [
      { name: 'EMAIL_PROVIDER', placeholder: 'smtp' },
      { name: 'SMTP_HOST', placeholder: '<smtp host name>' },
      { name: 'SMTP_PORT', placeholder: '587' },
      { name: 'SMTP_USER', placeholder: '<mailbox user name>' },
      { name: 'SMTP_PASS', placeholder: '<mailbox password or app password>', note: 'secret — keep it only in server/.env' },
      { name: 'EMAIL_FROM', placeholder: '<sending address>' },
    ],
    permissions: ['Authenticated SMTP sending enabled for the mailbox'],
    callbacks: [],
    callbackNote: 'None needed.',
    docsUrl: 'https://nodemailer.com/smtp/',
    docsLabel: 'Nodemailer: SMTP transport',
  },
  {
    id: 'ats',
    group: 'ats',
    title: 'ATS (generic REST)',
    vendorAccount: 'An ATS that exposes a REST API and issues API keys (Greenhouse Harvest is the named example).',
    steps: [
      'Create an API key in your ATS with read access to jobs/requisitions and write access to candidate assessments.',
      'Set ATS_BASE_URL to the API root. The connector calls <base>/requisitions/<id> and <base>/candidates/<id>/assessments with a Bearer token.',
      'Add the variables to server/.env and restart the server.',
    ],
    envVars: [
      { name: 'ATS_PROVIDER', placeholder: 'generic', note: 'or greenhouse' },
      { name: 'ATS_BASE_URL', placeholder: '<ATS API base URL>' },
      { name: 'ATS_API_KEY', placeholder: '<ATS API key>', note: 'secret — keep it only in server/.env' },
    ],
    permissions: ['Read requisitions/jobs', 'Write candidate assessments'],
    callbacks: [],
    callbackNote: 'None needed.',
    docsUrl: 'https://developers.greenhouse.io/harvest.html',
    docsLabel: 'Greenhouse Harvest API',
  },
];

export function guideFor(id: string): ConnectorGuide | undefined {
  return CONNECTOR_GUIDES.find((guide) => guide.id === id);
}

export function callbackUrlsFor(guide: ConnectorGuide, publicUrl: string): { label: string; url: string }[] {
  const base = publicUrl.replace(/\/+$/, '');
  return guide.callbacks.map((c) => ({ label: c.label, url: `${base}${c.path}` }));
}

export function envSnippet(guide: ConnectorGuide): string {
  return guide.envVars.map((v) => `${v.name}=${v.placeholder}`).join('\n');
}

export function statusLabel(configured: boolean): 'Configured' | 'Not configured' {
  return configured ? 'Configured' : 'Not configured';
}
