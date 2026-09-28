import { expect, test } from '@playwright/test';
import { dismissTour } from './helpers';

// HR-Box: the landing page opens on Home (what needs you), Dashboard is a
// sub-tab, the choice can be linked, and the bell leads back to Home.

test('the landing page opens on Home and switches to the Dashboard tab', async ({ page }) => {
  await page.goto('/?tab=home');
  await dismissTour(page);
  const tabs = page.getByRole('tablist', { name: 'Home and dashboard' });
  await expect(tabs.getByRole('tab', { name: 'Home' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { level: 2, name: /What needs you/ })).toBeVisible();
  await expect(page.getByTestId('needs-you-loading')).toHaveCount(0, { timeout: 20_000 });

  await tabs.getByRole('tab', { name: 'Home' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/tab=dashboard/);
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
});

test('the bell opens Home from anywhere', async ({ page }) => {
  // The first-run tour starts on the landing page and opens its Dashboard tab;
  // a returning user has finished it.
  await page.goto('/candidates');
  const csrf = (await page.context().cookies()).find((c) => c.name === 'questor_csrf');
  await page.request.post('/api/auth/tour/complete', { headers: csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf.value) } : {} });
  await page.goto('/candidates');
  await page.getByTestId('needs-you-bell').filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/\?tab=home$/);
  await expect(page.getByRole('tab', { name: 'Home' })).toHaveAttribute('aria-selected', 'true');
});

test('Home does not scroll sideways on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/?tab=home');
  await dismissTour(page);
  await expect(page.getByTestId('needs-you-loading')).toHaveCount(0, { timeout: 20_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
