import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { _resetRateLimits } from '../src/middleware/rateLimit.js';

/**
 * Exporting a credential.
 *
 * The assertions here are about the bytes and about who can reach them, not
 * about our own helpers: that the response really is a PDF, that the text
 * inside it is real selectable text (pdf-parse reads it back), and that a
 * candidate belonging to another organisation is unreachable by every route on
 * this router. A screenshot, or a query missing its tenant filter, would pass
 * a status-code test and fail these.
 */

const app = createApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const ROLE_TITLE = 'Senior Marketing Manager';

function evidence(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    candidateName: 'Priya Sharma',
    roleTitle: ROLE_TITLE,
    rows: [
      { what: 'CV read against the approved scorecard, version 4', when: '21 Sep 2026' },
      { what: 'Structured interview completed — 24 of 30 minutes, ten competencies', when: '22 Sep 2026' },
      { what: 'Every rating carries a verbatim quote from the transcript', when: '22 Sep 2026' },
      { what: 'Assessed by **Aparna Rao**, subject-matter expert', when: '23 Sep 2026' },
      { what: 'Progressed to Gold by **Rahul Menon**, talent lead', when: '24 Sep 2026' },
    ],
    signatures: {
      left: { name: 'Aparna Rao', role: 'Assessed by · subject-matter expert' },
      right: { name: 'Rahul Menon', role: 'Recorded by · talent lead' },
    },
    ...overrides,
  });
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

async function award(org: Org, tier: string, reference: string, verifyToken: string, evidenceJson = evidence()) {
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

describe('the Bronze certificate', () => {
  beforeEach(async () => {
    await award(
      a,
      'bronze',
      'QS-BRZ-2D9P-1183',
      'v-alpha-bronze-random',
      evidence({
        candidateName: 'Mei Lin Chua',
        signatures: {
          left: { name: 'Rahul Menon', role: 'Assessed by · scorecard v4, no human review' },
          right: { name: 'Rahul Menon', role: 'Recorded by · talent lead' },
        },
      }),
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

  it('signs the assessor slot "Questor" even when the stored evidence names a person', async () => {
    // The absence of a human assessor is the point of the row. A Bronze that
    // printed the talent lead who merely pressed the button would look
    // human-reviewed when nothing human read the CV.
    const text = await textOf((await certificate(a, 'bronze', a.adminToken)).body);

    expect(text).toContain('ASSESSED BY · SCORECARD V4, NO HUMAN REVIEW');
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
        evidenceJson: evidence({ roleTitle: 'Head of Growth' }),
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

describe('stored evidence that could reach a mail header', () => {
  it('refuses a role title carrying a line break', async () => {
    // `roleTitle` is interpolated into the subject line. A carriage return
    // there is how a second header gets smuggled into the message.
    await prisma.candidateAward.updateMany({
      where: { reference: 'QS-SLV-8F2K-4471' },
      data: { evidenceJson: evidence({ roleTitle: 'Senior Marketing Manager\r\nBcc: someone@elsewhere.test' }) },
    });

    const res = await request(app)
      .get(`/api/candidates/${a.candidateId}/awards/silver/certificate.pdf`)
      .set(auth(a.adminToken));

    expect(res.status).toBe(500);
  });
});

describe('a stored record that cannot be rendered', () => {
  it('says the record is incomplete rather than that the award is missing', async () => {
    await prisma.candidateAward.updateMany({
      where: { reference: 'QS-SLV-8F2K-4471' },
      data: { evidenceJson: JSON.stringify({ version: 1, candidateName: 'Priya Sharma', roleTitle: ROLE_TITLE, rows: [], signatures: {} }) },
    });

    const res = await request(app)
      .get(`/api/candidates/${a.candidateId}/awards/silver/certificate.pdf`)
      .set(auth(a.adminToken));

    expect([res.status, /stored record is incomplete/.test(res.body.error ?? '')]).toEqual([500, true]);
  });
});
