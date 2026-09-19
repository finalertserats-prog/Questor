// One-off visual check of the AI interviewer selector (interview setup form)
// and the interview room header, against the running dev server, reusing the
// e2e session (refresh it with `npx playwright test dashboard`).
// Usage: node e2e/scripts/shotInterviewer.mjs <outDir>
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const out = process.argv[2] ?? '.';
const base = 'http://localhost:5173';
const statePath = resolve(import.meta.dirname, '../.auth/recruiter.json');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const csrf = state.cookies.find((c) => c.name === 'questor_csrf')?.value ?? '';
const sizes = [['desktop', 1440], ['phone', 390]];
const themes = ['light', 'dark'];

const browser = await chromium.launch();

// A candidate the e2e suite created, whose role scorecard is approved.
const hr = await browser.newContext({ storageState: statePath, baseURL: base });
const list = await (await hr.request.get('/api/candidates')).json();
const candidate = list.candidates.find((c) => /^E2E Candidate/.test(c.fullName ?? c.name ?? ''));
if (!candidate) throw new Error('No E2E candidate found; run the e2e suite first.');

for (const [name, width] of sizes) {
  for (const theme of themes) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, storageState: statePath });
    await ctx.addInitScript((t) => { localStorage.setItem('questor-theme', t); }, theme);
    const page = await ctx.newPage();
    await page.goto(`${base}/candidates/${candidate.id}`, { waitUntil: 'networkidle' });
    const skip = page.getByRole('button', { name: /skip tour/i });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await page.getByRole('tab', { name: 'Candidate journey' }).click();
    await page.getByRole('radio', { name: 'Maya', exact: true }).check();
    const card = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Set up interview' }) });
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: resolve(out, `setup-${name}-${theme}.png`) });
    await ctx.close();
  }
}

// An interview with Maya, invited, so the room can be opened as the candidate.
const headers = { 'X-CSRF-Token': csrf };
const created = await (await hr.request.post('/api/interviews', { headers, data: { candidateId: candidate.id, interviewer: 'maya', persona: { tone: 'warm' } } })).json();
const invite = await (await hr.request.post(`/api/interviews/${created.session.id}/invite`, { headers, data: {} })).json();
const portalUrl = invite.invitation.portalUrl;

// The consent screen, before anything is agreed: what to expect, then consent.
for (const [name, width] of sizes) {
  for (const theme of themes) {
    const cctx = await browser.newContext({ viewport: { width, height: 900 }, storageState: { cookies: [], origins: [] } });
    await cctx.addInitScript((t) => { localStorage.setItem('questor-theme', t); }, theme);
    const cpage = await cctx.newPage();
    await cpage.goto(portalUrl, { waitUntil: 'networkidle' });
    await cpage.screenshot({ path: resolve(out, `consent-review-${name}-${theme}.png`), fullPage: true });
    await cpage.getByRole('button', { name: 'Continue' }).click();
    await cpage.screenshot({ path: resolve(out, `consent-step-${name}-${theme}.png`), fullPage: true });
    await cctx.close();
  }
}

// One candidate visit (consent is recorded once), then every size and theme.
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: { cookies: [], origins: [] } });
await ctx.addInitScript(() => {
  // Headless has no audio; end synthesis at once so the room settles.
  const synth = window.speechSynthesis;
  if (synth) synth.speak = (u) => setTimeout(() => u.onend?.(new Event('end')), 10);
});
const page = await ctx.newPage();
await page.goto(portalUrl, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Continue' }).click();
await page.getByLabel(/I understand this first round/).check();
await page.getByRole('button', { name: /I consent/ }).click();
await page.getByRole('button', { name: /Continue anyway/ }).click();
await page.getByRole('button', { name: 'Join interview' }).click();
await page.getByTestId('room-interviewer').waitFor();
await page.waitForTimeout(1500);
for (const [name, width] of sizes) {
  for (const theme of themes) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(out, `room-${name}-${theme}.png`) });
  }
}
await ctx.close();
await hr.close();
await browser.close();
