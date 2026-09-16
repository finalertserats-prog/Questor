import { expect, test } from '@playwright/test';
import { dismissTour } from './helpers';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test.use({ storageState: { cookies: [], origins: [] } });

function readDemoPassword(): string {
  const seedSource = readFileSync(resolve(import.meta.dirname, '../../server/src/seed/demoData.ts'), 'utf8');
  const match = seedSource.match(/const password\s*=\s*'([^']+)'/);
  if (!match) throw new Error('Could not read demo password from seed source.');
  return match[1];
}

test('organisation picker and UI sign-in reach the dashboard', async ({ page }) => {
  await page.goto('/login');
  const org = page.getByRole('combobox', { name: 'Your organisation' });
  await org.fill('acm');
  await expect(page.getByRole('option', { name: /Acme Corp/ })).toBeVisible();
  await org.press('Enter');
  await expect(page).toHaveURL(/\/o\/acme$/);
  await expect(page.getByRole('heading', { name: 'Acme Corp' })).toBeVisible();
  await page.getByLabel('Email').fill('demo@questor.local');
  await page.getByLabel('Password').fill(readDemoPassword());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await dismissTour(page);
});