import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { runId } from './helpers';

/**
 * An organisation brings itself to Questor, the owner decides on it, and what
 * it said it hires for is what its catalog shows afterwards.
 *
 * The signed-in user from global setup is the demo admin, who is deliberately
 * NOT the deployment operator (the dev server sets SIGNUP_APPROVER_EMAIL to
 * approver@questor.local). So the operator account is created through the
 * admin API first, and the approval below is made while signed in as them —
 * the same door the owner uses, not a back one.
 */

const OPERATOR_EMAIL = 'approver@questor.local';
// A fixture credential for a throwaway account on a local dev database.
const OPERATOR_SECRET = 'e2e-operator-passphrase-long-enough';


/** Idempotent: the suite may have created the operator on an earlier run. */
async function ensureOperator(api: APIRequestContext, csrf: string) {
  const res = await api.post('/api/admin/users', {
    headers: { 'X-CSRF-Token': csrf },
    data: { name: 'Questor Owner', email: OPERATOR_EMAIL, password: OPERATOR_SECRET, role: 'admin' },
  });
  if (!res.ok() && res.status() !== 409) throw new Error(`Could not create the operator: ${res.status()} ${await res.text()}`);
}

async function signIn(page: Page, email: string, secret: string, orgPath = '/o/acme') {
  await page.goto(orgPath);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(secret);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: 20_000 });
}

test('an organisation onboards itself, the owner approves it, and its catalog follows what it hires for', async ({ browser, context }) => {
  const id = runId();
  const orgName = `E2E Onboard ${id}`;
  const orgSlug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  const adminEmail = `onboard-${id}@example.test`;
  const adminSecret = `e2e-onboard-${id}-passphrase`;

  const csrf = (await context.cookies()).find((c) => c.name === 'questor_csrf')?.value ?? '';
  await ensureOperator(context.request, csrf);

  // --- 1. The public form ---------------------------------------------------
  const applicant = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const form = await applicant.newPage();
  await form.goto('/onboard');
  await expect(form.getByRole('heading', { name: 'Bring your organisation to Questor' })).toBeVisible();

  await form.getByLabel('Organisation name').fill(orgName);
  await form.getByLabel('Where you hire').selectOption({ label: 'India' });
  await form.getByLabel('Roughly how many people work there').selectOption({ index: 2 });
  await form.getByLabel('Your name').fill('Priya Rao');
  await form.getByLabel('Work email').fill(adminEmail);
  await form.getByLabel('Choose a password').fill(adminSecret);

  // Two business areas, chosen the way a person would: search, then tick.
  await form.getByPlaceholder('Search business areas…').fill('Software Engineering');
  const softwareArea = form.locator('.onboard-area').first();
  const softwareName = (await softwareArea.locator('.onboard-area-name').innerText()).trim();
  await softwareArea.locator('input[type="checkbox"]').check();

  await form.getByPlaceholder('Search business areas…').fill('Finance, Accounting');
  const financeArea = form.locator('.onboard-area').first();
  const financeName = (await financeArea.locator('.onboard-area-name').innerText()).trim();
  await financeArea.locator('input[type="checkbox"]').check();

  await expect(form.getByText('2 of 5 chosen')).toBeVisible();
  await form.getByRole('button', { name: 'Send request' }).click();

  await expect(form.getByRole('heading', { name: 'Your request has been sent' })).toBeVisible();
  await expect(form.getByText(/Nothing has been created yet/)).toBeVisible();
  await applicant.close();

  // --- 2. The owner decides, in the console --------------------------------
  const ownerCtx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const owner = await ownerCtx.newPage();
  await signIn(owner, OPERATOR_EMAIL, OPERATOR_SECRET);
  await owner.goto('/admin/signups');
  await expect(owner.getByRole('heading', { name: 'Account requests' })).toBeVisible();

  const row = owner.getByRole('row').filter({ hasText: orgName });
  await expect(row).toBeVisible({ timeout: 20_000 });
  // The details the owner needs are in front of them, not behind a click.
  await expect(row).toContainText('India');
  await expect(row).toContainText(softwareName);
  await expect(row).toContainText(financeName);

  await row.getByRole('button', { name: /^Approve/ }).click();
  await expect(owner.getByText(/request was approved/)).toBeVisible({ timeout: 20_000 });
  await ownerCtx.close();

  // --- 3. The admin is set up, and signs in --------------------------------
  const newOrg = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const admin = await newOrg.newPage();
  await signIn(admin, adminEmail, adminSecret, `/o/${orgSlug}`);

  // --- 4. Its catalog is scoped to what it said it hires for ---------------
  await admin.goto('/roles/new');
  const skip = admin.getByRole('button', { name: /skip tour/i });
  if (await skip.isVisible({ timeout: 2000 }).catch(() => false)) await skip.click();

  const domain = admin.getByLabel('Domain', { exact: true });
  await expect(domain.locator('option')).toHaveCount(3); // the placeholder plus its two areas
  await expect(domain).toContainText(softwareName);
  await expect(domain).toContainText(financeName);
  await expect(admin.getByText(/Showing your 2 business areas/)).toBeVisible();

  // And the whole catalog is one click away — a view, never a wall.
  await admin.getByRole('button', { name: /^Show all \d+ domains$/ }).click();
  await expect(domain.locator('option')).not.toHaveCount(3, { timeout: 20_000 });
  await expect(admin.getByText(/Showing all \d+ domains/)).toBeVisible();

  await newOrg.close();
});
