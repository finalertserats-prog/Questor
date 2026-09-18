import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { dismissTour } from './helpers';

const screenshotPath = resolve(import.meta.dirname, '../test-results/admin-health.png');

/**
 * The Admin page must answer "is anything wrong?" before anything else on it.
 *
 * The signed-in user is the demo admin (demo@questor.local) and the dev server
 * sets SIGNUP_APPROVER_EMAIL=approver@questor.local, so this user is NOT the
 * deployment operator: they see their own organisation's checks and none of
 * the deployment's. That split is the point of the assertions below.
 */
test('the admin page leads with system health', async ({ page }) => {
  await page.goto('/admin');
  await dismissTour(page);

  const panel = page.getByRole('region', { name: 'System health' });
  await expect(panel.getByRole('heading', { level: 2, name: 'System health' })).toBeVisible();

  // The overall state in words, not only a colour.
  const overall = panel.locator('.health-overall');
  await expect(overall).toHaveText(/All systems healthy|\d+ warnings?|\d+ problems? needs? attention/, { timeout: 20_000 });

  // Their own organisation, and not the deployment.
  await expect(panel.getByRole('heading', { level: 3, name: 'Your organisation' })).toBeVisible();
  await expect(panel.getByRole('heading', { level: 3, name: 'Backups' })).toHaveCount(0);
  await expect(panel.getByRole('heading', { level: 3, name: 'Platform' })).toHaveCount(0);

  const panelText = await panel.innerText();
  expect(panelText).not.toMatch(/\bundefined\b|\bNaN\b/);
  // No deployment setting or address leaks into a tenant admin's view.
  expect(panelText).not.toContain('approver@questor.local');

  await page.screenshot({ path: screenshotPath, fullPage: true });
});
