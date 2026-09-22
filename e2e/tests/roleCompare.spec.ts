import { expect, test } from '@playwright/test';
import { addCandidateThroughUi, approveRoleIfNeeded, createRoleThroughUi, dismissTour, runId, roleTitle } from './helpers';

/**
 * Comparing this role's candidates from the role page.
 *
 * The role page used to list no candidates at all, so putting two people
 * beside each other meant two separate pages. This drives the whole path a
 * hiring manager takes: see who has applied, order them, tick two, and read
 * them side by side.
 */

test.describe.configure({ mode: 'serial' });

test('lists, sorts, shortlists and compares the candidates on a role', async ({ page }) => {
  const id = runId();
  const title = roleTitle(id);
  await createRoleThroughUi(page, title);
  await approveRoleIfNeeded(page);
  const roleUrl = page.url();

  const first = `E2E Ada ${id}`;
  const second = `E2E Grace ${id}`;
  await addCandidateThroughUi(page, title, first, `e2e-ada-${id}@example.test`);
  await addCandidateThroughUi(page, title, second, `e2e-grace-${id}@example.test`);

  await page.goto(roleUrl);
  await dismissTour(page);

  // 1. The role page now says who has applied.
  const section = page.getByRole('region', { name: 'Candidates on this role' })
    .or(page.locator('section[aria-label="Candidates on this role"]'));
  await expect(section.getByRole('heading', { name: 'Candidates on this role' })).toBeVisible();
  await expect(page.getByRole('link', { name: first })).toBeVisible();
  await expect(page.getByRole('link', { name: second })).toBeVisible();

  // 2. The order is a server query: the column heading is a control, and the
  //    address carries the answer so a link returns to the same order.
  await page.getByRole('columnheader').getByRole('button', { name: /^Candidate/ }).click();
  await expect(page).toHaveURL(/sort=name/);
  await expect(page.locator('th[aria-sort="ascending"]')).toBeVisible();

  // 3. Two ticks make a comparison.
  const compare = page.getByTestId('compare-button');
  await expect(compare).toBeDisabled();
  // Clicked rather than checked: the tick is stored on the server before the
  // box changes, so its state follows the response rather than the click.
  await page.getByLabel(`Shortlist ${first}`).click();
  await expect(page.getByLabel(`Shortlist ${first}`)).toBeChecked();
  await expect(page.getByText('Tick one more to compare them side by side.')).toBeVisible();
  await page.getByLabel(`Shortlist ${second}`).click();
  await expect(page.getByLabel(`Shortlist ${second}`)).toBeChecked();
  await expect(compare).toBeEnabled();
  await compare.click();

  // 4. Side by side: a column each, the competencies down the side.
  const sideBySide = page.locator('section[aria-label="Candidates side by side"]');
  await expect(sideBySide).toBeVisible();
  await expect(sideBySide.getByRole('columnheader', { name: new RegExp(first) })).toBeVisible();
  await expect(sideBySide.getByRole('columnheader', { name: new RegExp(second) })).toBeVisible();
  await expect(sideBySide.getByRole('rowheader', { name: /Verdict and score/ })).toBeVisible();
  // Nobody has interviewed yet, so the page says what it does not hold rather
  // than leaving an empty row to be read as "available now".
  await expect(sideBySide.getByText('Nothing booked').first()).toBeVisible();
  await sideBySide.getByRole('button', { name: 'Close' }).click();
  await expect(sideBySide).toBeHidden();

  // 5. The skills grid: competencies across, candidates down, and a
  //    competency with nothing behind it said in words rather than as a zero.
  await page.getByRole('button', { name: 'Skills grid' }).click();
  await expect(page).toHaveURL(/view=grid/);
  const grid = page.getByRole('region', { name: 'Skills across candidates' });
  await expect(grid).toBeVisible();
  await expect(grid.getByRole('rowheader', { name: new RegExp(first) })).toBeVisible();
  await expect(grid.getByText('Not assessed').first()).toBeVisible();
  // Never a zero where a level would be: an ungraded competency is words.
  await expect(grid.getByText('0', { exact: true })).toHaveCount(0);

  // 6. The shortlist is stored, not held in the page.
  await page.reload();
  await dismissTour(page);
  await page.getByRole('button', { name: 'Table' }).click();
  await expect(page.getByLabel(`Shortlist ${first}`)).toBeChecked();
});
