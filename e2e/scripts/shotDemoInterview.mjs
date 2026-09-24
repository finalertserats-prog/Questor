// Screenshots of the demo interview, at both widths and in both themes.
//
//   node e2e/scripts/shotDemoInterview.mjs <outDir>
//
// Needs a dev server already running (QUESTOR_BASE_URL, default :5173) and
// takes its own demo sandbox through e2e/scripts/demoInterviewFixture.ts, so
// nothing here depends on a sandbox somebody left lying around.
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const out = process.argv[2] ?? '.';
const base = process.env.QUESTOR_BASE_URL ?? 'http://localhost:5173';
const repoRoot = resolve(import.meta.dirname, '../..');
const sizes = [['1440', 1440, 1000], ['375', 375, 900]];
const themes = ['light', 'dark'];

mkdirSync(out, { recursive: true });

function fixture(command) {
  const stdout = execFileSync('npx', ['tsx', 'e2e/scripts/demoInterviewFixture.ts', command], {
    cwd: repoRoot, encoding: 'utf8', shell: true,
  });
  const marker = 'QUESTOR_FIXTURE_ANSWER:';
  const line = stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith(marker));
  if (!line) throw new Error(`fixture ${command} produced nothing usable`);
  return line.slice(marker.length);
}

const browser = await chromium.launch();

/** One page, at both widths and in both themes. `prepare` runs per shot. */
async function shoot(label, prepare, { storageState } = {}) {
  for (const [width, w, h] of sizes) {
    for (const theme of themes) {
      const ctx = await browser.newContext({
        viewport: { width: w, height: h }, colorScheme: theme, baseURL: base,
        storageState: storageState ?? { cookies: [], origins: [] },
      });
      // The console's theme is a stored choice, not the OS preference — see
      // web/src/components/theme.tsx, which deliberately ignores the OS. So
      // colorScheme alone renders every "dark" shot in light.
      await ctx.addInitScript((t) => {
        try { window.localStorage.setItem('questor-theme', t); } catch { /* blocked storage */ }
      }, theme);
      const page = await ctx.newPage();
      await prepare(page);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
      await page.screenshot({ path: `${out}/demo-${label}-${width}-${theme}.png`, fullPage: true });
      // 375 with a horizontal scrollbar is the house failure.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      console.log(`demo-${label}-${width}-${theme}.png  overflow=${overflow}`);
      await ctx.close();
    }
  }
}

/** Open a demo and hand back the storage state a signed-in visitor has. */
async function demoSession() {
  const token = fixture('link');
  const ctx = await browser.newContext({ baseURL: base });
  const page = await ctx.newPage();
  await page.goto(`/demo/${token}`);
  await page.getByRole('button', { name: 'Start demo' }).click();
  await page.getByText(/Demo · ends in/).waitFor({ timeout: 30_000 });
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

// 1. The mode choice. Taken twice: as the deployment actually is (one mode on
//    offer), which is the shot that shows the "nothing is disclaimed" rule.
const choosing = await demoSession();
await shoot('choice', async (page) => {
  await page.goto('/demo/interview');
  await page.getByRole('heading', { name: 'Try the interview' }).waitFor({ timeout: 30_000 });
}, { storageState: choosing });

// 2. The observer view, part-way through the written interview.
const watching = await demoSession();
const runId = await (async () => {
  const ctx = await browser.newContext({ baseURL: base, storageState: watching });
  const page = await ctx.newPage();
  await page.goto('/demo/interview');
  await page.getByRole('button', { name: 'Watch one happen — start' }).click();
  await page.waitForURL(/\/demo\/watch\//, { timeout: 30_000 });
  const id = new URL(page.url()).pathname.split('/').pop();
  // Let a few turns land so the shot is of a conversation, not an empty room.
  await page.waitForTimeout(16_000);
  await ctx.close();
  return id;
})();

await shoot('observer', async (page) => {
  await page.goto(`/demo/watch/${runId}`);
  await page.getByRole('heading', { name: 'You are watching an interview' }).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2_000);
}, { storageState: watching });

// 3. The same view once the box has ended it: the close, the assessment link.
fixture('rush-played');
await shoot('ended', async (page) => {
  await page.goto(`/demo/watch/${runId}`);
  await page.getByRole('heading', { name: 'The interview finished' }).waitFor({ timeout: 40_000 });
}, { storageState: watching });

// 4. The candidate status page — the handoff a real candidate sees.
const statusToken = await (async () => {
  const ctx = await browser.newContext({ baseURL: base, storageState: watching });
  const page = await ctx.newPage();
  await page.goto('/demo/interview');
  const link = await page.evaluate(async () => {
    const res = await fetch('/api/demo/interview', { credentials: 'include' });
    if (!res.ok) return null;
    return (await res.json()).portalUrl;
  });
  await ctx.close();
  return link ? new URL(link).pathname : null;
})();
if (statusToken) {
  await shoot('status', async (page) => {
    await page.goto(statusToken);
    await page.waitForLoadState('networkidle');
  });
}

// 5. The feedback form, which runs signed out.
const ticket = await (async () => {
  const ctx = await browser.newContext({ baseURL: base, storageState: watching });
  const page = await ctx.newPage();
  await page.goto('/demo/interview');
  const value = await page.evaluate(async () => {
    const csrf = (document.cookie.match(/questor_csrf=([^;]+)/) ?? [])[1] ?? '';
    const res = await fetch('/api/demo/interview/feedback-ticket', { method: 'POST', headers: { 'X-CSRF-Token': csrf } });
    return (await res.json()).token;
  });
  await ctx.close();
  return value;
})();

await shoot('feedback', async (page) => {
  await page.goto(`/demo/feedback/${ticket}`);
  await page.getByRole('heading', { name: 'What did you make of it?' }).waitFor({ timeout: 30_000 });
  await page.getByLabel('Your feedback').fill('The follow-up about the schema contracts felt like a real interviewer listening. The pacing was right.');
});

await browser.close();
