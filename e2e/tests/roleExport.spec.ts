import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { approveRoleIfNeeded, createRoleThroughUi, roleTitle, runId } from './helpers';

/**
 * Downloading the approved scorecard as a PDF.
 *
 * The export exists to be filed, printed or forwarded — it outlives the screen
 * it came from — so the thing worth testing is not that a request succeeds but
 * that only a signed-off scorecard can become one of these documents, and that
 * what lands on disk really is a PDF rather than an error page wearing a `.pdf`
 * name (the failure mode `api.download` was written to prevent).
 */

const roleIdFromUrl = (url: string) => {
  const id = new URL(url).pathname.split('/').filter(Boolean).pop();
  if (!id) throw new Error(`Could not read a role id out of ${url}`);
  return id;
};

test('offers no download until the scorecard is approved, and the API refuses a draft', async ({ page }) => {
  const title = roleTitle(runId());
  const roleUrl = await createRoleThroughUi(page, title);

  // A fresh role's scorecard is a draft: nobody has signed anything off, so
  // there is nothing to export and no button to press.
  await expect(page.getByTestId('download-scorecard-pdf')).toHaveCount(0);

  // The hidden button is a courtesy, not the gate. The route itself refuses.
  const refused = await page.request.get(`/api/roles/${roleIdFromUrl(roleUrl)}/export.pdf`);
  expect(refused.status()).toBe(409);
  const body = await refused.json();
  expect(body.code).toBe('scorecard_not_approved');
  expect(refused.headers()['content-type']).toContain('application/json');

  await approveRoleIfNeeded(page);
  await expect(page.getByTestId('download-scorecard-pdf')).toBeVisible();
});

test('downloads the approved scorecard as a real PDF file', async ({ page }) => {
  const title = roleTitle(runId());
  await createRoleThroughUi(page, title);
  await approveRoleIfNeeded(page);

  const button = page.getByTestId('download-scorecard-pdf');
  await expect(button).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await button.click();
  const download = await downloadPromise;

  // The name comes from the server's Content-Disposition, not the page's guess.
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  expect(download.suggestedFilename()).toContain('scorecard-v1');

  // Bytes, not status codes: a JSON refusal saved under a .pdf name would pass
  // every assertion above and open to nothing.
  const path = await download.path();
  expect(path).toBeTruthy();
  const bytes = readFileSync(path!);
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');
  expect(bytes.byteLength).toBeGreaterThan(1000);

  // The button returns to its resting state rather than staying "Preparing…".
  await expect(button).toBeEnabled();
  await expect(button).toHaveText(/Download PDF/);
});
