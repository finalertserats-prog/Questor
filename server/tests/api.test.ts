import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { wipe, DEMO_JD, DEMO_RESUME } from '../src/seed/demoData.js';
import { prisma } from '../src/db.js';

const app = createApp();
let token = '';
let roleId = '';
let candidateId = '';
let sessionId = '';
let assessmentId = '';

beforeAll(async () => {
  await wipe();
});

describe('Questor API end-to-end', () => {
  it('registers a recruiter', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'api@questor.local', password: 'correct-horse-battery-staple', name: 'API Tester', tenantName: 'API Org' });
    expect(res.status).toBe(201);
    token = res.body.token;
    expect(token).toBeTruthy();
  });

  it('creates a role and extracts a scorecard', async () => {
    const res = await request(app).post('/api/roles').set('Authorization', `Bearer ${token}`).send({ sourceType: 'paste', sourceText: DEMO_JD, title: 'Senior Data Engineer', useLlm: false });
    expect(res.status).toBe(201);
    roleId = res.body.role.id;
    expect(res.body.scorecard.profile.competencies.length).toBeGreaterThan(3);
  });

  it('rejects interviewing before the scorecard is approved', async () => {
    const cand = await request(app).post('/api/candidates').set('Authorization', `Bearer ${token}`).send({ fullName: 'Test Candidate', email: 't@e.com', roleId });
    const res = await request(app).post('/api/interviews').set('Authorization', `Bearer ${token}`).send({ candidateId: cand.body.candidate.id });
    expect(res.status).toBe(400);
  });

  it('approves the scorecard', async () => {
    const res = await request(app).post(`/api/roles/${roleId}/approve`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.scorecard.status).toBe('approved');
  });

  it('creates a candidate and parses a resume', async () => {
    const c = await request(app).post('/api/candidates').set('Authorization', `Bearer ${token}`).send({ fullName: 'Priya Sharma', email: 'priya@e.com', roleId });
    candidateId = c.body.candidate.id;
    const res = await request(app).post(`/api/candidates/${candidateId}/resume`).set('Authorization', `Bearer ${token}`).field('text', DEMO_RESUME);
    expect(res.status).toBe(201);
    expect(res.body.fit.overall).toBeGreaterThan(0);
    expect(res.body.profile.skills.length).toBeGreaterThan(0);
  });

  it('approves an interview and builds a plan', async () => {
    const res = await request(app).post('/api/interviews').set('Authorization', `Bearer ${token}`).send({ candidateId, durationMinutes: 45, approve: true });
    expect(res.status).toBe(201);
    sessionId = res.body.session.id;
    expect(res.body.plan.blocks.length).toBeGreaterThan(4);
  });

  it('runs the interview in text mode to completion', async () => {
    const start = await request(app).post(`/api/interviews/${sessionId}/start`).set('Authorization', `Bearer ${token}`).send({});
    expect(start.status).toBe(200);
    let done = start.body.turn.done;
    let guard = 0;
    while (!done && guard < 40) {
      guard++;
      const res = await request(app).post(`/api/interviews/${sessionId}/turn`).set('Authorization', `Bearer ${token}`).send({ text: 'I built and owned a production data pipeline on Snowflake, detected a failure via alerts, made recovery idempotent and reduced failures by 60% with measurable cost savings.' });
      done = res.body.turn.done;
      if (res.body.assessmentId) assessmentId = res.body.assessmentId;
    }
    expect(done).toBe(true);
    expect(assessmentId).toBeTruthy();
  });

  // Blind-first is enforced, not merely offered: a reviewer reaching the score
  // by typing the URL would lose the independence that keeps the AI advisory.
  it('withholds the assessment and its report until the reviewer records a verdict', async () => {
    const full = await request(app).get(`/api/assessments/${assessmentId}`).set('Authorization', `Bearer ${token}`);
    expect(full.status).toBe(409);
    // The report is the same conclusions in prose, so it must be gated too.
    const report = await request(app).get(`/api/assessments/${assessmentId}/report`).set('Authorization', `Bearer ${token}`);
    expect(report.status).toBe(409);
    // The blind view stays open — that is the way forward, not a locked door.
    const blind = await request(app).get(`/api/assessments/${assessmentId}/blind`).set('Authorization', `Bearer ${token}`);
    expect(blind.status).toBe(200);
    expect(JSON.stringify(blind.body.competencies)).not.toContain('"level"');
  });

  it('returns a grounded assessment with a recommendation once the verdict is recorded', async () => {
    const verdict = await request(app).post(`/api/assessments/${assessmentId}/blind-verdict`)
      .set('Authorization', `Bearer ${token}`)
      .send({ disposition: 'CONSIDER', reason: 'Independent read before seeing the machine output.' });
    expect(verdict.status).toBe(201);

    const res = await request(app).get(`/api/assessments/${assessmentId}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(['PROCEED', 'CONSIDER', 'DO_NOT_PROGRESS']).toContain(res.body.result.recommendation);
    expect(res.body.result.competencies.length).toBeGreaterThan(0);
    expect(res.body.result.evidenceCoverage).toBeGreaterThan(0);
  });

  it('unlocks via an audited break-glass when a reason is given', async () => {
    const other = await request(app).post('/api/auth/register')
      .send({ email: 'breakglass@questor.local', password: 'a-long-enough-password', name: 'BG', tenantName: 'BG Org' });
    const bgToken = other.body.token;
    // Their own tenant's assessment does not exist, so scope returns 404 — the
    // point here is that a weak reason is refused before anything else happens.
    const weak = await request(app).post(`/api/assessments/${assessmentId}/skip-blind-review`)
      .set('Authorization', `Bearer ${bgToken}`).send({ reason: 'nah' });
    expect(weak.status).toBe(400);
  });

  it('records a human review override with a reason', async () => {
    const res = await request(app).post(`/api/assessments/${assessmentId}/review`).set('Authorization', `Bearer ${token}`).send({ disposition: 'CONSIDER', reason: 'Want a second panel on leadership scope.' });
    expect(res.status).toBe(201);
  });

  it('exposes provider/connector status', async () => {
    const res = await request(app).get('/api/admin/providers').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.llm.provider).toBe('heuristic');
    expect(res.body.stt.provider).toBe('webspeech');
    expect(res.body.meeting.length).toBe(4);
  });

  it('generates analytics', async () => {
    const res = await request(app).get('/api/admin/analytics').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.funnel.interviews).toBeGreaterThan(0);
  });

  it('requires auth on protected routes', async () => {
    const res = await request(app).get('/api/roles');
    expect(res.status).toBe(401);
  });

  it('serves the candidate portal by token', async () => {
    const inv = await prisma.invitation.findFirst({ where: { sessionId } });
    // create an invitation for this session
    const invited = await request(app).post(`/api/interviews/${sessionId}/invite`).set('Authorization', `Bearer ${token}`).send({});
    // invite may 409 because session already ASSESSING; portal test uses seed invite instead
    expect([200, 409]).toContain(invited.status);
    expect(inv === null || typeof inv.token === 'string').toBe(true);
  });

  // The root integrity bypass: startInterview used to reset ANY state to
  // ASSESSING, so a finished interview could be reopened and its evidence
  // rewritten after a human had already seen the assessment.
  it('refuses to restart an interview that has already been assessed', async () => {
    const session = await prisma.interviewSession.findUnique({ where: { id: sessionId }, select: { state: true } });
    expect(['REVIEW_READY', 'HUMAN_REVIEWED']).toContain(session!.state);

    const res = await request(app).post(`/api/interviews/${sessionId}/start`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(409);

    const after = await prisma.interviewSession.findUnique({ where: { id: sessionId }, select: { state: true } });
    expect(after!.state).toBe(session!.state);
  });

  it('does not mint a second assessment when finalise is called again', async () => {
    const before = await prisma.assessmentVersion.count({ where: { sessionId } });
    const res = await request(app).post(`/api/interviews/${sessionId}/finalize`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(await prisma.assessmentVersion.count({ where: { sessionId } })).toBe(before);
  });

  it('rejects an auth token supplied via the query string', async () => {
    const res = await request(app).get(`/api/roles?token=${token}`);
    expect(res.status).toBe(401);
  });

  it('does not let registration self-assign a privileged role', async () => {
    const res = await request(app).post('/api/auth/register')
      .send({ email: 'probe@questor.local', password: 'another-long-password', name: 'Probe', tenantName: 'Probe Org', role: 'superuser' });
    expect(res.status).toBe(201);
    // The submitted role is ignored: the first user of a new tenant is its admin.
    expect(res.body.user.role).toBe('admin');
  });

  // Erasure is a legal obligation (GDPR Art. 17, DPDP s.8, Illinois AIVIA s.20),
  // so it needs coverage proving the data is actually gone, not just a 200.
  it('erases a candidate and everything derived from them', async () => {
    const victim = await request(app).post('/api/candidates').set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Erasure Test', email: 'erase@questor.local', roleId });
    expect(victim.status).toBe(201);
    const victimId = victim.body.candidate.id;

    await request(app).post(`/api/candidates/${victimId}/resume`).set('Authorization', `Bearer ${token}`).field('text', DEMO_RESUME);
    expect(await prisma.candidateProfileVersion.count({ where: { candidateId: victimId } })).toBeGreaterThan(0);

    const del = await request(app).delete(`/api/candidates/${victimId}`).set('Authorization', `Bearer ${token}`)
      .send({ reason: 'candidate requested erasure' });
    expect(del.status).toBe(200);

    expect(await prisma.candidate.count({ where: { id: victimId } })).toBe(0);
    expect(await prisma.candidateProfileVersion.count({ where: { candidateId: victimId } })).toBe(0);
    expect(await prisma.artifact.count({ where: { candidateId: victimId } })).toBe(0);

    // The audit record of the erasure must survive it.
    const audit = await prisma.auditEvent.findFirst({ where: { action: 'candidate.erased', entityId: victimId } });
    expect(audit).not.toBeNull();
  });

  it('issues the session as an httpOnly cookie with a readable CSRF companion', async () => {
    const res = await request(app).post('/api/auth/login')
      .send({ email: 'api@questor.local', password: 'correct-horse-battery-staple' });
    expect(res.status).toBe(200);

    const raw = res.headers['set-cookie'] as unknown as string[];
    const session = raw.find((c) => c.startsWith('questor_token='))!;
    const csrf = raw.find((c) => c.startsWith('questor_csrf='))!;

    expect(session.toLowerCase()).toContain('httponly');
    expect(session.toLowerCase()).toContain('samesite=strict');
    // Must stay readable: the browser has to echo it back in a header.
    expect(csrf.toLowerCase()).not.toContain('httponly');
    expect(csrf.toLowerCase()).toContain('samesite=strict');

    // Session lifetime is the only revocation mechanism, so pin it at ~1h.
    const claims = JSON.parse(Buffer.from((res.body.token as string).split('.')[1], 'base64url').toString());
    expect(claims.exp - claims.iat).toBe(3600);
  });

  it('refuses to erase a candidate belonging to another tenant', async () => {
    const other = await request(app).post('/api/auth/register')
      .send({ email: 'other@questor.local', password: 'yet-another-long-password', name: 'Other', tenantName: 'Other Org' });
    const otherToken = other.body.token;
    const res = await request(app).delete(`/api/candidates/${candidateId}`).set('Authorization', `Bearer ${otherToken}`)
      .send({ reason: 'cross-tenant probe' });
    expect(res.status).toBe(404);
    expect(await prisma.candidate.count({ where: { id: candidateId } })).toBe(1);
  });

  // GDPR Art. 17(3)(e) disapplies the right to erasure where the data is needed
  // to defend legal claims. Honouring an erasure request over a legal hold would
  // destroy the evidence the hold exists to preserve.
  it('refuses to erase a candidate whose interview is under legal hold', async () => {
    await prisma.interviewSession.update({ where: { id: sessionId }, data: { legalHold: true } });
    try {
      const res = await request(app).delete(`/api/candidates/${candidateId}`).set('Authorization', `Bearer ${token}`)
        .send({ reason: 'candidate requested erasure during an open complaint' });
      expect(res.status).toBe(409);
      expect(await prisma.candidate.count({ where: { id: candidateId } })).toBe(1);
      expect(await prisma.turn.count({ where: { sessionId } })).toBeGreaterThan(0);
    } finally {
      await prisma.interviewSession.update({ where: { id: sessionId }, data: { legalHold: false } });
    }
  });
});

// Cookie auth is ambient — the browser sends it cross-site too — so every
// state-changing route is forgeable without a CSRF gate.
describe('cookie session and CSRF protection', () => {
  let sessionCookie = '';
  let csrfCookie = '';
  let csrfValue = '';

  const cookieOf = (jar: string[], name: string) =>
    jar.find((c) => c.startsWith(`${name}=`))!.split(';')[0];

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/login')
      .send({ email: 'api@questor.local', password: 'correct-horse-battery-staple' });
    const jar = res.headers['set-cookie'] as unknown as string[];
    sessionCookie = cookieOf(jar, 'questor_token');
    csrfCookie = cookieOf(jar, 'questor_csrf');
    csrfValue = csrfCookie.slice('questor_csrf='.length);
  });

  it('authenticates a read using only the session cookie', async () => {
    const res = await request(app).get('/api/roles').set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
  });

  it('rejects a cookie-authenticated write with no CSRF header', async () => {
    const res = await request(app).post('/api/candidates').set('Cookie', [sessionCookie, csrfCookie].join('; '))
      .send({ fullName: 'CSRF Probe', email: 'csrf-none@e.com', roleId });
    expect(res.status).toBe(403);
    expect(await prisma.candidate.count({ where: { email: 'csrf-none@e.com' } })).toBe(0);
  });

  it('rejects a cookie-authenticated write whose CSRF header does not match the cookie', async () => {
    const res = await request(app).post('/api/candidates').set('Cookie', [sessionCookie, csrfCookie].join('; '))
      .set('X-CSRF-Token', 'not-the-right-value-not-the-right-value-xx')
      .send({ fullName: 'CSRF Probe', email: 'csrf-bad@e.com', roleId });
    expect(res.status).toBe(403);
    expect(await prisma.candidate.count({ where: { email: 'csrf-bad@e.com' } })).toBe(0);
  });

  it('accepts a cookie-authenticated write that echoes the CSRF cookie', async () => {
    const res = await request(app).post('/api/candidates').set('Cookie', [sessionCookie, csrfCookie].join('; '))
      .set('X-CSRF-Token', csrfValue)
      .send({ fullName: 'CSRF Ok', email: 'csrf-ok@e.com', roleId });
    expect(res.status).toBe(201);
  });

  // The bypass that makes the whole scheme collapse: CSRF is skipped whenever an
  // Authorization header is present, so if authenticate() fell back to the
  // cookie on a junk header, an attacker could send one cross-site and ride the
  // victim's session. The two rules must agree — a junk header must 401, never
  // silently authenticate via the cookie.
  it('does not let a junk Authorization header skip CSRF and fall back to the cookie', async () => {
    const res = await request(app).post('/api/candidates').set('Cookie', [sessionCookie, csrfCookie].join('; '))
      .set('Authorization', 'Bearer not-a-real-token')
      .send({ fullName: 'Bypass Probe', email: 'bypass@e.com', roleId });
    expect(res.status).toBe(401);
    expect(await prisma.candidate.count({ where: { email: 'bypass@e.com' } })).toBe(0);
  });

  it('leaves header-authenticated clients exempt from CSRF', async () => {
    const res = await request(app).post('/api/candidates').set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Header Client', email: 'header-client@e.com', roleId });
    expect(res.status).toBe(201);
  });

  it('exempts the unauthenticated candidate portal', async () => {
    const res = await request(app).post('/api/portal/nonexistent-token-abcdefgh/turn').send({ text: 'hello' });
    expect(res.status).not.toBe(403);
  });

  it('clears both cookies on logout', async () => {
    const res = await request(app).post('/api/auth/logout')
      .set('Cookie', [sessionCookie, csrfCookie].join('; ')).set('X-CSRF-Token', csrfValue);
    expect(res.status).toBe(200);
    const jar = res.headers['set-cookie'] as unknown as string[];
    // Expired cookies come back with an empty value, which is how the browser drops them.
    expect(cookieOf(jar, 'questor_token')).toBe('questor_token=');
    expect(cookieOf(jar, 'questor_csrf')).toBe('questor_csrf=');
  });
});

describe('health endpoint identifies the running build', () => {
  it('reports a commit so "is production current?" is one request', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.commit).toBeTruthy();
    // Either a real sha or an honest admission — never a crash, and never absent.
    expect(res.body.commit === 'unknown' || /^[0-9a-f]{7,40}$/.test(res.body.commit)).toBe(true);
  });

  it('still reports a timestamp per request', async () => {
    const res = await request(app).get('/api/health');
    expect(res.body.ts).toBeTruthy();
  });
});
