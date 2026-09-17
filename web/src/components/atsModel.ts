/**
 * The rules behind the organisation's ATS connection, the ATS import on New
 * Role, and a candidate's ATS link. Mirrors server/src/services/atsConnections.ts
 * and atsRecords.ts.
 *
 * The API key is write-only: the server never sends it, so the form never
 * shows it, and a blank key field means "keep the one you have".
 */

export type AtsProvider = 'generic' | 'greenhouse';

export const ATS_PROVIDER_LABELS: Readonly<Record<AtsProvider, string>> = {
  generic: 'Generic REST',
  greenhouse: 'Greenhouse',
};

/** GET /api/admin/ats → connection */
export interface AtsConnectionView {
  readonly connected: boolean;
  readonly provider: string;
  readonly baseUrl: string;
  readonly accountId: string;
  readonly hasApiKey: boolean;
  /** tenant: set up here. env: the server's own configuration, bound to this organisation. */
  readonly source: string;
  readonly status: string;
  readonly lastTestedAt: string | null;
  readonly updatedAt: string;
}

export interface AtsForm {
  readonly provider: AtsProvider;
  readonly baseUrl: string;
  readonly accountId: string;
  readonly apiKey: string;
}

export interface AtsSavePayload {
  provider: AtsProvider;
  baseUrl: string;
  accountId: string;
  apiKey?: string;
}

const isProvider = (v: string): v is AtsProvider => v === 'generic' || v === 'greenhouse';

export function formFromConnection(conn: AtsConnectionView | null): AtsForm {
  if (!conn) return { provider: 'generic', baseUrl: '', accountId: '', apiKey: '' };
  return { provider: isProvider(conn.provider) ? conn.provider : 'generic', baseUrl: conn.baseUrl, accountId: conn.accountId, apiKey: '' };
}

export function savePayload(form: AtsForm): AtsSavePayload {
  const apiKey = form.apiKey.trim();
  return {
    provider: form.provider,
    baseUrl: form.baseUrl.trim(),
    accountId: form.accountId.trim(),
    ...(apiKey ? { apiKey } : {}),
  };
}

/** Why the form cannot be saved yet, or null. The server checks all of this again. */
export function atsFormProblem(form: AtsForm, conn: AtsConnectionView | null): string | null {
  const baseUrl = form.baseUrl.trim();
  if (!baseUrl) return 'Enter the address of your ATS API.';
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return 'Enter the full address, starting with https://.';
  }
  if (url.protocol !== 'https:') return 'The address must start with https://.';
  // A server-configured key is not carried over when the connection is taken
  // over here, so it has to be entered.
  const keyStored = conn !== null && conn.hasApiKey && conn.source !== 'env';
  if (!form.apiKey.trim() && !keyStored) return 'Enter the API key your ATS issued for Questor.';
  return null;
}

export type StatusKind = 'green' | 'amber' | 'red' | 'gray';

export function connectionStatus(conn: AtsConnectionView | null): { label: string; kind: StatusKind } {
  if (!conn) return { label: 'Not connected', kind: 'gray' };
  if (conn.status === 'disconnected') return { label: 'Disconnected', kind: 'gray' };
  if (!conn.connected) return { label: 'Needs attention', kind: 'red' };
  if (conn.status === 'failed') return { label: 'Last test failed', kind: 'red' };
  if (conn.status === 'ok') return { label: 'Connected', kind: 'green' };
  return { label: 'Connected, not yet tested', kind: 'amber' };
}

export interface ApiRefusal {
  readonly status: number;
  readonly code?: string;
  readonly message: string;
}

/**
 * What a refusal tells the person who hit it. An admin can fix the connection
 * or the link themselves, so they are told where; anyone else is told who can.
 */
export function atsErrorMessage(err: ApiRefusal, canManage: boolean): string {
  switch (err.code) {
    case 'ATS_NOT_CONNECTED':
      return canManage
        ? 'Your organisation has not connected an ATS yet. Connect one in Settings, then try again.'
        : 'Your organisation has not connected an ATS yet. Ask an administrator to connect one in Settings.';
    case 'ATS_KEY_UNREADABLE':
      return canManage
        ? 'The saved ATS key can no longer be used. Enter it again in Settings, then try again.'
        : 'The ATS connection needs attention. Ask an administrator to re-enter the key in Settings.';
    case 'ATS_LINK_MISSING':
      return canManage
        ? 'This candidate is not linked to your ATS yet. Link them on the candidate page, then export again.'
        : 'This candidate is not linked to your ATS yet. Ask an administrator to link them on the candidate page.';
    default:
      return err.message;
  }
}

/** Mirrors ATS_EXTERNAL_ID on the server. */
export const ATS_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isAtsId(value: string): boolean {
  return ATS_ID_PATTERN.test(value);
}
