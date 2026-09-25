import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe, DEMO_RESUME } from '../src/seed/demoData.js';
import { getEmail, type EmailMessage } from '../src/providers/email/index.js';

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
   * Rendered before the row is claimed, so a render that fails leaves the
   * certificate sendable. Marking it sent and then failing to build the
   * document would refuse every retry for ever, and the candidate would never
   * learn that anything had been meant for them.
   */
  it('does not mark a certificate sent when its document cannot be built', async () => {
    const award = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId, tier: 'gold' } });
    await prisma.candidateAward.update({ where: { id: award.id }, data: { evidenceJson: '{"version":2,"rows":[]}' } });

    const res = await send('gold');

    expect(res.status).toBe(500);
    const after = await prisma.candidateAward.findFirstOrThrow({ where: { id: award.id } });
    expect(after.sentToCandidateAt).toBeNull();
  });
});
