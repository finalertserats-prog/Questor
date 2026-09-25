import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { _resetRateLimits } from '../src/middleware/rateLimit.js';
import { serialiseEvidence, type AwardFacts, type AwardTier } from '../src/domain/candidateAwards.js';

/**
 * Exporting a credential.
 *
 * The assertions here are about the bytes and about who can reach them, not
 * about our own helpers: that the response really is a PDF, that the text
 * inside it is real selectable text (pdf-parse reads it back), and that a
 * candidate belonging to another organisation is unreachable by every route on
 * this router. A screenshot, or a query missing its tenant filter, would pass
 * a status-code test and fail these.
 *
 * The stored evidence these awards carry is written by the award lane itself,
 * never typed out here. An earlier version of this file hand-built the JSON it
 * fed the renderer, and so it went on passing for months while every real
 * export answered 500: the reader had only ever been shown data the test
 * author wrote for it. The one place hand-built JSON survives is the last
 * describe, where a record the writer CANNOT produce is the subject.
 */

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const ROLE_TITLE = 'Senior Marketing Manager';

/**
 * The facts an award is struck from, as a rich journey leaves them: a CV read
 * against an approved scorecard, a completed AI interview, a subject-matter
 * expert's review, and two human rounds at Gold.
 */
const FACTS: AwardFacts = {
  awardedAt: new Date('2026-09-24T00:00:00.000Z'),
  candidateName: 'Priya Sharma',
  roleTitle: ROLE_TITLE,
  recordedByName: 'Rahul Menon',
  candidateCreatedAt: new Date('2026-09-20T09:00:00.000Z'),
  profile: { readAt: new Date('2026-09-21T09:00:00.000Z'), scorecardVersion: 4, competenciesEvidenced: 8, competenciesTotal: 10 },
  aiInterview: { completedAt: new Date('2026-09-22T09:00:00.000Z'), minutes: 24, competencies: 10, quotedEvidence: true },
  humanReview: { at: new Date('2026-09-23T09:00:00.000Z'), reviewerName: 'Aparna Rao' },
  humanRounds: [
    { completedAt: new Date('2026-09-22T09:00:00.000Z'), minutes: 48, interviewers: ['Aparna Rao'] },
    { completedAt: new Date('2026-09-23T09:00:00.000Z'), minutes: 40, interviewers: ['Devika Iyer'] },
  ],
  priorAwardAt: new Date('2026-09-21T09:00:00.000Z'),
  promotedTo: 'Gold',
  promotedByName: 'Rahul Menon',
};

/** Exactly what the award lane would have frozen onto this tier. */
function evidence(tier: AwardTier = 'silver', overrides: Partial<AwardFacts> = {}): string {
  return serialiseEvidence(tier, { ...FACTS, ...overrides });
}

/**
 * pdf.js reads `data.buffer` and ignores the view's byteOffset, and a Buffer
 * from `Buffer.concat` sits at a non-zero offset inside the pool — so a raw
 * Buffer is read as someone else's bytes and fails with "bad XRef entry".
 */
async function textOf(body: Buffer): Promise<string> {
  const mod = await import('pdf-parse/lib/pdf-parse.js');
  const parsed = await mod.default(Buffer.from(new Uint8Array(body)));
  return parsed.text.replace(/\s+/g, ' ');
}

interface Org {
  readonly tenantId: string;
  readonly adminToken: string;
  readonly adminId: string;
  readonly managerToken: string;
  readonly candidateId: string;
  readonly roleId: string;
}

