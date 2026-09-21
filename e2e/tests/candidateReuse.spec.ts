import { expect, test, type Page } from '@playwright/test';
import { addCandidateThroughUi, approveRoleIfNeeded, createRoleThroughUi, dismissTour, roleTitle, runId } from './helpers';

/**
 * A person already in Questor is found by name on Add candidate and set up for
 * another role as a new application, their details copied rather than typed
 * in again. Each role is created through the UI, so the tests that need two
 * roles are given longer than the default.
 */

const TWO_ROLE_TIMEOUT = 120_000;

async function createApprovedRole(page: Page, title: string) {
  const url = await createRoleThroughUi(page, title);
  await approveRoleIfNeeded(page);
  const roleId = /\/roles\/([^/?#]+)/.exec(url)?.[1];
  if (!roleId) throw new Error(`No role id in ${url}`);
  return roleId;
}

/** Two roles and one person on the first, as a fresh set per test. */
async function createPersonAndTwoRoles(page: Page) {
  const id = runId();
  const firstTitle = roleTitle(`${id} A`);
  const secondTitle = roleTitle(`${id} B`);
  const firstRoleId = await createApprovedRole(page, firstTitle);
  const secondRoleId = await createApprovedRole(page, secondTitle);
  const name = `E2E Candidate ${id}`;
  const email = `e2e-${id}@example.test`;
  await addCandidateThroughUi(page, firstTitle, name, email);
  return { firstTitle, secondTitle, firstRoleId, secondRoleId, name, email, candidateUrl: page.url() };
}

/** On Add candidate: find the person by name, pick them, and set them up for the role. */
async function setUpExistingPersonForRole(page: Page, name: string, title: string) {
  await page.goto('/candidates/new');
  await dismissTour(page);
  await expect(page.getByRole('heading', { name: 'Add candidate', exact: true })).toBeVisible();
  const form = page.locator('form.card');
  await form.getByRole('combobox', { name: 'Full name' }).fill(name);
  const suggestions = page.getByRole('listbox', { name: 'People already in Questor' });
  await suggestions.getByRole('option').filter({ hasText: name }).first().click();

  await expect(page.getByRole('region', { name: 'Existing candidate' })).toBeVisible();
  const roleSelect = form.getByLabel('Role', { exact: true });
  const roleValue = await roleSelect.locator('option').filter({ hasText: title }).first().getAttribute('value');
  if (!roleValue) throw new Error('The second role was not offered for the existing person.');
  await roleSelect.selectOption(roleValue);
  await page.getByRole('button', { name: 'Set up for this role' }).click();
}

test('picks an existing person on Add candidate and sets them up for a second role', async ({ page }) => {
  test.setTimeout(TWO_ROLE_TIMEOUT);
  const { firstTitle, secondTitle, name, candidateUrl } = await createPersonAndTwoRoles(page);

  await page.goto('/candidates/new');
  await dismissTour(page);
  const form = page.locator('form.card');
  await form.getByRole('combobox', { name: 'Full name' }).fill(name);
  const suggestions = page.getByRole('listbox', { name: 'People already in Questor' });
  const match = suggestions.getByRole('option').filter({ hasText: name }).first();
  await expect(match).toContainText(firstTitle);
  await match.click();

  // Read-only: the details come from the earlier application.
  const panel = page.getByRole('region', { name: 'Existing candidate' });
  await expect(panel).toContainText(name);
  await expect(panel).toContainText('[existing candidate]');
  await expect(panel.getByText(/^Already in:/)).toContainText(firstTitle);
  await expect(form.getByLabel('Email', { exact: true })).toHaveCount(0);

  const roleSelect = form.getByLabel('Role', { exact: true });
  // The role they are already in is not offered again.
  await expect(roleSelect.locator('option').filter({ hasText: firstTitle })).toHaveCount(0);
  const roleValue = await roleSelect.locator('option').filter({ hasText: secondTitle }).first().getAttribute('value');
  if (!roleValue) throw new Error('The second role was not offered for the existing person.');
  await roleSelect.selectOption(roleValue);
  await page.getByRole('button', { name: 'Set up for this role' }).click();

  // A new application: a different record, for the second role.
  await expect(page).toHaveURL(/\/candidates\/[^/?#]+$/, { timeout: 20_000 });
  await expect(page).not.toHaveURL(candidateUrl);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.stat').filter({ hasText: 'Applied role' })).toContainText(secondTitle, { timeout: 20_000 });
});

test('the candidates list says an application is also in another role, and never offers that role again', async ({ page }) => {
  test.setTimeout(TWO_ROLE_TIMEOUT);
  const { firstTitle, secondTitle, name, email } = await createPersonAndTwoRoles(page);
  await setUpExistingPersonForRole(page, name, secondTitle);
  await expect(page.locator('.stat').filter({ hasText: 'Applied role' })).toContainText(secondTitle, { timeout: 20_000 });

  await page.goto('/candidates');
  await dismissTour(page);
  await page.getByLabel('Filter candidates').fill(email);
  const rows = page.getByRole('row').filter({ hasText: email });
  await expect(rows).toHaveCount(2);
  const firstRow = rows.filter({ hasText: firstTitle });
  await expect(firstRow).toContainText('Also in 1 other role');

  // "Another role" leaves out both roles the person is already in.
  await firstRow.getByRole('button', { name: `Set up ${name} for another role` }).click();
  const reusePanel = page.locator('.card').filter({ has: page.getByRole('heading', { name: `Set up ${name} for another role` }) });
  const alreadyIn = reusePanel.getByText(/^Already in:/);
  await expect(alreadyIn).toContainText(firstTitle);
  await expect(alreadyIn).toContainText(secondTitle);
  await expect(reusePanel.locator('option').filter({ hasText: firstTitle })).toHaveCount(0);
  await expect(reusePanel.locator('option').filter({ hasText: secondTitle })).toHaveCount(0);
});

test('a ?roleId= link to Add candidate starts on that role', async ({ page }) => {
  const title = roleTitle(runId());
  const roleId = await createApprovedRole(page, title);

  await page.goto(`/candidates/new?roleId=${roleId}`);
  await dismissTour(page);
  await expect(page.getByRole('heading', { name: 'Add candidate', exact: true })).toBeVisible();

  await expect(page.locator('form.card').getByLabel('Role', { exact: true })).toHaveValue(roleId);
});
