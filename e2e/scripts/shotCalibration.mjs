// One-off visual check of the Admin console's Calibration tab against the
// running dev server, reusing the e2e session.
// Usage: node e2e/scripts/shotCalibration.mjs <outDir>
//
// Reports the page's horizontal overflow per capture: a row of statistics and
// a column of provenance sentences are exactly what breaks a phone's width.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const out = process.argv[2] ?? '.';
const base = process.env.SHOT_BASE ?? 'http://localhost:5173';

// Signs in itself rather than reusing the suite's stored session, so a
// screenshot can be taken without running the whole Playwright suite first.
function demoPassword() {
  const seed = readFileSync(resolve(import.meta.dirname, '../../server/src/seed/demoData.ts'), 'utf8');
  const match = seed.match(/const password\s*=\s*'([^']+)'/);
  if (!match) throw new Error('Could not read the demo password from the seed source.');
  return match[1];
}

const browser = await chromium.launch();

const signIn = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const login = await signIn.newPage();
await login.goto(`${base}/o/acme`, { waitUntil: 'networkidle' });
await login.getByLabel('Email').fill('demo@questor.local');
await login.getByLabel('Password').fill(demoPassword());
await login.getByRole('button', { name: 'Sign in' }).click();
await login.waitForURL((url) => !url.pathname.startsWith('/o/'), { timeout: 20_000 });
const state = await signIn.storageState();
await signIn.close();

for (const [name, width] of [['1440', 1440], ['375', 375]]) {
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 2, storageState: state });
    await ctx.addInitScript((t) => {
      try { localStorage.setItem('questor-theme', t); } catch { /* private mode */ }
      document.documentElement.setAttribute('data-theme', t);
    }, theme);
    const page = await ctx.newPage();
    await page.goto(`${base}/admin/calibration`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.calib', { timeout: 20_000 });
    await page.waitForTimeout(800);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const file = resolve(out, `admin-calibration-${name}-${theme}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`${file}  (horizontal overflow: ${overflow}px)`);
    await ctx.close();
  }
}
await browser.close();
