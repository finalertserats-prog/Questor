import { expect, test } from '@playwright/test';
import { assertNoMicrophoneRequest, createRoleAndCandidate, runId } from './helpers';

test('portal consent without voice capture starts typed mode and never asks for microphone', async ({ browser, page }) => {
  const id = runId();
  const { name } = await createRoleAndCandidate(page, id);

  await page.getByRole('tab', { name: 'Candidate Journey' }).click();
  await page.getByRole('button', { name: /Approve & create interview/ }).click();
  await expect(page.getByRole('heading', { name: 'Interview' })).toBeVisible({ timeout: 20_000 });

  if (await page.getByRole('button', { name: /Send invitation/ }).isVisible({ timeout: 1000 }).catch(() => false)) {
    await page.getByRole('button', { name: /Send invitation/ }).click();
    await expect(page.getByText('Invitation created.')).toBeVisible();
  }

  const portalInput = page.locator('label:text("Candidate portal link")').locator('xpath=following-sibling::*//input').first();
  await expect(portalInput).toHaveValue(/\/portal\//);
  const portalUrl = await portalInput.inputValue();

  const context = await browser.newContext();
  const portalPage = await context.newPage();
  await assertNoMicrophoneRequest(context, portalPage);
  await portalPage.goto(portalUrl);
  await expect(portalPage.getByText(name)).toBeVisible();
  await portalPage.getByRole('button', { name: /Continue/ }).click();

  // Leave the voice-capture consent unticked, and accept only the AI/human-review consent.
  await portalPage.getByLabel(/I understand this first round/).check();
  await portalPage.getByRole('button', { name: /I consent/ }).click();
  await expect(portalPage.getByRole('heading', { name: 'Quick audio check' })).toBeVisible();
  await portalPage.getByRole('button', { name: /Continue anyway/ }).click();
  await expect(portalPage.getByRole('button', { name: /Join interview/ })).toBeVisible();
  await portalPage.getByRole('button', { name: /Join interview/ }).click();
  await expect(portalPage.getByPlaceholder(/Type your answer/)).toBeVisible({ timeout: 20_000 });
  await expect(portalPage.getByRole('button', { name: /^Type$/ })).toHaveCount(0);
  await expect(portalPage.getByRole('button', { name: /^Voice$/ })).toHaveCount(0);
  await expect.poll(() => portalPage.evaluate(() => (window as unknown as { __e2eGetUserMediaCalls?: number }).__e2eGetUserMediaCalls ?? 0)).toBe(0);
  await context.close();
});