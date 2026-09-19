import type { AtsConnection } from '@prisma/client';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { HttpError } from '../middleware/index.js';
import {
  AtsRequestError,
  createAtsClient,
  isAtsProviderName,
  type AtsClient,
  type AtsCredentials,
  type AtsProviderName,
  type AtsTestResult,
} from '../providers/ats/index.js';
import { logAudit } from './audit.js';
import { openSecret, sealSecret } from './secretSeal.js';
import { webhookHostResolvesPrivate, webhookUrlProblem } from './webhookUrl.js';

/**
 * Each organisation's own ATS connection.
 *
 * Every ATS call starts here, from the caller's tenant, so a tenant can only
 * ever reach the ATS it connected. The deployment's ATS_* variables survive
 * only as a connection bound to the one tenant named by ATS_TENANT_ID; its key
 * is read from the environment at call time and never copied into the
 * database.
 */

export const ATS_NOT_CONNECTED = 'ATS_NOT_CONNECTED';
export const ATS_KEY_UNREADABLE = 'ATS_KEY_UNREADABLE';

const NOT_CONNECTED_MESSAGE =
  'Your organisation has not connected an ATS yet. An administrator can connect one under Settings, ATS connection.';
const KEY_UNREADABLE_MESSAGE =
  'The saved ATS key can no longer be read, because the server\'s secret changed. An administrator needs to enter the key again under Settings, ATS connection.';
const BAD_URL_MESSAGE =
  'Enter the ATS API address as a full https:// URL on the public internet, with no credentials or query string in it.';

const KEY_REQUIRED_MESSAGE =
  'Enter the API key for this ATS. A saved key is kept only while the ATS, address and account stay the same.';

const isUniqueViolation =(err: unknown) => (err as { code?: string } | null)?.code === 'P2002';

/**
 * One ATS account, as a string. The same account must look the same however
 * it was typed, or the uniqueness that keeps it to one tenant is decorative.
 */
