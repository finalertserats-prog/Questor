import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { prisma } from '../src/db.js';
import { createDemoData, wipe, DEMO_RESUME } from '../src/seed/demoData.js';

/**
 * A render that can be made to fail on demand.
 *
 * The real renderer otherwise, so every case but one exercises the document
 * the product actually produces. The flag exists because the ordering being
 * pinned below — render, THEN claim the row — is invisible to any test that
 * fails earlier than the render: feeding the route a corrupt evidence record
 * throws in `certificateEvidence`, which is before the claim whichever order
 * the two are in, so the case passes on code that has the order backwards.
 */
const render = vi.hoisted(() => ({ fail: false }));

vi.mock('../src/services/certificatePdf.js', async (orig) => {
  const actual = await orig<typeof import('../src/services/certificatePdf.js')>();
  return {
    ...actual,
    certificatePdf: (input: Parameters<typeof actual.certificatePdf>[0]) => (
      render.fail ? Promise.reject(new Error('pdfkit fell over')) : actual.certificatePdf(input)
    ),
  };
});

const { createApp } = await import('../src/app.js');
const { getEmail } = await import('../src/providers/email/index.js');
type EmailMessage = import('../src/providers/email/index.js').EmailMessage;

/**
 * The certificate the send email carries.
 *
 * The letter said the record was "available to view and download here" and
 * carried nothing — no attachment, and, until this lane, a link to a page that
 * did not exist either. A candidate who received one had been told twice about
 * a document they could not reach.
 *
 * The award here is struck by walking a pipeline through the API, never
 * hand-built, because the last four defects on this feature all survived a
 * green suite by feeding the reader input the test author had written.
 */

const app = createApp();
const CANDIDATE_NAME = 'Mei Lin Chua';

async function seeded() {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { ...ids, auth: `Bearer ${login.body.token as string}` };
}

type Seeded = Awaited<ReturnType<typeof seeded>>;

/** A candidate carried to Diamond, which strikes Bronze, Silver, Gold and Diamond on the way. */
async function walkedToDiamond(ids: Seeded): Promise<string> {
  const created = await request(app).post('/api/candidates').set('Authorization', ids.auth)
    .send({ fullName: CANDIDATE_NAME, email: 'mei.lin.chua@example.com', roleId: ids.roleId });
  const candidateId = created.body.candidate.id as string;
  await request(app).post(`/api/candidates/${candidateId}/resume`).set('Authorization', ids.auth).field('text', DEMO_RESUME);
  const listed = await request(app).get(`/api/pipelines?candidateId=${candidateId}`).set('Authorization', ids.auth);
  const pipelineId = listed.body.pipelines[0].id as string;
  for (const toStageKey of ['silver', 'gold', 'diamond']) {
    await request(app).post(`/api/pipelines/${pipelineId}/advance`).set('Authorization', ids.auth).send({ toStageKey });
  }
  return candidateId;
}

let ids: Seeded;
let candidateId: string;
let sent: EmailMessage[];
let restore: (() => void) | null = null;

/** Everything the send hands the provider, without changing what the provider then does with it. */
function captureMail(): void {
  const provider = getEmail();
  const original = provider.send.bind(provider);
  provider.send = async (message, opts) => { sent.push(message); return original(message, opts); };
  restore = () => { provider.send = original; };
}

beforeEach(async () => {
  ids = await seeded();
  candidateId = await walkedToDiamond(ids);
  sent = [];
  render.fail = false;
  captureMail();
});

afterEach(() => {
  restore?.();
  restore = null;
});

const send = (tier: string) =>
  request(app).post(`/api/candidates/${candidateId}/awards/${tier}/certificate/send`).set('Authorization', ids.auth);

