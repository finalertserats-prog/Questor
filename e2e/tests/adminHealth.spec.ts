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

/**
 * The console is reached from the sidebar, where its health marker is seen from
 * every page, and is split into tabs so no section is found by scrolling.
 */
test('the sidebar leads to the console, and each section is its own tab', async ({ page }) => {
  await page.goto('/');
  await dismissTour(page);

  const adminLink = page.getByRole('navigation').getByRole('link', { name: /Admin console, System health: (Healthy|Watch|Problem|Unknown|Checking)/ });
  await expect(adminLink).toBeVisible();
  await adminLink.click();
  await expect(page).toHaveURL(/\/admin$/);

  const tabs = page.getByRole('tablist', { name: 'Admin console sections' });
  await expect(tabs.getByRole('tab', { name: /System health/ })).toHaveAttribute('aria-selected', 'true');

  await tabs.getByRole('tab', { name: 'Webhooks' }).click();
  await expect(page).toHaveURL(/\/admin\/webhooks$/);
  await expect(page.getByRole('tabpanel').getByRole('heading', { level: 2, name: 'Webhooks' })).toBeVisible();
  // One section at a time: the others are not on the page at all.
  await expect(page.getByRole('heading', { level: 2, name: 'System health' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: 'Connectors' })).toHaveCount(0);

  // Each tab has an address; an unknown one goes back to the console.
  await page.goto('/admin/connectors');
  await expect(page.getByRole('tabpanel').getByRole('heading', { level: 2, name: 'Connectors' })).toBeVisible();
  await page.goto('/admin/no-such-tab');
  await expect(page).toHaveURL(/\/admin$/);
});
