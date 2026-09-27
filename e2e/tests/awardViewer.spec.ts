import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dismissTour, runId } from './helpers';

/**
 * The credential viewer, in a real browser.
 *
 * The owner's complaint was that Badge and Certificate saved files instead of
 * showing anything. These tests press the buttons the way a person does and
 * check what appears: a dialog with the badge or the certificate in it, and
 * inside that dialog a download that really is the file, a verification link
 * that really lands on the clipboard, and a send that the row then reports.
 */

function seedAwardHolder(id: string): string {
  const root = resolve(import.meta.dirname, '../..');
  const out = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'e2e/scripts/seedAwards.ts', id], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'file:./data/questor.db' },
    encoding: 'utf8',
  });
  const path = /\/candidates\/\S+/.exec(out)?.[0];
  if (!path) throw new Error(`seedAwards.ts printed no candidate path: ${out}`);
  return path;
}

async function openJourney(page: Page, candidatePath: string) {
  await page.goto(candidatePath);
  await dismissTour(page);
  await page.getByRole('tab', { name: /journey/i }).click();
  await expect(page.getByRole('heading', { name: 'Badges and certificates' })).toBeVisible();
}

test('Badge opens the badge in a dialog, and Download saves the SVG that was shown', async ({ page }, info) => {
  const candidatePath = seedAwardHolder(runId());
  await openJourney(page, candidatePath);
  const silver = page.locator('.award-row').filter({ hasText: 'Silver' });

  await silver.getByRole('button', { name: 'Badge' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: /silver badge/i })).toBeVisible();
  const image = dialog.getByRole('img', { name: 'Silver badge' });
  await expect(image).toBeVisible();
  // Rendered, not a broken-image icon: the browser decoded real SVG.
  expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath('badge-dialog.png') });

  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^questor-silver-QS-SLV-.*\.svg$/);
  const bytes = readFileSync((await download.path()) as string, 'utf8');
  expect(bytes).toContain('<svg');
  // Still open: downloading is something you do from the viewer, not a way out of it.
  await expect(dialog).toBeVisible();
});

test('Copy verification link puts the public /v/ link on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const candidatePath = seedAwardHolder(runId());
  await openJourney(page, candidatePath);
  await page.locator('.award-row').filter({ hasText: 'Silver' }).getByRole('button', { name: 'Badge' }).click();
  const dialog = page.getByRole('dialog');

  await dialog.getByRole('button', { name: 'Copy verification link' }).click();

  await expect(dialog.getByRole('status')).toHaveText(/copied/i);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/^https?:\/\/[^/]+\/v\/[A-Za-z0-9_-]{20,}$/);
});

test('Certificate opens the certificate, offers it in a new tab, and Download saves a real PDF', async ({ page }, info) => {
  const candidatePath = seedAwardHolder(runId());
  await openJourney(page, candidatePath);

  await page.locator('.award-row').filter({ hasText: 'Silver' }).getByRole('button', { name: 'Certificate' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: /silver certificate/i })).toBeVisible();
  const openInTab = dialog.getByRole('link', { name: 'Open in a new tab' });
  await expect(openInTab).toBeVisible();
  expect(await openInTab.getAttribute('href')).toMatch(/^blob:/);
  await page.screenshot({ path: info.outputPath('certificate-dialog.png') });

  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^questor-silver-QS-SLV-.*\.pdf$/);
  const head = readFileSync((await download.path()) as string).subarray(0, 5).toString('latin1');
  expect(head).toBe('%PDF-');
});

test('Escape closes the viewer and puts focus back on the button that opened it', async ({ page }) => {
  const candidatePath = seedAwardHolder(runId());
  await openJourney(page, candidatePath);
  const button = page.locator('.award-row').filter({ hasText: 'Silver' }).getByRole('button', { name: 'Badge' });
  await button.click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.keyboard.press('Escape');

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(button).toBeFocused();
});

test('an admin sends the Silver certificate once, after confirming, and the row says so', async ({ page }) => {
  const candidatePath = seedAwardHolder(runId());
  await openJourney(page, candidatePath);
  const silver = page.locator('.award-row').filter({ hasText: 'Silver' });
  await silver.getByRole('button', { name: 'Certificate' }).click();
  const dialog = page.getByRole('dialog');

  await dialog.getByRole('button', { name: 'Send to candidate' }).click();
  await expect(dialog.getByText(/Email this certificate to/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Yes, send it' }).click();

  await expect(dialog.getByText(/Sent to the candidate on/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Send to candidate' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(silver).toContainText('sent to candidate');

  // Bronze is the hiring team's and is never sent: no button, and it says why.
  await page.locator('.award-row').filter({ hasText: 'Bronze' }).getByRole('button', { name: 'Certificate' }).click();
  await expect(page.getByRole('dialog').getByText(/held by the hiring team/)).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Send to candidate' })).toHaveCount(0);
});
