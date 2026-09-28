import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { dismissTour, runId } from './helpers';

interface Seeded {
  readonly suffix: string;
  readonly domainName: string;
  readonly titles: { readonly edit: string; readonly reject: string; readonly bulkA: string; readonly bulkB: string; readonly alias: string };
}

// Letters only: a run of digits in a title is refused as a requisition or
// phone number, by the page and by the server alike.
function letterTag(): string {
  return runId().replace(/[0-9]/g, (digit) => 'abcdefghij'[Number(digit)]).replace(/[^a-z]/gi, '');
}

function seedQueue(): Seeded {
  const root = resolve(import.meta.dirname, '../..');
  const out = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'e2e/scripts/seedCatalogReview.ts', letterTag()], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'file:./data/questor.db' },
  }).toString().trim();
  return JSON.parse(out.split('\n').pop() ?? '{}') as Seeded;
}

test('the platform owner edits, approves, rejects and bulk-approves catalog proposals', async ({ page }) => {
  test.setTimeout(120_000);
  const seeded = seedQueue();
  const editedTitle = `E2E Catalog Approved ${seeded.suffix}`;

  await page.goto('/catalog-review');
  await dismissTour(page);
  await expect(page.getByRole('heading', { name: 'Catalog review', exact: true })).toBeVisible();

  // Only this run's proposals: earlier runs leave their own in the queue.
  const filters = page.getByRole('search', { name: 'Filter proposals' });
  await filters.getByRole('searchbox', { name: 'Search' }).fill(seeded.suffix);
  const rows = page.getByTestId('catalog-proposal-row');
  await expect(rows).toHaveCount(5);

  // Edit a title inline, then approve it.
  await page.getByRole('button', { name: `Edit ${seeded.titles.edit}` }).click();
  const editor = page.getByRole('form', { name: `Edit ${seeded.titles.edit}` });
  await editor.getByLabel('Title').fill(editedTitle);
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`Saved changes to "${editedTitle}".`)).toBeVisible();
  await page.getByRole('button', { name: `Approve ${editedTitle}` }).click();
  await expect(page.getByText(`Approved "${editedTitle}". It is now in the shared catalog.`)).toBeVisible();

  await page.getByRole('button', { name: `Reject ${seeded.titles.reject}` }).click();
  await expect(page.getByText(`Rejected "${seeded.titles.reject}".`)).toBeVisible();
  await expect(rows).toHaveCount(3);

  // Bulk approval asks once more before it runs.
  await page.getByRole('checkbox', { name: `Select ${seeded.titles.bulkA}` }).check();
  await page.getByRole('checkbox', { name: `Select ${seeded.titles.bulkB}` }).check();
  const bulkBar = page.getByRole('group', { name: 'Bulk actions' });
  await expect(bulkBar).toContainText('2 selected');
  await bulkBar.getByRole('button', { name: 'Approve selected' }).click();
  await bulkBar.getByRole('button', { name: 'Confirm approve' }).click();
  await expect(page.getByText('Approved 2 of 2.')).toBeVisible();
  await expect(rows).toHaveCount(1);

  // The approved title is now offered to every organisation creating a role.
  await page.goto('/roles/new');
  await dismissTour(page);
  await page.getByLabel('Domain', { exact: true }).selectOption({ label: seeded.domainName });
  await page.getByRole('combobox', { name: /Role title/ }).fill(editedTitle);
  await expect(page.getByRole('listbox').getByRole('option', { name: new RegExp(editedTitle) })).toBeVisible({ timeout: 15_000 });
});

test('the review page shows its data sources', async ({ page }) => {
  await page.goto('/catalog-review');
  await dismissTour(page);
  await expect(page.getByRole('region', { name: 'Catalog data sources' }).getByRole('link', { name: 'CC BY 4.0 license' })).toHaveAttribute('rel', 'noopener noreferrer');
});

test('the review page does not scroll sideways on a phone', async ({ page }) => {
  seedQueue();
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/catalog-review');
  await dismissTour(page);
  await expect(page.getByTestId('catalog-proposal-row').first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