describe('the certificate travels with the letter that announces it', () => {
  it('attaches the certificate to the email', async () => {
    await send('silver');

    expect(sent[0]?.attachments).toHaveLength(1);
  });

  it('attaches a real PDF, not a description of one', async () => {
    await send('silver');

    const file = sent[0].attachments![0];
    expect(file.contentType).toBe('application/pdf');
    expect(Buffer.from(file.content, 'base64').subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  /**
   * The line above decodes the content as base64 because this test knows it
   * is base64. The PROVIDER only knows because the attachment says so, and
   * every provider needs telling: a PDF cannot cross to the forked SMTP
   * sender as bytes, because that child is handed its message with
   * `serialization: 'json'`.
   *
   * Without this assertion the case above passes whether or not anything was
   * ever told, and nodemailer would put the base64 text into the body of an
   * `application/pdf` part. The send succeeds, the provider reports success,
   * and the candidate opens a file that will not open — on the one send this
   * certificate gets. `emailAttachmentEncoding.test.ts` pins the far end of
   * the same path.
   */
  it('says the content is base64, because no provider can tell by looking', async () => {
    await send('silver');

    expect(sent[0].attachments![0].encoding).toBe('base64');
  });

  /**
   * The reference and the tier, never the candidate's name. A filename travels
   * into download folders, mail clients and shared drives that an erasure
   * request can never reach — which is why `certificateFilename` leaves the
   * name out, and why this holds it to that.
   */
  it('names the file by its reference and never by the person', async () => {
    await send('silver');

    const award = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId, tier: 'silver' } });
    expect(sent[0].attachments![0].filename).toBe(`questor-silver-${award.reference}.pdf`);
    expect(sent[0].attachments![0].filename).not.toContain('Mei');
  });

  /**
   * The attachment is a second copy, never the only one. Some mail systems
   * strip attachments and most people never open them, so the letter still
   * has to carry the link that leads to the same document.
   */
  it('still gives the candidate the verification link to follow', async () => {
    await send('silver');

    const award = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId, tier: 'silver' } });
    expect(sent[0].text).toContain(`/v/${award.verifyToken}`);
  });

  /**
   * The ordering, exercised rather than described.
   *
   * `sentToCandidateAt` is what makes the send one-shot: a certificate marked
   * sent refuses every later attempt. So a render that throws AFTER the claim
   * burns the only send this award will ever get, and the candidate — who was
   * told nothing — never receives it.
   *
   * The failure has to come from the RENDER for this to mean anything. An
   * earlier draft corrupted the evidence record instead, which throws in
   * `certificateEvidence` — before the claim whichever order the render and
   * the claim are in. Moving the render below the claim left that version
   * green, so the comment above it was documenting a property nothing held.
   */
  it('does not burn the one send when the document cannot be rendered', async () => {
    render.fail = true;
    const award = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId, tier: 'gold' } });

    const res = await send('gold');

    expect(res.status).toBe(500);
    const after = await prisma.candidateAward.findFirstOrThrow({ where: { id: award.id } });
    expect(after.sentToCandidateAt).toBeNull();
  });

  /** And the send still works afterwards, which is the point of not claiming it. */
  it('lets the certificate be sent once the renderer is working again', async () => {
    render.fail = true;
    await send('gold');

    render.fail = false;
    const res = await send('gold');

    expect(res.status).toBe(200);
    expect(sent.at(-1)?.attachments).toHaveLength(1);
  });

  /**
   * A record that cannot be read at all is refused too, and also leaves the
   * award sendable — this one fails before the render, which is why it cannot
   * stand in for the case above.
   */
  it('does not mark a certificate sent when its stored record cannot be read', async () => {
    const award = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId, tier: 'gold' } });
    await prisma.candidateAward.update({ where: { id: award.id }, data: { evidenceJson: '{"version":2,"rows":[]}' } });

    const res = await send('gold');

    expect(res.status).toBe(500);
    const after = await prisma.candidateAward.findFirstOrThrow({ where: { id: award.id } });
    expect(after.sentToCandidateAt).toBeNull();
  });
});
