// Screenshots of the candidate page's two fit panels against the running dev
// server, reusing the e2e session.
//   node e2e/scripts/shotFit.mjs <candidateId> <outDir>
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const candidateId = process.argv[2];
const out = process.argv[3] ?? '.';
if (!candidateId) throw new Error('Usage: node e2e/scripts/shotFit.mjs <candidateId> <outDir>');
mkdirSync(out, { recursive: true });

// The dev server's address, so this can run beside another checkout's.
const base = process.env.QUESTOR_BASE_URL ?? 'http://localhost:5173';
const password = process.env.QUESTOR_DEMO_PASSWORD;
if (!password) throw new Error('Set QUESTOR_DEMO_PASSWORD (read it from the seed source; never print it).');

const browser = await chromium.launch();

// Sign in once and reuse the session, rather than depending on an e2e run
// having left an auth file behind.
const signIn = await browser.newContext({ viewport: { width: 1280, height: 900 } });
{
  const page = await signIn.newPage();
  await page.goto(`${base}/o/acme`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill('demo@questor.local');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForSelector('[role="tab"]', { timeout: 30_000 });
  await page.close();
}
const state = await signIn.storageState();
await signIn.close();

async function open(width, theme) {
  const ctx = await browser.newContext({ viewport: { width, height: 1100 }, storageState: state });
  await ctx.addInitScript((t) => { localStorage.setItem('questor-theme', t); }, theme);
  const page = await ctx.newPage();
  await page.goto(`${base}/candidates/${candidateId}`, { waitUntil: 'domcontentloaded' });
  const skip = page.getByRole('button', { name: /skip tour/i });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  return { ctx, page };
}

/** The whole card, so the heading and the caveat are in shot with the panel. */
const cardWith = (page, testId) => page.locator('.card').filter({ has: page.getByTestId(testId) });

const sizes = (process.env.QUESTOR_SHOT_WIDTHS ?? '1440,375').split(',').map((w) => [w.trim(), Number(w)]);
for (const [size, width] of sizes) {
  for (const theme of ['light', 'dark']) {
    const { ctx, page } = await open(width, theme);

    const fit = cardWith(page, 'fit-panel');
    await fit.waitFor({ timeout: 20_000 });
    await fit.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await fit.screenshot({ path: resolve(out, `fit-panel-${size}-${theme}.png`) });

    // The same panel with the arithmetic opened, which is where the weights
    // and the per-part sentences live.
    await page.getByRole('button', { name: /how the overall number was reached/i }).click();
    await page.waitForTimeout(300);
    await fit.screenshot({ path: resolve(out, `fit-components-${size}-${theme}.png`) });

    const comparison = cardWith(page, 'fit-vs-interview');
    if (await comparison.count()) {
      await comparison.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await comparison.screenshot({ path: resolve(out, `fit-vs-interview-${size}-${theme}.png`) });
    } else {
      console.warn(`No comparison panel at ${size}/${theme} — is there an assessment for this candidate?`);
    }

    await ctx.close();
  }
}

await browser.close();
console.log(`Wrote screenshots to ${out}`);
