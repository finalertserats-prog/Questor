import { expect, test } from '@playwright/test';
import { runId } from './helpers';

test.use({ storageState: { cookies: [], origins: [] } });

test('join-organisation signup request confirms nothing was created', async ({ page }) => {
  const id = runId();
  await page.goto('/signup');
  await page.getByLabel('Your name').fill(`E2E Signup ${id}`);
  await page.getByLabel('Email').fill(`signup-${id}@example.test`);
  await page.getByLabel('Password').fill(`long-enough-${id}`);
  await page.getByRole('radio', { name: /Join an organisation/ }).check();
  const org = page.getByRole('combobox', { name: 'Your organisation' });
  await org.fill('acm');
  await expect(page.getByRole('option', { name: /Acme Corp/ })).toBeVisible();
  await org.press('Enter');
  await expect(page.getByText('Acme Corp')).toBeVisible();
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByRole('heading', { name: 'Your request has been sent' })).toBeVisible();
  await expect(page.getByText(/Nothing has been created yet/)).toBeVisible();
});