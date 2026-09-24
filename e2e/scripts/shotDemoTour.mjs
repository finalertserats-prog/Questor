// Every beat of the guided demo, at desktop and phone width, in both themes,
// against the running dev server. One sandbox is minted and its session is
// shared across the four contexts. Usage: node e2e/scripts/shotDemoTour.mjs <outDir>
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const out = resolve(process.argv[2] ?? '.');
const base = process.env.QUESTOR_BASE_URL ?? 'http://localhost:5173';
const root = resolve(import.meta.dirname, '../..');
mkdirSync(out, { recursive: true });

const token = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'e2e/scripts/makeDemoLink.ts'], {
  cwd: root, env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'file:./data/questor.db' },
}).toString().trim().split(/\r?\n/).pop();

const browser = await chromium.launch();
const redeem = await browser.newContext({ baseURL: base });
const first = await redeem.newPage();
await first.goto(`/demo/${token}`);
await first.getByRole('button', { name: 'Start demo' }).click();
await first.getByTestId('demo-start-card').waitFor();
const session = await redeem.storageState();
await redeem.close();

for (const [name, width, height] of [['desktop', 1440, 900], ['phone', 375, 812]]) {
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ baseURL: base, viewport: { width, height }, storageState: session, isMobile: width < 600 });
    await ctx.addInitScript((t) => { localStorage.setItem('questor-theme', t); sessionStorage.removeItem('questor-demo-tour-seen'); }, theme);
    const page = await ctx.newPage();
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.getByTestId('demo-start-card').waitFor();
    await page.screenshot({ path: resolve(out, `B00-start-${name}-${theme}.png`) });
    await page.getByTestId('demo-start').click();
    for (let guard = 0; guard < 25; guard += 1) {
      const tour = page.getByTestId('demo-tour');
      if (await tour.count() === 0) break;
      const beat = await tour.getAttribute('data-beat');
      await page.keyboard.press('Space');
      await page.getByRole('button', { name: /Resume/ }).waitFor();
      // The spotlight settles once the page has scrolled to its element.
      await page.waitForTimeout(600);
      await page.screenshot({ path: resolve(out, `${beat}-${name}-${theme}.png`) });
      await page.getByTestId('demo-next').click();
      await page.waitForTimeout(300);
    }
    await ctx.close();
  }
}
await browser.close();
console.log(`screenshots in ${out}`);
