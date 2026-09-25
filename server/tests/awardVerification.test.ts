import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe, DEMO_RESUME } from '../src/seed/demoData.js';
import { _enableRateLimitsInTests, _resetRateLimits } from '../src/middleware/rateLimit.js';
import { eraseCandidate } from '../src/services/dataRights.js';

/**
 * The public verification page — `questor.app/v/<token>` — and the download
 * behind it.
 *
 * This is the only Questor address a candidate reaches without being invited
 * to anything, and the only one an employer follows. It is unauthenticated and
 * it prints a named person's record, so most of what is pinned here is about
 * what it does NOT say: nothing about the organisation, nothing about the
 * assessment, and nothing that tells one bad token from another.
 *
 * Every award in this file is struck by walking a pipeline through the API,
 * the way HR walks it. Four defects shipped green this week because a test
 * built its own row, and one of them was this feature: the certificate printed
 * a verification URL that nothing served, and no suite noticed because no
 * suite had ever followed one. So the token these cases use is read back off
 * the struck row, which is the test's stand-in for reading it off the paper.
 */

const app = createApp();

async function seeded() {
  await wipe();
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  return { ...ids, auth: `Bearer ${login.body.token as string}` };
}

type Seeded = Awaited<ReturnType<typeof seeded>>;

const STAGES = ['participation', 'bronze', 'silver', 'gold', 'diamond'];

/** A pipeline walked to `stage` with the Advance button, as HR walks it. */
async function pipelineAt(ids: Seeded, stage: string): Promise<string> {
  const created = await request(app).post('/api/pipelines').set('Authorization', ids.auth).send({ candidateId: ids.candidateId });
  const id = created.body.pipeline.id as string;
  for (const key of STAGES.slice(1, STAGES.indexOf(stage) + 1)) {
    await request(app).post(`/api/pipelines/${id}/advance`).set('Authorization', ids.auth).send({ toStageKey: key });
  }
  return id;
}

/**
 * A refusal, minus the request id every error carries.
 *
 * The id is what a person quotes to support and is different on every
 * response, so comparing whole bodies would compare the ids. What has to be
 * identical is everything else: the status, the sentence and the code.
 */
function refusal(res: { status: number; body: Record<string, unknown> }) {
  const { requestId: _ignored, ...rest } = res.body;
  return { status: res.status, ...rest };
}

const advance = (ids: Seeded, pipelineId: string, toStageKey: string) =>
  request(app).post(`/api/pipelines/${pipelineId}/advance`).set('Authorization', ids.auth).send({ toStageKey });

/** The token printed on the certificate for a tier this candidate has earned. */
async function verifyTokenFor(candidateId: string, tier: string): Promise<string> {
  const award = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId, tier }, select: { verifyToken: true } });
  return award.verifyToken;
}

/** A real Silver, struck by the move out of Silver into Gold. */
async function struckSilver(): Promise<{ ids: Seeded; token: string }> {
  const ids = await seeded();
  const pipelineId = await pipelineAt(ids, 'silver');
  await advance(ids, pipelineId, 'gold');
  return { ids, token: await verifyTokenFor(ids.candidateId, 'silver') };
}

beforeEach(async () => {
  await wipe();
  _resetRateLimits();
});

afterEach(() => {
  _enableRateLimitsInTests(false);
  _resetRateLimits();
});

