// The transcript requirement as a reviewer meets it. Usage:
//   node e2e/scripts/shotReadGate.mjs <outDir> <assessmentId>
//
// Three states: before anything has been read, after the end of the
// transcript has been reached, and the audited "I read it elsewhere" control.
// The end control is reached and PRESSED by keyboard, not scrolled to, because
// that is the path that has to work for a keyboard or screen-reader user.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// One assessment per capture: a recorded read persists, so the second pass
// over the same one would open on "you have read this".
const [out = '.', idList = ''] = process.argv.slice(2);
const ids = idList.split(',').filter(Boolean);
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

let pass = 0;
for (const [width, widthName] of [[1440, '1440'], [375, '375']]) {
  for (const theme of ['light', 'dark']) {
    // Two per pass: a recorded read persists, so the "elsewhere" capture
    // cannot reuse the one the before/after capture has already read.
    const assessmentId = ids[pass * 2];
    const unreadId = ids[pass * 2 + 1];
    pass += 1;
    if (!assessmentId || !unreadId) throw new Error(`Give two assessment ids per capture: ${ids.length} given, 8 needed.`);
    const ctx = await browser.newContext({ viewport: { width, height: 1100 }, deviceScaleFactor: 2, storageState: state });
    await ctx.addInitScript((t) => {
      try { localStorage.setItem('questor-theme', t); } catch { /* private mode */ }
      document.documentElement.setAttribute('data-theme', t);
    }, theme);
    const page = await ctx.newPage();

    await page.goto(`${base}/assessments/${assessmentId}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="transcript-read-note"]', { timeout: 30_000 });
    await shot(page, 'read-gate-before', widthName, theme);

    // The audited alternative, opened but not taken.
    //
    // Captured with the transcript held back, which is the state it exists
    // for: a reviewer who cannot read it here still has a way through, and
    // the page must not auto-record a read of something it never showed.
    await page.route('**/api/interviews/*/transcript', (route) => route.abort());
    await page.goto(`${base}/assessments/${unreadId}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="read-elsewhere"]', { timeout: 30_000 });
    // The transcript's own failure re-renders the column; let that settle
    // before pressing anything, or the summary is detached mid-click.
    await page.waitForTimeout(1200);
    await page.getByTestId('read-elsewhere').locator('summary').click();
    await page.getByTestId('read-attestation').fill('Read the exported transcript in the hiring pack before opening this page.');
    await page.getByTestId('read-attestation').scrollIntoViewIfNeeded();
    await shot(page, 'read-elsewhere', widthName, theme);

    // And the way a keyboard user meets the requirement: focus the end.
    await page.unroute('**/api/interviews/*/transcript');
    await page.goto(`${base}/assessments/${assessmentId}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="transcript-end"]', { timeout: 30_000 });
    await page.getByTestId('transcript-end').focus();
    await page.getByTestId('transcript-end').press('Enter');
    await page.waitForFunction(
      () => (document.querySelector('[data-testid="transcript-read-note"]')?.textContent ?? '').includes('You have read'),
      undefined,
      { timeout: 30_000 },
    );
    await shot(page, 'read-gate-after', widthName, theme);

    await ctx.close();
  }
}

await browser.close();
