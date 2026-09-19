import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { wipe, createDemoData, type DemoIds } from '../src/seed/demoData.js';
import { signToken } from '../src/services/auth.js';
import { seedInterviewers } from '../src/services/interviewers.js';
import { renderDemoAccessEmail, renderDemoDecisionEmail } from '../src/providers/email/demoEmail.js';
import { renderSignupOperatorEmail, renderSignupWelcomeEmail } from '../src/providers/email/signupEmail.js';
import { renderFeedbackOptInRequestEmail } from '../src/providers/email/feedbackOptInRequestEmail.js';
import { renderCandidateFeedbackEmail } from '../src/providers/email/candidateFeedbackEmail.js';

/**
 * Gmail disables every link in a message it files as spam, and some company
 * mail systems strip links outright. An invitation whose address lived only
 * inside a button reached a candidate as the words "Start or schedule your
 * interview" with nothing to click or copy. Every link Questor sends must
 * also be written out as text the reader can copy.
 */

const sent = vi.hoisted(() => ({ messages: [] as Array<{ to: string; subject: string; text: string; html: string }> }));
vi.mock('../src/providers/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/email/index.js')>();
  return {
    ...actual,
    getEmail: () => ({
      name: 'test', configured: true, delivers: true,
      async send(msg: { to: string; subject: string; text: string; html: string }) {
        sent.messages.push(msg);
        return { status: 'sent', id: `test-${sent.messages.length}` };
      },
    }),
  };
});

/** What a reader sees with links disabled: the HTML with every tag removed. */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ');
}

const URL_A = 'https://questor.example.test/one-time/abc123';
const URL_B = 'https://questor.example.test/decline/def456';

describe('the interview invitation', () => {
  const app = createApp();
  let ids: DemoIds;
  let bearer = '';

  beforeEach(async () => {
    sent.messages = [];
    await wipe();
    await prisma.aIInterviewer.deleteMany();
    await prisma.voiceProfile.deleteMany();
    await seedInterviewers('openai');
    ids = await createDemoData();
    bearer = `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}`;
  });

  it('writes the interview link out as text the candidate can copy', async () => {
    const created = await request(app).post('/api/interviews').set('Authorization', bearer).send({ candidateId: ids.candidateId });
    await request(app).post(`/api/interviews/${created.body.session.id}/invite`).set('Authorization', bearer).send({});
    const message = sent.messages.at(-1);
    const portalUrl = message?.text.match(/https?:\/\/\S+\/portal\/\S+/)?.[0] ?? 'missing';

    expect(visibleText(message?.html ?? '')).toContain(portalUrl);
  });
});

describe('the invitation reads like a real invitation', () => {
  const app = createApp();
  let ids: DemoIds;
  let bearer = '';
  let company = '';
  let candidateFirst = '';

  beforeEach(async () => {
    sent.messages = [];
    await wipe();
    await prisma.aIInterviewer.deleteMany();
    await prisma.voiceProfile.deleteMany();
    await seedInterviewers('openai');
    ids = await createDemoData();
    bearer = `Bearer ${signToken({ userId: ids.userId, tenantId: ids.tenantId, role: 'admin', email: ids.email })}`;
    company = (await prisma.tenant.findUniqueOrThrow({ where: { id: ids.tenantId } })).name;
    candidateFirst = (await prisma.candidate.findUniqueOrThrow({ where: { id: ids.candidateId } })).fullName.split(' ')[0];
  });

  async function invite() {
    const created = await request(app).post('/api/interviews').set('Authorization', bearer).send({ candidateId: ids.candidateId, interviewer: 'avery', durationMinutes: 30 });
    await request(app).post(`/api/interviews/${created.body.session.id}/invite`).set('Authorization', bearer).send({});
    return sent.messages.at(-1) ?? { subject: '', text: '', html: '' };
  }

  it('names the company in the subject', async () => {
    expect((await invite()).subject).toContain(company);
  });

  it('greets the candidate by first name', async () => {
    expect((await invite()).text.startsWith(`Hi ${candidateFirst},`)).toBe(true);
  });

  it('says how long the interview takes', async () => {
    expect(visibleText((await invite()).html)).toContain('About 30 minutes');
  });

  it('says they can speak or type their answers', async () => {
    expect(visibleText((await invite()).html)).toMatch(/speak or type/i);
  });

  it('says when the link expires', async () => {
    expect(visibleText((await invite()).html)).toMatch(/link works until \w+,? \d{1,2} \w+ \d{4}/);
  });

  it('offers a person instead of the AI interviewer', async () => {
    expect(visibleText((await invite()).html)).toMatch(/interview with a person/i);
  });

  it('is signed by the company hiring team, not a generic team', async () => {
    const message = await invite();
    expect([message.text.includes(`The ${company} hiring team`), message.text.includes('Recruiting Team')]).toEqual([true, false]);
  });

  it('keeps the plain-text body in step with the HTML body', async () => {
    const message = await invite();
    expect([message.text.includes('About 30 minutes'), /speak or type/i.test(message.text)]).toEqual([true, true]);
  });
});

describe('every other email with a link', () => {
  it.each([
    ['demo sign-in', () => renderDemoAccessEmail({ to: 'a@b.test', name: 'Ada', linkUrl: URL_A }), [URL_A]],
    ['demo re-access decision', () => renderDemoDecisionEmail({ to: 'a@b.test', name: 'Ada', email: 'ada@b.test', company: 'Acme', approveUrl: URL_A, declineUrl: URL_B }), [URL_A, URL_B]],
    ['signup request', () => renderSignupOperatorEmail({ to: 'a@b.test', name: 'Ada', email: 'ada@b.test', organisation: 'Acme', mode: 'new-org', approveUrl: URL_A, declineUrl: URL_B }), [URL_A, URL_B]],
    ['signup welcome', () => renderSignupWelcomeEmail({ to: 'a@b.test', name: 'Ada', signInUrl: URL_A }), [URL_A]],
    ['feedback opt-in', () => renderFeedbackOptInRequestEmail({ to: 'a@b.test', roleTitle: 'Engineer', consentUrl: URL_A, ttlDays: 30 }), [URL_A]],
    ['candidate feedback', () => renderCandidateFeedbackEmail({ to: 'a@b.test', roleTitle: 'Engineer', approvedText: 'Well done.', talkUrl: URL_A }), [URL_A]],
  ] as const)('writes out the link in the %s email', (_name, render, urls) => {
    const shown = visibleText(render().html);

    expect(urls.filter((url) => !shown.includes(url))).toEqual([]);
  });
});
