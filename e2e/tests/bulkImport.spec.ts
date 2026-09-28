import { expect, test } from '@playwright/test';
import { approveRoleIfNeeded, createRoleThroughUi, dismissTour, roleTitle, runId } from './helpers';

/**
 * Bulk import from the role page: a CSV becomes a preview, a row is fixed in
 * place, confirm adds everyone, and the result screen invites them through
 * bulk-invite.
 */

test('imports people from a CSV on the role page, fixes one, adds them and invites them', async ({ page }) => {
  test.setTimeout(120_000);
  const id = runId();
  const title = roleTitle(`${id} Bulk`);
  await createRoleThroughUi(page, title);
  await approveRoleIfNeeded(page);

  await page.getByTestId('bulk-import-link').click();
  await dismissTour(page);
  await expect(page.getByRole('heading', { name: 'Add candidates', exact: true })).toBeVisible();

  const csv = [
    'Full Name;E-mail;Phone',
    `Bulk One ${id};bulk1-${id}@example.test;+91 98765 43210`,
    `Bulk Two ${id};bulk2-${id}@example.test;`,
    `Bulk Three ${id};not-an-address;`,
  ].join('\n');
  await page.getByLabel('CSV file', { exact: true }).setInputFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Read the file' }).click();

  await expect(page.getByTestId('import-preview-summary')).toHaveText('2 ready to add · 1 needs a fix');
  const email = page.getByLabel('Email, row 3');
  await email.fill(`bulk3-${id}@example.test`);
  await email.press('Enter');
  await expect(page.getByTestId('import-preview-summary')).toHaveText('3 ready to add');

  await page.getByRole('button', { name: 'Add 3 people' }).click();
  await expect(page.getByTestId('import-result-summary')).toHaveText('3 added');
  await expect(page.getByRole('link', { name: `Bulk Three ${id}` })).toBeVisible();

  await page.getByRole('button', { name: 'Invite 3 selected' }).click();
  // The suite's email provider only logs, so the links are made but not emailed.
  await expect(page.getByText('Link created, but no email was sent', { exact: false })).toHaveCount(3, { timeout: 30_000 });
});
