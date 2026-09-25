// One-off visual check of the Admin console's Analytics tab — the outcome
// statistics — against the running dev server, reusing the e2e session.
// Usage: node e2e/scripts/shotOutcomes.mjs <outDir>
//
// Reports the page's horizontal overflow per capture, because the one thing a
// dense table of rates breaks first on a phone is the width of the document.
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';

const out = process.argv[2] ?? '.';
const base = process.env.SHOT_BASE ?? 'http://localhost:5173';
const state = resolve(import.meta.dirname, '../.auth/recruiter.json');

const browser = await chromium.launch();
for (const [name, width] of [['1440', 1440], ['375', 375]]) {
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 2, storageState: state });
    await ctx.addInitScript((t) => {
      try { localStorage.setItem('questor-theme', t); } catch { /* private mode */ }
      document.documentElement.setAttribute('data-theme', t);
    }, theme);
    const page = await ctx.newPage();
    await page.goto(`${base}/admin/analytics`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.report-section', { timeout: 20_000 });
    await page.waitForTimeout(800);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const file = resolve(out, `admin-analytics-${name}-${theme}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`${file}  (horizontal overflow: ${overflow}px)`);
    await ctx.close();
  }
}
await browser.close();
