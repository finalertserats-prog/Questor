import { expect, test } from '@playwright/test';
import { createRoleAndCandidate, runId } from './helpers';

test('adds a candidate with pasted resume and opens them from the list', async ({ page }) => {
  const id = runId();
  const { name } = await createRoleAndCandidate(page, id);

  await page.goto('/candidates');
  await expect(page.getByRole('columnheader', { name: /Resume fit/ })).toBeVisible();
  await page.getByLabel('Filter candidates').fill(name);
  await page.getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
});