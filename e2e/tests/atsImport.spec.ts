import { expect, test } from '@playwright/test';
import { approveRoleIfNeeded, createRoleThroughUi, dismissTour, roleTitle, runId } from './helpers';

// The local suite has no ATS to import from, so this covers what a recruiter
// sees before their organisation connects one: the import form, what it asks
// for, and a refusal that says where to go next instead of a bare error.
test('offers an ATS import and explains that no ATS is connected yet', async ({ page }) => {
  const title = roleTitle(runId());
  await createRoleThroughUi(page, title);
  await approveRoleIfNeeded(page);

  await page.goto('/candidates/new');
  await dismissTour(page);
  const form = page.locator('form.card');
  const roleSelect = form.getByRole('combobox');
  const roleValue = await roleSelect.locator('option').filter({ hasText: title }).first().getAttribute('value');
  if (!roleValue) throw new Error('Created role was not available for candidate import.');
  await roleSelect.selectOption(roleValue);

  await form.getByRole('radio', { name: 'A candidate in your ATS' }).check();
  await expect(form.getByLabel('Full name')).toHaveCount(0);
  await form.getByLabel('ATS candidate id').fill('CAND-1042');
  await form.getByRole('button', { name: 'Import candidate', exact: true }).click();

  await expect(page.getByText(/has not connected an ATS yet/)).toBeVisible();
  await page.screenshot({ path: 'test-results/ats-import.png', fullPage: true });
});
