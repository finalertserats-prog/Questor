// Screenshots of the role page's candidate comparison against the running dev
// server, reusing the e2e session.
//   node e2e/scripts/shotCompare.mjs <roleId> <outDir>
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const roleId = process.argv[2];
const out = process.argv[3] ?? '.';
if (!roleId) throw new Error('Usage: node e2e/scripts/shotCompare.mjs <roleId> <outDir>');
mkdirSync(out, { recursive: true });

const state = resolve(import.meta.dirname, '../.auth/recruiter.json');
const browser = await chromium.launch();

async function open(width, theme, url) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 }, storageState: state });
  await ctx.addInitScript((t) => { localStorage.setItem('questor-theme', t); }, theme);
  const page = await ctx.newPage();
  await page.goto(`http://localhost:5173${url}`, { waitUntil: 'networkidle' });
  const skip = page.getByRole('button', { name: /skip tour/i });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  return { ctx, page };
}

const section = (page) => page.locator('section[aria-label="Candidates on this role"]');

for (const [size, width] of [['1440', 1440], ['375', 375]]) {
  for (const theme of ['light', 'dark']) {
    // 1. The candidates table.
    {
      const { ctx, page } = await open(width, theme, `/roles/${roleId}`);
      await section(page).scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await section(page).screenshot({ path: resolve(out, `candidates-table-${size}-${theme}.png`) });
      await ctx.close();
    }

    // 2. The skills grid.
    {
      const { ctx, page } = await open(width, theme, `/roles/${roleId}?view=grid`);
      await section(page).scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await section(page).screenshot({ path: resolve(out, `skills-grid-${size}-${theme}.png`) });
      await ctx.close();
    }

    // 3. The side-by-side, after shortlisting three people.
    {
      const { ctx, page } = await open(width, theme, `/roles/${roleId}`);
      await section(page).scrollIntoViewIfNeeded();
      for (const name of ['Ada Lovelace', 'Grace Hopper', 'Katherine Johnson']) {
        const box = page.getByLabel(`Shortlist ${name}`);
        if (!await box.isChecked().catch(() => false)) {
          await box.click();
          await page.waitForTimeout(350);
        }
      }
      await page.getByTestId('compare-button').click();
      const sbs = page.locator('section[aria-label="Candidates side by side"]');
      await sbs.waitFor();
      await page.waitForTimeout(600);
      await sbs.screenshot({ path: resolve(out, `side-by-side-${size}-${theme}.png`) });
      await ctx.close();
    }
  }
}

await browser.close();
console.log(`Wrote screenshots to ${out}`);