export function atsKeyOf(provider: AtsProviderName, baseUrl: string, accountId: string): string {
  const url = new URL(baseUrl);
  const root = `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  return [provider, root, accountId.trim().toLowerCase()].join('|');
}

/**
 * The server calls this address with the tenant's key attached, so it gets the
 * same outbound checks as a webhook: no loopback, no private network, and the
 * name is resolved as well as read.
 */
export async function atsBaseUrlProblem(raw: string): Promise<string | null> {
  if (webhookUrlProblem(raw, config.nodeEnv)) return BAD_URL_MESSAGE;
  const url = new URL(raw);
  if (url.search || url.hash) return BAD_URL_MESSAGE;
  if (config.nodeEnv !== 'test' && await webhookHostResolvesPrivate(url.hostname)) return BAD_URL_MESSAGE;
  return null;
}

function envProvider(): AtsProviderName {
  return isAtsProviderName(config.ats.provider) ? config.ats.provider : 'generic';
}

function envBoundTo(tenantId: string): boolean {
  return Boolean(config.ats.baseUrl && config.ats.tenantId && config.ats.tenantId === tenantId);
}

/** First use by the bound tenant turns the ATS_* variables into its connection row. */
async function bootstrapEnvConnection(tenantId: string): Promise<AtsConnection | null> {
  if (!envBoundTo(tenantId)) return null;
  const provider = envProvider();
  try {
    return await prisma.atsConnection.create({
      data: {
        tenantId, provider, baseUrl: config.ats.baseUrl, accountId: '',
        atsKey: atsKeyOf(provider, config.ats.baseUrl, ''), source: 'env',
      },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = await prisma.atsConnection.findUnique({ where: { tenantId } });
    // Otherwise the account is already another tenant's: the binding is wrong,
    // and refusing is the only safe answer.
    if (!raced) logger.error({ tenantId }, 'ATS_TENANT_ID names a tenant, but that ATS account is connected to another organisation');
    return raced;
  }
}

export async function findConnection(tenantId: string): Promise<AtsConnection | null> {
  const row = await prisma.atsConnection.findUnique({ where: { tenantId } });
  return row ?? bootstrapEnvConnection(tenantId);
}

type Credentials = { ok: true; creds: AtsCredentials } | { ok: false; code: string; message: string };

function credentialsOf(row: AtsConnection): Credentials {
  if (row.status === 'disconnected') return { ok: false, code: ATS_NOT_CONNECTED, message: NOT_CONNECTED_MESSAGE };
  const provider = isAtsProviderName(row.provider) ? row.provider : 'generic';
  if (row.source === 'env') {
    // The binding can be removed from the environment after the row exists;
    // then the connection is off, not silently still pointing somewhere.
    if (!envBoundTo(row.tenantId)) return { ok: false, code: ATS_NOT_CONNECTED, message: NOT_CONNECTED_MESSAGE };
    return { ok: true, creds: { provider, baseUrl: config.ats.baseUrl, accountId: row.accountId, apiKey: config.ats.apiKey } };
  }
  const apiKey = row.apiKeySealed ? openSecret('ats-credential', row.apiKeySealed) : '';
  if (apiKey === null) return { ok: false, code: ATS_KEY_UNREADABLE, message: KEY_UNREADABLE_MESSAGE };
  return { ok: true, creds: { provider, baseUrl: row.baseUrl, accountId: row.accountId, apiKey } };
}

export interface TenantAts {
  readonly connection: AtsConnection;
  readonly client: AtsClient;
}

/** The caller's own ATS, or a 409 that says what to do about it. */
export async function requireTenantAts(tenantId: string): Promise<TenantAts> {
  const connection = await findConnection(tenantId);
  if (!connection) throw new HttpError(409, NOT_CONNECTED_MESSAGE, ATS_NOT_CONNECTED);
  const creds = credentialsOf(connection);
  if (!creds.ok) throw new HttpError(409, creds.message, creds.code);
  // Checked again on every use, as webhook deliveries are: a name that
  // resolved publicly when it was saved can point inward later. The operator's
  // own env address is trusted configuration.
  if (connection.source !== 'env' && config.nodeEnv !== 'test' && await webhookHostResolvesPrivate(new URL(creds.creds.baseUrl).hostname)) {
    logger.warn({ tenantId }, 'ATS address now resolves to a private network; call refused');
    throw new HttpError(502, 'Your ATS address no longer points at the public internet, so Questor will not call it. An administrator should check it under Settings, ATS connection.');
  }
  return { connection, client: createAtsClient(creds.creds) };
}

/** Whether this tenant can use its ATS right now. */
export async function tenantAtsReady(tenantId: string): Promise<boolean> {
  const connection = await findConnection(tenantId);
  return connection ? credentialsOf(connection).ok : false;
}

/**
 * An ATS failure as something a person can act on. `what` names the thing that
 * was looked up, for the not-found case. Vendor bodies are never included.
 */
export function atsFailure(err: unknown, what: string): never {
  if (!(err instanceof AtsRequestError)) throw err;
  if (err.kind === 'not_found') throw new HttpError(422, `No ${what} with that id exists in your ATS.`);
  if (err.kind === 'rejected') {
    throw new HttpError(502, 'Your ATS rejected Questor\'s credentials. An administrator should check the key under Settings, ATS connection.');
  }
  throw new HttpError(502, 'Your ATS could not be reached just now. Try again shortly.');
}

export interface ConnectionView {
  readonly connected: boolean;
  readonly provider: string;
  readonly baseUrl: string;
  readonly accountId: string;
  readonly hasApiKey: boolean;
  readonly source: string;
  readonly status: string;
  readonly lastTestedAt: Date | null;
  readonly updatedAt: Date;
}

/** What the admin sees. The key never leaves the server; only whether one is set. */
export function shapeConnection(row: AtsConnection): ConnectionView {
  const env = row.source === 'env';
  return {
    connected: credentialsOf(row).ok,
    provider: row.provider,
    baseUrl: env ? config.ats.baseUrl : row.baseUrl,
    accountId: row.accountId,
    hasApiKey: env ? Boolean(config.ats.apiKey) : Boolean(row.apiKeySealed),
    source: row.source,
    status: row.status,
    lastTestedAt: row.lastTestedAt,
    updatedAt: row.updatedAt,
  };
}

export interface SaveConnectionInput {
  readonly tenantId: string;
  readonly actorId: string;
  readonly provider: AtsProviderName;
  readonly baseUrl: string;
  readonly accountId: string;
  /** Omitted or empty keeps the stored key. */
  readonly apiKey?: string;
  readonly requestId?: string;
}

export async function saveConnection(input: SaveConnectionInput): Promise<AtsConnection> {
  const problem = await atsBaseUrlProblem(input.baseUrl);
  if (problem) throw new HttpError(400, problem);
  const atsKey = atsKeyOf(input.provider, input.baseUrl, input.accountId);
  const claimed = await prisma.atsConnection.findUnique({ where: { atsKey }, select: { tenantId: true } });
  if (claimed && claimed.tenantId !== input.tenantId) throw alreadyClaimed();

  const existing = await prisma.atsConnection.findUnique({ where: { tenantId: input.tenantId } });
  // A saved key may only stay with the ATS account it was entered for. Kept
  // across a change of provider, address or account, a blank key field would
  // send the old key to whatever host the admin typed, which is the one thing
  // a write-only key must never allow. An env connection's key lives in the
  // environment and is never inherited either.
  const canKeepKey = Boolean(existing && existing.source === 'tenant' && existing.apiKeySealed && existing.atsKey === atsKey);
  if (!input.apiKey && !canKeepKey) throw new HttpError(400, KEY_REQUIRED_MESSAGE);
  const newKey = input.apiKey ? sealSecret('ats-credential', input.apiKey) : null;
  const fields = {
    provider: input.provider,
    baseUrl: input.baseUrl.replace(/\/+$/, ''),
    accountId: input.accountId.trim(),
    atsKey,
    source: 'tenant',
    status: 'untested',
    disconnectedAt: null,
    ...(newKey !== null ? { apiKeySealed: newKey } : {}),
  };

  let linksCleared = 0;
  let row: AtsConnection;
  try {
    row = await prisma.$transaction(async (tx) => {
      if (!existing) {
        return tx.atsConnection.create({ data: { ...fields, tenantId: input.tenantId, createdById: input.actorId } });
      }
      // A different ATS account means every stored candidate id now names
      // someone else, so those links go.
      if (existing.atsKey !== atsKey) {
        linksCleared = (await tx.candidateAtsLink.deleteMany({ where: { connectionId: existing.id } })).count;
      }
      return tx.atsConnection.update({ where: { id: existing.id }, data: fields });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw alreadyClaimed();
    throw err;
  }

  await logAudit({
    tenantId: input.tenantId, actorId: input.actorId, actorType: 'user',
    action: existing ? 'ats.connection.updated' : 'ats.connection.created',
    entityType: 'AtsConnection', entityId: row.id,
    // Never the key, and not the address either: which vendor, and what changed.
    after: { provider: row.provider, apiKeyChanged: newKey !== null, accountChanged: existing ? existing.atsKey !== atsKey : true, linksCleared },
    requestId: input.requestId,
  });
  return row;
}

function alreadyClaimed(): HttpError {
  return new HttpError(409, 'This ATS account is already connected to another organisation in Questor. Contact support if it should be yours.');
}

export async function disconnectConnection(o: { tenantId: string; actorId: string; requestId?: string }): Promise<AtsConnection> {
  const existing = await findConnection(o.tenantId);
  if (!existing) throw new HttpError(404, 'There is no ATS connection to disconnect.');
  // The row stays: it holds the account's claim and the candidate links, which
  // come back if the same account is connected again. The key does not stay.
  const row = await prisma.atsConnection.update({
    where: { id: existing.id },
    data: { status: 'disconnected', apiKeySealed: '', disconnectedAt: new Date() },
  });
  await logAudit({
    tenantId: o.tenantId, actorId: o.actorId, actorType: 'user', action: 'ats.connection.disconnected',
    entityType: 'AtsConnection', entityId: row.id, requestId: o.requestId,
  });
  return row;
}

/** A tenant admin's test of their own connection. */
export async function testTenantConnection(o: { tenantId: string; actorId: string; requestId?: string }): Promise<AtsTestResult> {
  const { connection, client } = await requireTenantAts(o.tenantId);
  const result = await client.testConnection();
  await prisma.atsConnection.update({
    where: { id: connection.id },
    data: { status: result.ok ? 'ok' : 'failed', lastTestedAt: new Date() },
  });
  await logAudit({
    tenantId: o.tenantId, actorId: o.actorId, actorType: 'user', action: 'ats.connection.tested',
    entityType: 'AtsConnection', entityId: connection.id,
    after: { outcome: result.ok ? 'ok' : 'failed' }, requestId: o.requestId,
  });
  return result;
}