async function makeOrg(slug: string, candidateName: string): Promise<Org> {
  const tenant = await prisma.tenant.create({ data: { name: `Org ${slug}` } });
  const admin = await prisma.user.create({
    data: { tenantId: tenant.id, email: `admin@${slug}.local`, name: 'Admin', passwordHash: 'x', role: 'admin' },
  });
  const manager = await prisma.user.create({
    data: { tenantId: tenant.id, email: `manager@${slug}.local`, name: 'Manager', passwordHash: 'x', role: 'manager' },
  });
  const role = await prisma.role.create({ data: { tenantId: tenant.id, title: ROLE_TITLE, status: 'approved' } });
  const candidate = await prisma.candidate.create({
    data: { tenantId: tenant.id, roleId: role.id, fullName: candidateName, email: `${slug}@example.com` },
  });
  return {
    tenantId: tenant.id,
    adminToken: signToken({ userId: admin.id, tenantId: tenant.id, role: 'admin', email: admin.email }),
    adminId: admin.id,
    managerToken: signToken({ userId: manager.id, tenantId: tenant.id, role: 'manager', email: manager.email }),
    candidateId: candidate.id,
    roleId: role.id,
  };
}

async function award(org: Org, tier: AwardTier, reference: string, verifyToken: string, evidenceJson = evidence(tier)) {
  return prisma.candidateAward.create({
    data: {
      tenantId: org.tenantId,
      candidateId: org.candidateId,
      roleId: org.roleId,
      tier,
      reference,
      verifyToken,
      evidenceJson,
      awardedAt: new Date('2026-09-24T00:00:00.000Z'),
    },
  });
}

let a: Org;
let b: Org;

const certificate = (org: Org, tier: string, token: string) =>
  request(app).get(`/api/candidates/${org.candidateId}/awards/${tier}/certificate.pdf`).set(auth(token)).responseType('blob');

beforeEach(async () => {
  await wipe();
  await prisma.rateLimitBucket.deleteMany();
  _resetRateLimits();
  a = await makeOrg('alpha', 'Priya Sharma');
  b = await makeOrg('beta', 'Chen Li');
  await award(a, 'silver', 'QS-SLV-8F2K-4471', 'v-alpha-silver-random');
});

