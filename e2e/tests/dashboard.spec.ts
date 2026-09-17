import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { dismissTour } from './helpers';

const screenshotPath = resolve(import.meta.dirname, '../test-results/dashboard.png');

test('dashboard renders its heading and real numbers', async ({ page }) => {
  await page.goto('/');
  await dismissTour(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();

  const kpis = page.getByRole('region', { name: 'Key metrics' }).getByRole('listitem');
  await expect(kpis.first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Loading metrics…')).toHaveCount(0);

  // Every tile leads with a figure: a count, or a duration such as "3.5 h" / "—".
  const tileCount = await kpis.count();
  expect(tileCount).toBeGreaterThan(0);
  for (let i = 0; i < tileCount; i += 1) {
    await expect(kpis.nth(i)).toContainText(/\d|—/);
  }

  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toMatch(/\bNaN\b/);
  expect(bodyText).not.toMatch(/\bundefined\b/);

  await page.screenshot({ path: screenshotPath, fullPage: true });
});
