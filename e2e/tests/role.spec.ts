import { expect, test } from '@playwright/test';
import { createRoleThroughUi, runId, roleTitle } from './helpers';

test('creates a role from typed JD and persists scorecard edits', async ({ page }) => {
  const flag = `E2E red flag ${runId()}`;
  const title = roleTitle(runId());
  await createRoleThroughUi(page, title);

  await page.getByLabel('Pass threshold').fill('70');
  await page.getByLabel('Add a red flag').fill(flag);
  await page.getByRole('button', { name: /^Add$/ }).click();
  await expect(page.getByText(flag)).toBeVisible();
  await page.getByRole('button', { name: /^Save changes$/ }).click();
  await expect(page.getByText('Changes saved.')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByLabel('Pass threshold')).toHaveValue('70');
  await expect(page.getByText(flag)).toBeVisible();
});