// The blind-review states of the assessment page: the competency cards up
// front with the AI's own reading masked, and the same page once the reviewer
// has recorded their verdict. Usage:
//   node e2e/scripts/shotBlindParts.mjs <outDir> <blindAssessmentId> <openAssessmentId>
//
// Run it with the organisation's blind-review requirement switched on
// (e2e/scripts/blindPolicy.ts on). The second id is an assessment this
// reviewer has already been through, which is what "after" looks like.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [out = '.', blindId, afterId] = process.argv.slice(2);
const base = process.env.SHOT_BASE ?? 'http://localhost:5173';

async function signedInState(browser) {
  const seed = readFileSync(resolve(import.meta.dirname, '../../server/src/seed/demoData.ts'), 'utf8');
  const found = seed.match(/const password\s*=\s*'([^']+)'/);
  if (!found) throw new Error('Could not read the demo password from the seed source.');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${base}/o/acme`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill('demo@questor.local');
  await page.getByLabel('Password').fill(found[1]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForSelector('[role="tab"]', { timeout: 30_000 });
  const state = await ctx.storageState();
  await ctx.close();
  return state;
}

const browser = await chromium.launch();
const state = await signedInState(browser);

async function shot(page, name, width, theme) {
  await page.waitForTimeout(700);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const file = resolve(out, `${name}-${width}-${theme}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`${file}  (horizontal overflow: ${overflow}px)`);
}

for (const [width, widthName] of [[1440, '1440'], [375, '375']]) {
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width, height: 1100 }, deviceScaleFactor: 2, storageState: state });
    await ctx.addInitScript((t) => {
      try { localStorage.setItem('questor-theme', t); } catch { /* private mode */ }
      document.documentElement.setAttribute('data-theme', t);
    }, theme);
    const page = await ctx.newPage();

    // Before: the AI's opinion withheld, the competencies and their evidence
    // shown anyway, because those are facts the reviewer judges from.
    await page.goto(`${base}/assessments/${blindId}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="skills-masked-note"]', { timeout: 30_000 });
    await shot(page, 'blind-before', widthName, theme);
    await page.locator('[data-testid="skills-grid"]').scrollIntoViewIfNeeded();
    await shot(page, 'blind-masked-cards', widthName, theme);

    // After: the same page for an assessment this reviewer has been through.
    await page.goto(`${base}/assessments/${afterId}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="assessment-part-1"]', { timeout: 30_000 });
    await shot(page, 'blind-after', widthName, theme);

    await ctx.close();
  }
}

await browser.close();
