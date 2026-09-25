import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How an attachment's bytes reach the provider — the one property whose
 * failure is silent and total.
 *
 * Questor sends two kinds of attachment, and they are opposites. A calendar
 * invitation is UTF-8 text and goes to nodemailer as itself. A certificate is
 * a PDF, and a PDF cannot go anywhere as itself: the SMTP send runs in a
 * forked child handed its message with `serialization: 'json'`, so a Buffer
 * arrives as `{ type: 'Buffer', data: [...] }`. It crosses as base64 and says
 * so, and nodemailer decodes it on that say-so.
 *
 * Drop `encoding` anywhere on that path — a bad merge, a mapping rewritten
 * toward whichever branch had no `encoding` field — and nodemailer receives
 * the base64 TEXT as the literal body of an `application/pdf` part. The send
 * succeeds. The provider reports success. The candidate opens an unopenable
 * file, and the send is one-shot, so there is no second one. Nothing else in
 * the suite would notice: a test that decodes `content` as base64 itself
 * passes whether or not the provider was ever told to.
 *
 * So both halves are pinned here, and the second half is not decoration: the
 * calendar invitation must NOT acquire an encoding it never had. A change that
 * base64-encodes everything on this path would be tidier and would alter a
 * shipping feature's Content-Transfer-Encoding.
 */

vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>();
  return {
    config: {
      ...actual.config,
      email: {
        ...actual.config.email,
        provider: 'smtp', smtpHost: 'smtp.questor.test', smtpPort: 587,
        smtpUser: 'user', smtpPass: 'pass', from: 'hiring@questor.test',
      },
    },
  };
});

const captured: { mail: Record<string, unknown> | null } = vi.hoisted(() => ({ mail: null }));

vi.mock('../src/providers/email/smtpChild.js', () => ({
  sendViaSmtpChild: (send: { mail: Record<string, unknown> }) => {
    captured.mail = send.mail;
    return Promise.resolve({ messageId: 'captured' });
  },
}));

const { getEmail, _resetEmail } = await import('../src/providers/email/index.js');

interface SentAttachment {
  readonly filename: string;
  readonly content: string;
  readonly contentType: string;
  readonly encoding?: string;
}

const MESSAGE = { to: 'candidate@example.test', subject: 'Hello', text: 'Hi', html: '<p>Hi</p>' };

/** A certificate, as `candidateAwards.ts` builds one: real PDF bytes, base64. */
const PDF_BYTES = Buffer.from('%PDF-1.7\n1 0 obj\n<< >>\n', 'latin1');
const CERTIFICATE = {
  filename: 'questor-silver-QS-SLV-8F2K-4471.pdf',
  content: PDF_BYTES.toString('base64'),
  contentType: 'application/pdf',
  encoding: 'base64' as const,
};

/** A calendar invitation, as the scheduling lane builds one: text, no encoding. */
const INVITATION = {
  filename: 'interview.ics',
  content: 'BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n',
  contentType: 'text/calendar; charset=utf-8; method=REQUEST',
};

async function sendWith(attachment: SentAttachment): Promise<SentAttachment> {
  await getEmail().send({ ...MESSAGE, attachments: [attachment] });
  return (captured.mail?.attachments as SentAttachment[])[0];
}

beforeEach(() => {
  _resetEmail();
  captured.mail = null;
});

afterEach(() => {
  _resetEmail();
});

describe('a binary attachment on its way to the SMTP child', () => {
  it('tells nodemailer the content is base64, so it is decoded rather than typed out', async () => {
    const sent = await sendWith(CERTIFICATE);

    expect(sent.encoding).toBe('base64');
  });

  it('hands over the encoded string unchanged, so it survives the JSON hop to the child', async () => {
    const sent = await sendWith(CERTIFICATE);

    expect(sent.content).toBe(CERTIFICATE.content);
  });

  /**
   * The round trip, which is the whole point: what nodemailer will decode has
   * to be the bytes the renderer produced. A test that only checks the string
   * is base64-shaped would pass on a truncated or re-encoded one.
   */
  it('carries the exact bytes of the document', async () => {
    const sent = await sendWith(CERTIFICATE);

    expect(Buffer.from(sent.content, sent.encoding as BufferEncoding).equals(PDF_BYTES)).toBe(true);
  });

  it('keeps the type that makes a mail client offer it as a PDF', async () => {
    const sent = await sendWith(CERTIFICATE);

    expect(sent.contentType).toBe('application/pdf');
  });
});

describe('a text attachment on the same path', () => {
  /**
   * The other half, and not decoration. The calendar invitation has shipped
   * for weeks as a raw UTF-8 string under whatever Content-Transfer-Encoding
   * nodemailer chose for it. Encoding everything here would be tidier and
   * would change how a working feature goes out.
   */
  it('gains no encoding it did not ask for', async () => {
    const sent = await sendWith(INVITATION);

    expect(sent.encoding).toBeUndefined();
  });

  it('goes out as the text it was written as', async () => {
    const sent = await sendWith(INVITATION);

    expect(sent.content).toBe(INVITATION.content);
  });

  /** An iTIP part whose `method=` is stripped is an invitation no client will act on. */
  it('keeps the MIME parameters its content type carries', async () => {
    const sent = await sendWith(INVITATION);

    expect(sent.contentType).toBe('text/calendar; charset=utf-8; method=REQUEST');
  });
});
