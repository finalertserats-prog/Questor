import { expect, test } from '@playwright/test';

// The organisation-first front door, in a browser.
//
// The code step itself is NOT here, and that is not an oversight. This stack
// runs the console mail provider, which delivers nothing, so the server
// deliberately skips the code rather than asking for one nobody could receive
// (services/signInCode.ts, codeDeliverability). A spec that forced it would be
// testing a fixture rather than the product. The whole code flow — issuing,
// entering, the attempt limit, the lockout, the single use, trusted devices,
// break-glass and the audit trail — runs over real HTTP in
// server/tests/signInCode.test.ts, against a provider that does deliver; the
// page itself is covered in web/tests/signInForm.test.ts.

test.use({ storageState: { cookies: [], origins: [] } });

test('the front door asks for an organisation before it asks for anything else', async ({ page }) => {
  await page.goto('/login');

  await expect(page.getByRole('combobox', { name: 'Your organisation' })).toBeVisible();
  // There is deliberately no email and password here: an address on its own
  // does not say which organisation somebody means.
  await expect(page.getByLabel('Password')).toHaveCount(0);
});

test('it offers the ways in for someone who has no organisation yet', async ({ page }) => {
  await page.goto('/login');

  await expect(page.getByRole('link', { name: 'Ask for one' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Bring your organisation to Questor/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Ask for a demo/ })).toBeVisible();
});

test('the name search finds an organisation and carries it to its own door', async ({ page }) => {
  await page.goto('/login');
  const org = page.getByRole('combobox', { name: 'Your organisation' });

  await org.fill('acm');
  await expect(page.getByRole('option', { name: /Acme Corp/ })).toBeVisible();
  await org.press('Enter');

  await expect(page).toHaveURL(/\/o\/acme$/);
  await expect(page.getByRole('heading', { name: 'Acme Corp' })).toBeVisible();
  // And the sign-in form is now scoped to it.
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel(/Keep me signed in on this device/)).not.toBeChecked();
});

test('the remembered-device offer says what it does and does not cover', async ({ page }) => {
  await page.goto('/o/acme');

  const hint = page.getByText(/It skips the emailed code/);
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('not your password');
  await expect(hint).toContainText('device that is yours');
});
