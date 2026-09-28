
import { expect, test } from '@playwright/test';
import { dismissTour } from './helpers';

test('uses a suggested catalog job description to create a role', async ({ page }) => {
  await page.goto('/roles/new');
  await dismissTour(page);
  await page.getByLabel('Domain', { exact: true }).selectOption({ index: 1 });
  await page.getByLabel('Experience', { exact: true }).selectOption({ index: 3 });
  await page.getByLabel('Region', { exact: true }).selectOption({ index: 1 });

  const titleBox = page.getByRole('combobox', { name: /Role title/ });
  await titleBox.fill('engineer');
  const listOption = page.getByRole('listbox').getByRole('option').first();
  await expect(listOption).toBeVisible({ timeout: 10_000 });
  await listOption.click();

  await expect(page.getByRole('heading', { name: 'Suggested job description' })).toBeVisible();
  await expect(page.getByText(/About the role/)).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Use this draft' }).click();
  const jd = page.getByRole('textbox', { name: 'Job description' });
  await expect(jd).toHaveValue(/About the role/);
  const text = await jd.inputValue();

  await page.getByRole('button', { name: /^Create role$/ }).click();
  const continueButton = page.getByRole('button', { name: /Continue to the role/ });
  if (await continueButton.isVisible({ timeout: 20_000 }).catch(() => false)) await continueButton.click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/engineer/i, { timeout: 20_000 });
  await expect(page.getByText(text.split('\n')[0]).first()).toBeVisible();
});
