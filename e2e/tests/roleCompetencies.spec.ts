import { expect, test } from '@playwright/test';
import { addCandidateThroughUi, approveRoleIfNeeded, createRoleThroughUi, runId } from './helpers';

/**
 * HR shapes the competencies on a role page: adds one (drafted from the JD),
 * removes a JD-suggested one, and sees the weights keep totalling 100%. The
 * dev server runs the built-in heuristic model, so the draft is deterministic.
 */

const totalText = /Scored weights total 100%/;

test('adds a drafted competency, removes a suggested one, and the weights still total 100%', async ({ page }) => {
  const title = `E2E Data Engineer ${runId()}`;
  await createRoleThroughUi(page, title);
  await expect(page.getByTestId('weights-total')).toHaveText(totalText);
  const before = await page.locator('tr.comp-row').count();

  await page.getByTestId('add-competency').click();
  await page.getByTestId('add-competency-name').fill('Vendor Management');
  await page.getByTestId('add-competency-draft').click();
  await expect(page.getByTestId('add-competency-definition')).not.toHaveValue('');
  await expect(page.getByTestId('add-competency-indicators')).not.toHaveValue('');
  await page.getByTestId('add-competency-save').click();
  await expect(page.getByText('Vendor Management added to the scorecard.')).toBeVisible();
  await expect(page.locator('tr.comp-row')).toHaveCount(before + 1);
  await expect(page.getByLabel('Name of competency Vendor Management')).toHaveValue('Vendor Management');
  await expect(page.getByTestId('weights-total')).toHaveText(totalText);

  // A JD-suggested competency goes too: no interview has used it, so it is deleted.
  const firstRow = page.locator('tr.comp-row').first();
  const firstName = await firstRow.locator('input[aria-label^="Name of competency"]').inputValue();
  await firstRow.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByTestId('competency-confirm')).toContainText(`Remove ${firstName}?`);
  await page.getByTestId('competency-confirm-yes').click();
  await expect(page.getByText(`${firstName} removed from the scorecard.`)).toBeVisible();
  await expect(page.locator('tr.comp-row')).toHaveCount(before);
  await expect(page.getByTestId('weights-total')).toHaveText(totalText);
});

test('rebalances the other weights as one is typed and shows the server warnings after saving', async ({ page }) => {
  const title = `E2E Data Engineer ${runId()}`;
  await createRoleThroughUi(page, title);
  const rows = page.locator('tr.comp-row');
  const count = await rows.count();
  expect(count).toBeGreaterThan(2);

  // Almost everything to the first competency: the rest scale down, the total holds.
  const firstWeight = rows.first().locator('input[type="number"]');
  await firstWeight.fill('90');
  await firstWeight.blur();
  await expect(page.getByTestId('weights-total')).toHaveText(totalText);
  await page.getByRole('button', { name: /^Save changes$/ }).click();
  await expect(page.getByText('Changes saved.')).toBeVisible();

  // The server's warnings come back with the saved scorecard. This JD yields
  // twelve scored competencies and the feedback letter shows eight at most,
  // so the letter warning is the one that must be on screen.
  await expect(page.getByTestId('scorecard-warnings')).toContainText('feedback letter');
});

test('an interview created before a competency change is flagged for re-planning once the new scorecard is approved', async ({ page }) => {
  const id = runId();
  const title = `E2E Data Engineer ${id}`;
  const roleUrl = await createRoleThroughUi(page, title);
  await approveRoleIfNeeded(page);
  await addCandidateThroughUi(page, title, `E2E Candidate ${id}`, `e2e-${id}@example.test`);
  await page.getByRole('tab', { name: 'Candidate journey' }).click();
  await page.getByRole('button', { name: 'Approve & create interview' }).click();
  await expect(page.getByRole('heading', { name: 'Interview', exact: true })).toBeVisible({ timeout: 20_000 });
  const interviewUrl = page.url();
  await expect(page.getByTestId('replan-pending')).toHaveCount(0);

  // A new competency makes a draft v2; approving it is what changes the plan.
  await page.goto(roleUrl);
  await page.getByTestId('add-competency').click();
  await page.getByTestId('add-competency-name').fill('Vendor Management');
  await page.getByTestId('add-competency-draft').click();
  await expect(page.getByTestId('add-competency-definition')).not.toHaveValue('');
  await page.getByTestId('add-competency-save').click();
  await expect(page.getByText('Vendor Management added to the scorecard.')).toBeVisible();
  await approveRoleIfNeeded(page);

  await page.goto(interviewUrl);
  await expect(page.getByTestId('replan-pending')).toBeVisible();
});