describe('GET /api/candidates/:id/awards/:tier/certificate.pdf', () => {
  it('answers a real PDF', async () => {
    const res = await certificate(a, 'silver', a.adminToken);

    expect([res.status, res.headers['content-type'], (res.body as Buffer).subarray(0, 5).toString('latin1')])
      .toEqual([200, 'application/pdf', '%PDF-']);
  });

  it('names the download after the reference, never after the candidate', async () => {
    const res = await certificate(a, 'silver', a.adminToken);

    expect(res.headers['content-disposition']).toBe('attachment; filename="questor-silver-QS-SLV-8F2K-4471.pdf"');
  });

  it('writes the candidate name as selectable text', async () => {
    const text = await textOf((await certificate(a, 'silver', a.adminToken)).body);

    expect(text).toContain('Priya Sharma');
  });

  it('writes the claim line with the tier and the role, as words rather than welded glyphs', async () => {
    const text = await textOf((await certificate(a, 'silver', a.adminToken)).body);

    expect(text).toContain('Completed Questor’s Silver assessment for Senior Marketing Manager.');
  });

  it('names no organisation anywhere on the certificate', async () => {
    // The owner was explicit: Questor vouches for its own process and nobody
    // else's name appears, because an employer's name on this document reads
    // as the employer endorsing the candidate.
    const text = await textOf((await certificate(a, 'silver', a.adminToken)).body);

    expect(text).not.toContain('Org alpha');
  });

  it('writes all five evidence rows', async () => {
    const text = await textOf((await certificate(a, 'silver', a.adminToken)).body);

    expect([
      text.includes('CV read against the approved scorecard, version 4'),
      text.includes('Structured interview completed'),
      text.includes('Every rating carries a verbatim quote from the transcript'),
      text.includes('Aparna Rao'),
      text.includes('Rahul Menon'),
    ]).toEqual([true, true, true, true, true]);
  });

  it('writes the footnote', async () => {
    const text = await textOf((await certificate(a, 'silver', a.adminToken)).body);

    expect(text).toContain('Evidence of process, not a recommendation.');
  });

  it('quotes no transcript on the face of it', async () => {
    // The owner cut the verbatim quote deliberately. The evidence row may SAY
    // that quotes exist; it must not carry one.
    const text = await textOf((await certificate(a, 'silver', a.adminToken)).body);

    expect(text).not.toMatch(/[“"][^”"]{40,}[”"]/);
  });

  it('states what was true when it was struck, not what the database says now', async () => {
    await prisma.candidate.update({ where: { id: a.candidateId }, data: { fullName: 'Someone Else Entirely' } });
    await prisma.role.update({ where: { id: a.roleId }, data: { title: 'A Different Role' } });

    const text = await textOf((await certificate(a, 'silver', a.adminToken)).body);

    expect([text.includes('Priya Sharma'), text.includes('Someone Else Entirely'), text.includes('A Different Role')])
      .toEqual([true, false, false]);
  });

  it('prints a verify link that cannot be worked out from the printed reference', async () => {
    // The mockup shows QS-SLV-8F2K-4471 beside questor.app/v/8F2K4471, which
    // reads as one derived from the other. If it were, the reference — quoted
    // in emails and ATS notes by people who think it is an order number —
    // would hand anyone the verification link for that candidate.
    const text = await textOf((await certificate(a, 'silver', a.adminToken)).body);
    const reference = 'QS-SLV-8F2K-4471';
    const blocks = reference.split('-').slice(2).join('');

    expect([text.includes(reference), text.includes('v-alpha-silver-random'), text.includes(`/v/${blocks}`)])
      .toEqual([true, true, false]);
  });
});

describe('the structure the owner settled on', () => {
  /**
   * Identical on Bronze, Silver and Gold: header, kicker, name, rule, claim
   * line with its asterisk, exactly five evidence rows, two signature blocks
   * flanking the seal, footnote. The owner iterated on this six times, so any
   * drift between tiers is a defect rather than a variation — two certificates
   * must be able to sit side by side and read as the same document.
   */
  it.each(['bronze', 'silver', 'gold'] as const)('holds every part of the frame on %s', async (tier) => {
    await prisma.candidateAward.deleteMany({ where: { candidateId: a.candidateId } });
    await award(a, tier, `QS-XXX-FRAME-${tier}`, `v-frame-${tier}`);

    const text = await textOf((await certificate(a, tier, a.adminToken)).body);
    // Each tier records different things, so the rows are read off what the
    // award lane wrote for THIS tier and then looked for on the page. A row
    // dropped for want of a fact is the drift the fixed frame exists to stop,
    // and it is invisible to a reader holding one certificate.
    const written = (JSON.parse(evidence(tier)) as { rows: { what: string }[] }).rows;

    expect({
      wordmark: text.includes('QUESTOR'),
      reference: text.includes('REFERENCE'),
      issued: text.includes('ISSUED'),
      verify: text.includes('VERIFY'),
      kicker: text.includes('RECORD OF ASSESSMENT'),
      name: text.includes('Priya Sharma'),
      claim: /Questor’s (Bronze|Silver|Gold)/.test(text),
      asterisk: text.includes('*'),
      evidenceHeading: text.includes('WHAT THIS RECORDS'),
      rows: written.length === 5 && written.every((row) => text.includes(row.what)),
      leftSignature: /ASSESSED BY · /.test(text),
      rightSignature: /RECORDED BY · THE HIRING TEAM/.test(text),
      footnote: text.includes('Evidence of process, not a recommendation.'),
    }).toEqual({
      wordmark: true, reference: true, issued: true, verify: true, kicker: true, name: true,
      claim: true, asterisk: true, evidenceHeading: true, rows: true,
      leftSignature: true, rightSignature: true, footnote: true,
    });
  });

  it.each(['bronze', 'silver', 'gold'] as const)('lays out five rows on %s and never four or six', async (tier) => {
    // The frame is the same document on every tier, so the count is asserted
    // on what the award lane wrote rather than on what the page happens to
    // show: a row dropped here would be invisible to a reader.
    expect((JSON.parse(evidence(tier)) as { rows: unknown[] }).rows).toHaveLength(5);
  });
});

describe('the Bronze certificate', () => {
  beforeEach(async () => {
    await award(
      a,
      'bronze',
      'QS-BRZ-2D9P-1183',
      'v-alpha-bronze-random',
      evidence('bronze', { candidateName: 'Mei Lin Chua' }),
    );
  });

  it('says "not for release" in words, because a watermark dies in a monochrome print', async () => {
    const text = await textOf((await certificate(a, 'bronze', a.adminToken)).body);

    expect(text).toContain('RECORD OF ASSESSMENT · NOT FOR RELEASE');
  });

  it('carries INTERNAL as real text, not only as artwork', async () => {
    const text = await textOf((await certificate(a, 'bronze', a.adminToken)).body);

    expect(text).toContain('INTERNAL');
  });

  it('adds that it is held by the hiring team', async () => {
    const text = await textOf((await certificate(a, 'bronze', a.adminToken)).body);

    expect(text).toContain('Held by the hiring team; not issued to the candidate.');
  });

  it('names the scorecard version in the assessor slot and no person at all', async () => {
    // The absence of a human assessor is the point of the row, and the
    // qualifier names the scorecard version that actually read the CV so the
    // claim is checkable against a specific artefact.
    const text = await textOf((await certificate(a, 'bronze', a.adminToken)).body);

    // The name sits directly above its qualifier, so the pair read together
    // is what says whether a person is being claimed as the assessor.
    expect([text.includes('Questor ASSESSED BY · SCORECARD V4, NO HUMAN REVIEW'), text.includes('Rahul Menon ASSESSED BY')])
      .toEqual([true, false]);
  });

  it('records the person who put the CV into Questor, under a line that claims nothing', async () => {
    // Somebody did upload this CV, and naming them beside "recorded by" is
    // attributable without implying that they read it.
    const text = await textOf((await certificate(a, 'bronze', a.adminToken)).body);

    expect([text.includes('Rahul Menon'), text.includes('RECORDED BY · THE HIRING TEAM')]).toEqual([true, true]);
  });
});

describe('Diamond', () => {
  beforeEach(async () => {
    await award(a, 'diamond', 'QS-DMD-9Q3T-7710', 'v-alpha-diamond-random');
  });

  it('refuses a certificate', async () => {
    const res = await certificate(a, 'diamond', a.adminToken);

    expect(res.status).toBe(409);
  });

  it('says why rather than answering a bare 404', async () => {
    const res = await request(app)
      .get(`/api/candidates/${a.candidateId}/awards/diamond/certificate.pdf`)
      .set(auth(a.adminToken));

    expect(res.body.error).toMatch(/Diamond records what the hiring team decided/);
  });

  it('still exports a badge', async () => {
    const res = await request(app)
      .get(`/api/candidates/${a.candidateId}/awards/diamond/badge.svg`)
      .set(auth(a.adminToken));

    expect(res.status).toBe(200);
  });
});

describe('tenant isolation', () => {
  beforeEach(async () => {
    await award(b, 'silver', 'QS-SLV-BBBB-0002', 'v-beta-silver-random');
  });

  it('will not export another organisation’s certificate', async () => {
    const res = await certificate(b, 'silver', a.adminToken);

    expect(res.status).toBe(404);
  });

  it('will not export another organisation’s badge', async () => {
    const res = await request(app)
      .get(`/api/candidates/${b.candidateId}/awards/silver/badge.png`)
      .set(auth(a.adminToken));

    expect(res.status).toBe(404);
  });

  it('will not send another organisation’s certificate', async () => {
    const res = await request(app)
      .post(`/api/candidates/${b.candidateId}/awards/silver/certificate/send`)
      .set(auth(a.adminToken));

    expect(res.status).toBe(404);
  });

  it('refuses Diamond only after deciding the caller may see the candidate', async () => {
    // Otherwise the explanation itself confirms that the id is a real
    // candidate somewhere, which is the one thing a 404 exists to withhold.
    await award(b, 'diamond', 'QS-DMD-BBBB-0003', 'v-beta-diamond-random');

    const res = await certificate(b, 'diamond', a.adminToken);

    expect(res.status).toBe(404);
  });

  it('answers 404, never 403, so an out-of-scope id is never confirmed to exist', async () => {
    const real = await certificate(b, 'silver', a.adminToken);
    const invented = await certificate({ ...b, candidateId: 'cand_does_not_exist' }, 'silver', a.adminToken);

    expect(real.status).toBe(invented.status);
  });

  it('cannot be reached by pointing a tier at a candidate in another organisation', async () => {
    // The award query pins tenant AND candidate, so an award id guessed from
    // elsewhere has nothing to attach itself to.
    const res = await certificate({ ...a, candidateId: b.candidateId }, 'silver', a.adminToken);

    expect(res.status).toBe(404);
  });
});

describe('badges', () => {
  it('answers a real PNG', async () => {
    const res = await request(app)
      .get(`/api/candidates/${a.candidateId}/awards/silver/badge.png?size=128`)
      .set(auth(a.adminToken))
      .responseType('blob');
    const body = res.body as Buffer;

    expect([res.status, body.subarray(1, 4).toString('latin1'), body.readUInt32BE(16), body.readUInt32BE(20)])
      .toEqual([200, 'PNG', 128, 128]);
  });

  it('answers vector SVG carrying its own label', async () => {
    const res = await request(app)
      .get(`/api/candidates/${a.candidateId}/awards/silver/badge.svg`)
      .set(auth(a.adminToken))
      .responseType('blob');
    const svg = (res.body as Buffer).toString('utf8');

    expect([res.status, svg.startsWith('<svg'), svg.includes('<title>Silver badge</title>')])
      .toEqual([200, true, true]);
  });

  it('snaps a size off the ladder to the nearest one on it', async () => {
    const res = await request(app)
      .get(`/api/candidates/${a.candidateId}/awards/silver/badge.png?size=300`)
      .set(auth(a.adminToken))
      .responseType('blob');

    expect((res.body as Buffer).readUInt32BE(16)).toBe(256);
  });

  it('clamps an absurd size rather than rasterising it', async () => {
    const res = await request(app)
      .get(`/api/candidates/${a.candidateId}/awards/silver/badge.png?size=99999`)
      .set(auth(a.adminToken))
      .responseType('blob');

    expect((res.body as Buffer).readUInt32BE(16)).toBe(1024);
  });

  it('shows nothing for a tier that has not been earned', async () => {
    // Nothing is shown before it is earned: a candidate whose Silver interview
    // is finished but who has not been progressed has no Gold anything.
    const res = await request(app)
      .get(`/api/candidates/${a.candidateId}/awards/gold/badge.svg`)
      .set(auth(a.adminToken));

    expect(res.status).toBe(404);
  });

  it('treats a tier that is not a tier as a URL that does not exist', async () => {
    const res = await request(app)
      .get(`/api/candidates/${a.candidateId}/awards/platinum/badge.svg`)
      .set(auth(a.adminToken));

    expect(res.status).toBe(404);
  });
});

describe('POST /api/candidates/:id/awards/:tier/certificate/send', () => {
  const send = (org: Org, tier: string, token: string) =>
    request(app).post(`/api/candidates/${org.candidateId}/awards/${tier}/certificate/send`).set(auth(token));

  it('refuses a hiring manager, who may take a copy but may not release one', async () => {
    const res = await send(a, 'silver', a.managerToken);

    expect(res.status).toBe(403);
  });

  it('records when it was sent and who sent it', async () => {
    await send(a, 'silver', a.adminToken);

    const row = await prisma.candidateAward.findFirstOrThrow({ where: { reference: 'QS-SLV-8F2K-4471' } });
    expect([row.sentToCandidateAt !== null, row.sentByUserId]).toEqual([true, a.adminId]);
  });

  it('refuses a second send rather than posting the same document twice', async () => {
    await send(a, 'silver', a.adminToken);

    const again = await send(a, 'silver', a.adminToken);

    expect(again.status).toBe(409);
  });

  it('refuses Bronze, which is the hiring team’s and not the candidate’s', async () => {
    await award(a, 'bronze', 'QS-BRZ-AAAA-0009', 'v-alpha-bronze-2');

    const res = await send(a, 'bronze', a.adminToken);

    expect(res.status).toBe(409);
  });

  it('never fires on its own — nothing is sent until an admin asks', async () => {
    await request(app).get(`/api/candidates/${a.candidateId}/awards/silver/certificate.pdf`).set(auth(a.adminToken));

    const row = await prisma.candidateAward.findFirstOrThrow({ where: { reference: 'QS-SLV-8F2K-4471' } });
    expect(row.sentToCandidateAt).toBeNull();
  });
});

describe('what a second application must not do', () => {
  it('exports the award struck for the application being looked at', async () => {
    // One candidate row per application, so `candidate.roleId` says which one.
    // Without pinning it, a second, later award of the same tier on another
    // role would be exported instead — the wrong role, under a reference the
    // reader cannot tell apart from the right one.
    const other = await prisma.role.create({ data: { tenantId: a.tenantId, title: 'Head of Growth', status: 'approved' } });
    await prisma.candidateAward.create({
      data: {
        tenantId: a.tenantId,
        candidateId: a.candidateId,
        roleId: other.id,
        tier: 'silver',
        reference: 'QS-SLV-LATER-0001',
        verifyToken: 'v-alpha-silver-later',
        evidenceJson: evidence('silver', { roleTitle: 'Head of Growth' }),
        awardedAt: new Date('2026-10-30T00:00:00.000Z'),
      },
    });

    const text = await textOf((await certificate(a, 'silver', a.adminToken)).body);

    expect([text.includes(ROLE_TITLE), text.includes('Head of Growth')]).toEqual([true, false]);
  });
});

describe('two admins pressing send at once', () => {
  it('emails the candidate once, and tells the other admin it has already gone', async () => {
    // Both requests read `sentToCandidateAt` as null before either writes, so
    // the check on the way in cannot be the guard. The conditional claim is.
    const { getEmail } = await import('../src/providers/email/index.js');
    const send = vi.spyOn(getEmail(), 'send');

    const both = await Promise.all([
      request(app).post(`/api/candidates/${a.candidateId}/awards/silver/certificate/send`).set(auth(a.adminToken)),
      request(app).post(`/api/candidates/${a.candidateId}/awards/silver/certificate/send`).set(auth(a.adminToken)),
    ]);
    const sends = send.mock.calls.length;
    send.mockRestore();

    expect([both.map((r) => r.status).sort(), sends]).toEqual([[200, 409], 1]);
  });
});

describe('a send that does not go out', () => {
  it('leaves the award unsent so an admin can try again', async () => {
    // Recording the send first would make a minute of provider downtime
    // permanent: the "already sent" guard would refuse every retry, and the
    // candidate would never receive anything.
    const { getEmail } = await import('../src/providers/email/index.js');
    const provider = getEmail();
    const send = vi.spyOn(provider, 'send').mockRejectedValueOnce(new Error('smtp is down'));

    const failed = await request(app)
      .post(`/api/candidates/${a.candidateId}/awards/silver/certificate/send`)
      .set(auth(a.adminToken));
    send.mockRestore();
    const row = await prisma.candidateAward.findFirstOrThrow({ where: { reference: 'QS-SLV-8F2K-4471' } });

    expect([failed.status, row.sentToCandidateAt]).toEqual([502, null]);
  });
});

/**
 * The reader's own robustness, and the one place JSON is written by hand.
 *
 * Everything here is a row the award lane CANNOT produce — the writer strips
 * control characters, guarantees five rows and signs both slots before it
 * stores anything. These rows exist anyway: a database is edited by hand, a
 * restore lands an older shape, a future lane writes the column directly. The
 * reader is the backstop for all three, and a backstop can only be tested
 * against damage the writer will not make.
 *
 * The distinction matters because it is what went wrong. When EVERY fixture
 * on this file was hand-built, the reader was only ever shown data that
 * satisfied it, and the writer's real output was never put in front of it.
 */
describe('a stored record the award lane would never have written', () => {
  const store = (evidenceJson: string) =>
    prisma.candidateAward.updateMany({ where: { reference: 'QS-SLV-8F2K-4471' }, data: { evidenceJson } });

  const exported = () =>
    request(app).get(`/api/candidates/${a.candidateId}/awards/silver/certificate.pdf`).set(auth(a.adminToken));

  /** The writer's output, to be damaged one field at a time. */
  const stored = () => JSON.parse(evidence('silver')) as Record<string, unknown>;

  it('refuses a role title carrying a line break', async () => {
    // `roleTitle` is interpolated into the subject line. A carriage return
    // there is how a second header gets smuggled into the message, so this is
    // refused rather than quietly stripped: the stored row is wrong, and
    // printing something other than what was frozen would hide that.
    await store(JSON.stringify({ ...stored(), roleTitle: 'Senior Marketing Manager\r\nBcc: someone@elsewhere.test' }));

    expect((await exported()).status).toBe(500);
  });

  it('refuses a record with no rows rather than printing an empty frame', async () => {
    await store(JSON.stringify({ ...stored(), rows: [], signatures: {} }));

    const res = await exported();

    expect([res.status, /stored record is incomplete/.test(res.body.error ?? '')]).toEqual([500, true]);
  });

  it('refuses four rows and six alike, because the frame is fixed', async () => {
    const rows = (stored().rows as unknown[]);

    const four = await store(JSON.stringify({ ...stored(), rows: rows.slice(0, 4) })).then(exported);
    const six = await store(JSON.stringify({ ...stored(), rows: [...rows, rows[0]] })).then(exported);

    expect([four.status, six.status]).toEqual([500, 500]);
  });

  it('says the record is incomplete rather than that the award is missing', async () => {
    // A 404 would send a recruiter looking for a candidate who is plainly on
    // their screen, and would bury a data fault nobody then fixes.
    const { signatures: _dropped, ...withoutSignatures } = stored();
    await store(JSON.stringify(withoutSignatures));

    const res = await exported();

    expect([res.status, /stored record is incomplete/.test(res.body.error ?? '')]).toEqual([500, true]);
  });

  it('signs a Bronze "Questor" even when the stored record names a person there', async () => {
    // The render asserts the absence of a human assessor rather than trusting
    // it, so a row that named the talent lead who pressed the button cannot
    // produce a certificate that looks human-reviewed.
    const bronze = JSON.parse(evidence('bronze')) as { signatures: { left: unknown; right: unknown } };
    await award(a, 'bronze', 'QS-BRZ-HAND-0001', 'v-alpha-bronze-hand', JSON.stringify({
      ...bronze,
      signatures: { ...bronze.signatures, left: { name: 'Rahul Menon', role: 'Assessed by · subject-matter expert' } },
    }));

    const text = await textOf((await certificate(a, 'bronze', a.adminToken)).body);

    expect([text.includes('Questor ASSESSED BY'), text.includes('Rahul Menon ASSESSED BY')]).toEqual([true, false]);
  });
});
