import { expect, test } from '@playwright/test';
import { createRoleThroughUi, dismissTour, runId, roleTitle } from './helpers';

test('lists Global first when creating a role and explains what it means', async ({ page }) => {
  await page.goto('/roles/new');
  await dismissTour(page);
  const region = page.getByLabel('Region', { exact: true });
  await expect(region.locator('option').nth(1)).toHaveText('Global (all regions)');

  await region.selectOption('GLOBAL');

  await expect(page.getByText(/Open in every region\./)).toBeVisible();
});

test('shows a Global role under a specific region and under Global', async ({ page }) => {
  const title = roleTitle(runId());
  // The helper picks the first region, which is Global.
  await createRoleThroughUi(page, title);
  await expect(page.getByText(/Region: Global/)).toBeVisible();

  await page.goto('/roles?region=IN');
  await dismissTour(page);
  await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();

  await page.goto('/roles?region=GLOBAL');
  await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
});
