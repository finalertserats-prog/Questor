import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';
import { createDemoData, wipe } from '../src/seed/demoData.js';
import { SUPPORTED_LANGUAGES, getDisclosureText, describeLanguageSupport } from '../src/i18n/locales.js';

const app = createApp();

async function seeded() {
  const ids = await createDemoData();
  const login = await request(app).post('/api/auth/login').send({ email: ids.email, password: ids.password });
  expect(login.status).toBe(200);
  return { ...ids, auth: login.body.token as string };
}

const DISCLOSURE = 'This first-round interview is conducted by an AI interviewer and is transcribed.';

describe('multi-language interview delivery', () => {
  beforeEach(async () => { await wipe(); });

  it('lists every supported language with its review and speech status', async () => {
    const ids = await seeded();

    const res = await request(app).get('/api/interviews/supported-languages').set('Authorization', `Bearer ${ids.auth}`);

    expect(res.status).toBe(200);
    expect(res.body.languages).toEqual(SUPPORTED_LANGUAGES);
    expect(res.body.languages).toContainEqual({ code: 'en', name: 'English', translationReviewed: true, sttLikelySupported: true });
  });

  it('marks English as the only language with reviewed disclosure copy', () => {
    const reviewed = SUPPORTED_LANGUAGES.filter((lang) => lang.translationReviewed).map((lang) => lang.code);

    expect(reviewed).toEqual(['en']);
  });

  it('requires authentication to read the language registry', async () => {
    const res = await request(app).get('/api/interviews/supported-languages');

    expect(res.status).toBe(401);
  });

  it('returns the English base text unchanged for an unreviewed language', () => {
    const resolved = getDisclosureText('fr', DISCLOSURE);

    expect(resolved).toEqual({ text: DISCLOSURE, translationReviewed: false });
  });

  it('returns the English base text unchanged for a language it has never heard of', () => {
    const resolved = getDisclosureText('zz-ZZ', DISCLOSURE);

    expect(resolved).toEqual({ text: DISCLOSURE, translationReviewed: false });
  });

  it('marks the English disclosure as reviewed', () => {
    const resolved = getDisclosureText('en', DISCLOSURE);

    expect(resolved).toEqual({ text: DISCLOSURE, translationReviewed: true });
  });

  it('resolves a regional variant to its primary language', () => {
    expect(describeLanguageSupport('en-GB').translationReviewed).toBe(true);
  });

  it('reports no speech support for a language the registry does not claim it for', () => {
    expect(describeLanguageSupport('hi').sttLikelySupported).toBe(false);
  });

  it('tells the candidate portal honestly that a non-English session is not translated', async () => {
    const ids = await createDemoData();
    await prisma.interviewSession.update({
      where: { id: ids.sessionId },
      data: { language: 'fr', consentJson: JSON.stringify({ disclosureText: DISCLOSURE }) },
    });

    const res = await request(app).get(`/api/portal/${ids.token}`);

    expect(res.status).toBe(200);
    expect(res.body.languageSupport).toEqual({ code: 'fr', translationReviewed: false, sttLikelySupported: false });
    expect(res.body.aiDisclosure).toBe(DISCLOSURE);
  });

  it('reports full support for an English session', async () => {
    const ids = await createDemoData();
    await prisma.interviewSession.update({
      where: { id: ids.sessionId },
      data: { language: 'en', consentJson: JSON.stringify({ disclosureText: DISCLOSURE }) },
    });

    const res = await request(app).get(`/api/portal/${ids.token}`);

    expect(res.status).toBe(200);
    expect(res.body.languageSupport).toEqual({ code: 'en', translationReviewed: true, sttLikelySupported: true });
  });

  it('keeps the proctoring disclosure sentence when resolving an unreviewed language', async () => {
    const ids = await createDemoData();
    await prisma.tenant.update({ where: { id: ids.tenantId }, data: { policyJson: JSON.stringify({ proctoringEnabled: true }) } });
    await prisma.interviewSession.update({
      where: { id: ids.sessionId },
      data: { language: 'es', consentJson: JSON.stringify({ disclosureText: DISCLOSURE }) },
    });

    const res = await request(app).get(`/api/portal/${ids.token}`);

    expect(res.status).toBe(200);
    expect(res.body.aiDisclosure).toContain('Basic browser activity');
    expect(res.body.languageSupport.translationReviewed).toBe(false);
  });
});
