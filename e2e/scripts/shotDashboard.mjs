// One-off visual check of the dashboard's role charts against the running dev
// server, reusing the e2e session. Usage: node e2e/scripts/shotDashboard.mjs <outDir>
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';

const out = process.argv[2] ?? '.';
const state = resolve(import.meta.dirname, '../.auth/recruiter.json');
const browser = await chromium.launch();
for (const [name, width] of [['desktop', 1440], ['laptop', 1280], ['phone', 390]]) {
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, storageState: state });
    await ctx.addInitScript((t) => { localStorage.setItem('questor-theme', t); }, theme);
    const page = await ctx.newPage();
    await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
    const skip = page.getByRole('button', { name: /skip tour/i });
    if (await skip.isVisible().catch(() => false)) await skip.click();
    const chart = page.getByRole('heading', { name: /Top roles by candidates/ }).locator('xpath=ancestor::div[contains(@class,"card")][1]/..');
    await chart.scrollIntoViewIfNeeded();
    await chart.screenshot({ path: resolve(out, `roles-charts-${name}-${theme}.png`) });
    await page.screenshot({ path: resolve(out, `dashboard-full-${name}-${theme}.png`), fullPage: true });
    await ctx.close();
  }
}
await browser.close();
