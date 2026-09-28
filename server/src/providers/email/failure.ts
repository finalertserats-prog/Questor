import { SendTimeoutError } from './timing.js';

/**
 * Why a send failed, and — the part that matters — whether anything reached
 * the recipient.
 *
 * Until 2026-09-23 every caller collapsed every throw into "nothing was sent".
 * For the identity code that meant a *timeout* deleted a challenge whose code
 * may already have been in the candidate's inbox: they then entered a valid
 * code and were told it had expired
 * (docs/qa/resilience-2026-09-23.md, R6).
 *
 * So the two questions are kept apart:
 *
 *   certainty  'not_delivered' — the message was refused or never left us.
 *                                A caller may safely undo what it staged.
 *              'unknown'       — we stopped waiting, or the connection died
 *                                mid-conversation. The message MAY have gone.
 *                                A caller must not destroy anything the
 *                                recipient might be holding.
 *
 *   reason     what to tell the person, and what to show the team.
 *
 * When in doubt the answer is 'unknown'. Wrongly claiming delivery costs a
 * duplicate email; wrongly claiming non-delivery costs someone their interview.
 */

export type SendCertainty = 'not_delivered' | 'unknown';

export type SendFailureReason =
  /** The provider refused it outright (SMTP 5xx, an API 4xx). Retrying changes nothing. */
  | 'refused'
  /** The provider declined for now (SMTP 4xx). Nothing was delivered; later may work. */
  | 'deferred'
  /** We never reached the provider: DNS, connection, credentials. */
  | 'unreachable'
  /** We stopped waiting. The outcome is not ours to know. */
  | 'timeout'
  /** Something else went wrong mid-send. Treated as unknown on purpose. */
  | 'unknown';

export interface EmailSendFailure {
  readonly certainty: SendCertainty;
  readonly reason: SendFailureReason;
  /** Short, safe, quotable in an audit row. Never a credential — the providers never put one in a message. */
  readonly detail: string;
}

const DETAIL_MAX = 200;

/** nodemailer hangs the SMTP reply code off the error; the child process forwards it. */
function responseCodeOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { responseCode?: unknown }).responseCode;
  return typeof code === 'number' && Number.isFinite(code) ? code : null;
}

function transportCodeOf(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code.toUpperCase() : '';
}

/**
 * Never reached the relay at all: no message can have been delivered, whatever
 * else is true. ESOCKET and ETIMEDOUT are deliberately NOT here — a socket
 * that died can have died after the DATA terminator went out.
 */
const NEVER_CONNECTED = new Set(['ECONNECTION', 'ECONNREFUSED', 'EDNS', 'EAUTH', 'EHOSTUNREACH', 'ENOTFOUND']);

function detailOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, ' ').trim().slice(0, DETAIL_MAX);
}

export function classifyEmailFailure(err: unknown): EmailSendFailure {
  const detail = detailOf(err);
  if (err instanceof SendTimeoutError) return { certainty: 'unknown', reason: 'timeout', detail };

  const responseCode = responseCodeOf(err);
  if (responseCode !== null) {
    // A reply code means the relay answered a command. Either way it did not
    // take the message: nothing was delivered.
    if (responseCode >= 500) return { certainty: 'not_delivered', reason: 'refused', detail };
    if (responseCode >= 400) return { certainty: 'not_delivered', reason: 'deferred', detail };
  }

  const transport = transportCodeOf(err);
  if (NEVER_CONNECTED.has(transport)) return { certainty: 'not_delivered', reason: 'unreachable', detail };

  // The SendGrid adapter throws `SendGrid error <status>`: a 4xx is the API
  // rejecting the request, a 5xx is the API failing to say what it did.
  const sendgrid = /^SendGrid error (\d{3})/.exec(detail);
  if (sendgrid) {
    const status = Number(sendgrid[1]);
    if (status === 401 || status === 403) return { certainty: 'not_delivered', reason: 'unreachable', detail };
    if (status >= 400 && status < 500) return { certainty: 'not_delivered', reason: 'refused', detail };
    return { certainty: 'unknown', reason: 'unknown', detail };
  }

  // A fetch the caller aborted: we stopped waiting, so the outcome is unknown.
  if (transport === 'ABORT_ERR' || (err instanceof Error && err.name === 'AbortError') || (err instanceof Error && err.name === 'TimeoutError')) {
    return { certainty: 'unknown', reason: 'timeout', detail };
  }

  return { certainty: 'unknown', reason: 'unknown', detail };
}