describe('what the page shows', () => {
  it('names the person the certificate is about', async () => {
    const { token } = await struckSilver();

    const res = await request(app).get(`/api/v/${token}`);

    expect(res.body.candidateName).toBe('Priya Sharma');
  });

  it('states the tier, the role and the date it was issued', async () => {
    const { token } = await struckSilver();

    const res = await request(app).get(`/api/v/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.tier).toBe('silver');
    expect(res.body.roleTitle).toEqual(expect.any(String));
    expect(res.body.roleTitle.length).toBeGreaterThan(0);
    expect(Date.parse(res.body.issuedAt as string)).not.toBeNaN();
    expect(res.body.issuedOn).toEqual(expect.any(String));
  });

  /**
   * The page has to read as the document reads. An employer holding the paper
   * is comparing the two, and a page that paraphrases the certificate in its
   * own words is a page that makes a genuine certificate look wrong.
   */
  it('makes the claim in the certificate’s words, not its own', async () => {
    const { token } = await struckSilver();

    const res = await request(app).get(`/api/v/${token}`);

    expect(res.body.claim).toMatchObject({ lead: 'Completed Questor’s ', tier: 'Silver', middle: ' assessment for ' });
    expect(res.body.claim.role).toBe(res.body.roleTitle);
    expect(res.body.footnote).toBe('* Evidence of process, not a recommendation.');
  });

  /**
   * The owner was offered the evidence rows and chose against them. Everything
   * else on this list is worse: the organisation's name would make the page
   * read as the employer's endorsement, and the assessment detail is the
   * hiring team's.
   *
   * Pinned as the WHOLE set of keys rather than as a list of absences, because
   * a field added to the award model later is let out by default and only a
   * closed set notices.
   */
  it('says nothing else about the candidate, the organisation or the assessment', async () => {
    const { token } = await struckSilver();

    const res = await request(app).get(`/api/v/${token}`);

    expect(Object.keys(res.body).sort()).toEqual(
      ['candidateName', 'claim', 'footnote', 'issuedAt', 'issuedOn', 'roleTitle', 'tier'],
    );
  });

  /** The token is the credential. Echoing it back is how one ends up in a log. */
  it('does not echo the token back', async () => {
    const { token } = await struckSilver();

    const res = await request(app).get(`/api/v/${token}`);

    expect(JSON.stringify(res.body)).not.toContain(token);
  });
});

describe('what it refuses, and how it refuses', () => {
  /**
   * The three ways a token can fail to resolve — nonsense, unused, and a
   * record that has been erased — must be one answer. Anything that tells them
   * apart says whether a candidate was ever here.
   */
  it('answers a token that is not a token exactly as it answers one that was never minted', async () => {
    const nonsense = await request(app).get('/api/v/not-a-real-token');
    const unminted = await request(app).get(`/api/v/${'a'.repeat(43)}`);

    expect(nonsense.status).toBe(404);
    expect(refusal(nonsense)).toEqual(refusal(unminted));
  });

  /**
   * A candidate who has been erased has had their awards deleted outright, so
   * the token stops resolving. The page must not hint that it once did — "this
   * record has been withdrawn" tells an employer that the person was here.
   */
  it('answers an erased candidate’s token exactly as it answers an unknown one', async () => {
    const { ids, token } = await struckSilver();
    const unknown = await request(app).get(`/api/v/${'a'.repeat(43)}`);

    await eraseCandidate({ tenantId: ids.tenantId, candidateId: ids.candidateId, actorId: ids.userId, reason: 'A right to erasure request.' });
    const erased = await request(app).get(`/api/v/${token}`);

    expect(erased.status).toBe(404);
    expect(refusal(erased)).toEqual(refusal(unknown));
  });

  /**
   * Diamond carries no certificate, so no Diamond token is ever printed and
   * there is no document for this page to verify. `hasCertificate` is the one
   * gate for both the page and the download, so the two cannot disagree about
   * which tiers are public.
   */
  it('answers a Diamond token exactly as it answers an unknown one', async () => {
    const ids = await seeded();
    const pipelineId = await pipelineAt(ids, 'gold');
    await advance(ids, pipelineId, 'diamond');
    const token = await verifyTokenFor(ids.candidateId, 'diamond');
    const unknown = await request(app).get(`/api/v/${'a'.repeat(43)}`);

    const res = await request(app).get(`/api/v/${token}`);

    expect(res.status).toBe(404);
    expect(refusal(res)).toEqual(refusal(unknown));
  });

  /**
   * A version-1 record has not been brought up to date by the sweep, and this
   * page must not reconstruct what it is missing — the export route refuses
   * one for the same reason. 503 rather than 404 does tell the caller a record
   * exists, and that is correct here: they are holding its token, which is 256
   * bits, so they already knew. Telling a candidate their real certificate is
   * unknown to us would be the worse answer.
   */
  it('asks the reader to come back when the record has not been migrated yet', async () => {
    const { ids, token } = await struckSilver();
    const award = await prisma.candidateAward.findFirstOrThrow({ where: { candidateId: ids.candidateId, tier: 'silver' } });
    const current = JSON.parse(award.evidenceJson) as { rows: unknown[] };
    await prisma.candidateAward.update({
      where: { id: award.id },
      data: { evidenceJson: JSON.stringify({ version: 1, rows: current.rows }) },
    });

    const res = await request(app).get(`/api/v/${token}`);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('award_evidence_not_ready');
  });
});

describe('the download, with no account and no login', () => {
  it('serves the certificate to whoever holds the token', async () => {
    const { token } = await struckSilver();

    const res = await request(app).get(`/api/v/${token}/certificate.pdf`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect((res.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('offers it as a file rather than rendering it in the page', async () => {
    const { token } = await struckSilver();

    const res = await request(app).get(`/api/v/${token}/certificate.pdf`);

    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="questor-silver-/);
  });

  it('refuses an unknown token with the same answer the page gives', async () => {
    const page = await request(app).get(`/api/v/${'a'.repeat(43)}`);

    const res = await request(app).get(`/api/v/${'a'.repeat(43)}/certificate.pdf`);

    expect(refusal(res)).toEqual(refusal(page));
  });
});

describe('a page with a person’s name on it', () => {
  it('tells crawlers not to index either answer', async () => {
    const { token } = await struckSilver();

    const page = await request(app).get(`/api/v/${token}`);
    const pdf = await request(app).get(`/api/v/${token}/certificate.pdf`);

    expect(page.headers['x-robots-tag']).toContain('noindex');
    expect(pdf.headers['x-robots-tag']).toContain('noindex');
  });

  /**
   * A bearer URL whose body names a person must not settle in a shared cache —
   * a proxy, a corporate gateway, the browser's own disk — where the next
   * person on the machine finds it.
   */
  it('lets nothing cache either answer', async () => {
    const { token } = await struckSilver();

    const page = await request(app).get(`/api/v/${token}`);
    const pdf = await request(app).get(`/api/v/${token}/certificate.pdf`);

    expect(page.headers['cache-control']).toContain('no-store');
    expect(pdf.headers['cache-control']).toContain('no-store');
  });
});

describe('rate limiting', () => {
  /**
   * Unauthenticated and backed by a database query, so without a ceiling this
   * one address is a way to make the server unavailable to everyone else. The
   * bucket is per address and not per token: a per-token bucket hands every
   * guess in a scanning run its own fresh allowance, which is not a limit.
   */
  it('stops one address scanning tokens without end', async () => {
    _enableRateLimitsInTests();

    let refused = 0;
    for (let attempt = 0; attempt < 120; attempt++) {
      const res = await request(app).get(`/api/v/${'a'.repeat(43)}`);
      if (res.status === 429) refused += 1;
    }

    expect(refused).toBeGreaterThan(0);
  });

  /**
   * Tighter than the page it sits behind: this one lays out a page of vector
   * text and strikes a seal into it on the event loop, and nobody downloading
   * their own certificate needs more than a handful.
   */
  it('holds the render to a tighter ceiling than the page', async () => {
    const { token } = await struckSilver();
    _enableRateLimitsInTests();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      statuses.push((await request(app).get(`/api/v/${token}/certificate.pdf`)).status);
    }

    expect(statuses).toContain(429);
  });
});
