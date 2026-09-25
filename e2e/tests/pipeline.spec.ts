import { expect, test, type Page } from '@playwright/test';
import { createRoleAndCandidate, runId } from './helpers';

/**
 * How far the candidate journey moves on its own, and where it stops.
 *
 * Adding a candidate with their resume analysed puts them at Bronze. Nothing
 * carries them past it: booking their interview does not, and neither does
 * assessing it, because a tier is struck by the person who promotes a
 * candidate out of it (domain/pipelineAutonomy.ts). The Platinum stage no
 * longer exists anywhere on the page.
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

test('creating an interview leaves the candidate at Bronze: the move is a person\u2019s', async ({ page }) => {
  const id = runId();
  const { candidateUrl } = await createRoleAndCandidate(page, id);
  await openJourney(page);
  await page.getByRole('button', { name: 'Approve & create interview' }).click();
  await expect(page.getByRole('heading', { name: 'Interview plan', exact: true })).toBeVisible({ timeout: 20_000 });

  await page.goto(candidateUrl);
  const track = await openJourney(page);

  await expect(track.locator('.pipeline-stage.stage-current')).toContainText('Bronze');
});
