// Visual check of the candidate's status page against the running dev server:
// the two states the owner picked — waiting for the team, and feedback arrived
// — at phone and desk widths, in the interview room's dark theme.
// Reuses the e2e session and an E2E candidate (run the e2e suite first).
// Usage: node e2e/scripts/shotStatus.mjs <outDir>
import { chromium, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const out = process.argv[2] ?? '.';
const base = 'http://localhost:5173';
const statePath = resolve(import.meta.dirname, '../.auth/recruiter.json');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const csrf = state.cookies.find((c) => c.name === 'questor_csrf')?.value ?? '';
const headers = { 'X-CSRF-Token': csrf };
const sizes = [['375', 375, 900], ['1440', 1440, 1000]];

const ANSWER = 'I owned our billing data pipeline end to end: I moved the nightly batch jobs to streaming, '
  + 'added alerting so failures surfaced within minutes, made recovery idempotent so a rerun was always safe, '
  + 'and cut failed loads by sixty percent while keeping the finance team informed at every step.';

const browser = await chromium.launch();
const hr = await browser.newContext({ storageState: statePath, baseURL: base });

const list = await (await hr.request.get('/api/candidates')).json();
const candidate = list.candidates.find((c) => /^E2E Candidate/.test(c.fullName ?? c.name ?? ''));
if (!candidate) throw new Error('No E2E candidate found; run the e2e suite first.');

const created = await (await hr.request.post('/api/interviews', {
  headers, data: { candidateId: candidate.id, interviewer: 'maya', persona: { tone: 'warm' }, recordingRequested: false },
})).json();
const sessionId = created.session.id;
const invite = await (await hr.request.post(`/api/interviews/${sessionId}/invite`, { headers, data: {} })).json();
const portalUrl = invite.invitation.portalUrl;
const token = new URL(portalUrl).pathname.split('/').filter(Boolean).pop();

// Consent and run the interview to the end, typed, through the same endpoints
// the room uses. Nothing here is a shortcut past a rule: the server refuses
// each of these in any state but the right one.
await hr.request.post(`/api/portal/${token}/consent`, { data: { recordingConsent: false, accepted: true } });
await hr.request.post(`/api/portal/${token}/techcheck`, { data: { mic: false, speaker: false } });
await hr.request.post(`/api/portal/${token}/start`, { data: {} });
let done = false;
for (let i = 0; i < 60 && !done; i += 1) {
  const res = await hr.request.post(`/api/portal/${token}/turn`, { data: { text: ANSWER } });
  if (!res.ok()) throw new Error(`turn failed: ${res.status()} ${await res.text()}`);
  done = (await res.json()).turn.done;
}
if (!done) throw new Error('The interview did not finish.');

async function shoot(label) {
  for (const [name, width, height] of sizes) {
    const ctx = await browser.newContext({
      viewport: { width, height },
      storageState: { cookies: [], origins: [] },
      colorScheme: 'dark',
    });
    const page = await ctx.newPage();
    await page.goto(portalUrl, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 20_000 });
    // The avatar's halo breathes; hold it still so two runs are comparable.
    await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
    await page.screenshot({ path: `${out}/status-${label}-${name}.png`, fullPage: true });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    console.log(`${label} ${name}: overflow ${overflow}px`);
    await ctx.close();
  }
}

await shoot('waiting');

// A completed review releases the candidate's letter at once, which is the
// second state. Recorded through the page, as a reviewer would.
const hrPage = await hr.newPage();
await hrPage.setViewportSize({ width: 1440, height: 1000 });
await expect.poll(async () => {
  await hrPage.goto(`${base}/interviews/${sessionId}`);
  await hrPage.getByTestId('invitation-status').waitFor({ timeout: 10_000 }).catch(() => undefined);
  return hrPage.getByRole('link', { name: 'Open the assessment' }).count();
}, { timeout: 180_000 }).toBeGreaterThan(0);
await hrPage.getByRole('link', { name: 'Open the assessment' }).click();
await hrPage.getByRole('heading', { name: 'Assessment', exact: true }).waitFor({ timeout: 30_000 });
await hrPage.getByTestId('verdict-CONSIDER').click();
await hrPage.getByLabel('Why (required)').fill('Recording the read so the candidate letter goes out.');
await hrPage.getByTestId('verdict-act').click();
await hrPage.getByTestId('verdict-recorded').waitFor({ timeout: 30_000 });

const waiter = await browser.newContext({ storageState: { cookies: [], origins: [] } });
const probe = await waiter.newPage();
await expect.poll(async () => {
  await probe.goto(portalUrl, { waitUntil: 'networkidle' });
  return (await probe.getByTestId('cstatus-letter').textContent({ timeout: 3_000 }).catch(() => '')) ?? '';
}, { timeout: 120_000 }).not.toBe('');
await waiter.close();

await shoot('feedback');

await browser.close();
console.log(`Screenshots written to ${out}`);
