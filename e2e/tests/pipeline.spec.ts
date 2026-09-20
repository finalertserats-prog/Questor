import { expect, test, type Page } from '@playwright/test';
import { createRoleAndCandidate, runId } from './helpers';

/**
 * The candidate journey moves on its own: adding a candidate (with their
 * resume analysed) puts them at Bronze, creating their interview puts them at
 * Silver, and the Platinum stage no longer exists anywhere on the page.
 */

async function openJourney(page: Page) {
  await page.getByRole('tab', { name: 'Candidate journey' }).click();
  const track = page.locator('.stage-track');
  await expect(track).toBeVisible({ timeout: 20_000 });
  return track;
}

test('a newly added candidate is at Bronze on the five-stage pipeline', async ({ page }) => {
  const id = runId();
  await createRoleAndCandidate(page, id);

  const track = await openJourney(page);

  await expect(track.locator('.pipeline-stage')).toHaveCount(5);
  await expect(track).not.toContainText('Platinum');
  await expect(track.locator('.pipeline-stage.stage-current')).toContainText('Bronze');
});

test('creating an interview moves the candidate to Silver', async ({ page }) => {
  const id = runId();
  const { candidateUrl } = await createRoleAndCandidate(page, id);
  await openJourney(page);
  await page.getByRole('button', { name: 'Approve & create interview' }).click();
  await expect(page.getByRole('heading', { name: 'Interview', exact: true })).toBeVisible({ timeout: 20_000 });

  await page.goto(candidateUrl);
  const track = await openJourney(page);

  await expect(track.locator('.pipeline-stage.stage-current')).toContainText('Silver');
});
