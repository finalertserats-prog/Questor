import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { dismissTour, runId } from './helpers';

// Organisation, password, code. Nobody is signed in on any of this.
test.use({ storageState: { cookies: [], origins: [] } });

const root = resolve(import.meta.dirname, '../..');

function seed(errand: string, tag: string): Record<string, string> {
  const out = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'e2e/scripts/seedSignInCode.ts', errand, tag], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'file:./data/questor.db' },
  }).toString().trim();
  return JSON.parse(out.split('\n').pop() ?? '{}') as Record<string, string>;
}

const tag = () => runId().replace(/[^a-z0-9]/gi, '').toLowerCase();

async function enterPassword(page: Page, org: Record<string, string>, opts: { remember?: boolean } = {}) {
  await page.goto(`/o/${org.slug}`);
  await expect(page.getByRole('heading', { name: /E2E Code Org/ })).toBeVisible();
  await page.getByLabel('Email').fill(org.email);
  await page.getByLabel('Password').fill(org.password);
  if (opts.remember) await page.getByLabel(/Keep me signed in on this device/).check();
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('the password alone does not sign anyone in when the organisation asks for a code', async ({ page }) => {
  const id = tag();
  const org = seed('setup', id);

  await enterPassword(page, org);

  await expect(page.getByLabel('Sign-in code')).toBeVisible();
  // Still on the sign-in page, and still signed out.
  await expect(page).toHaveURL(new RegExp(`/o/${org.slug}$`));
  // The address the code went to is shown masked, never spelled out: whoever
  // is looking at this page had the password, and must not also be handed the
  // mailbox.
  await expect(page.getByText(org.email, { exact: true })).toHaveCount(0);
});

test('the right code signs the person in, and the code cannot be used again', async ({ page, context }) => {
  const id = tag();
  const org = seed('setup', id);

  await enterPassword(page, org);
  await expect(page.getByLabel('Sign-in code')).toBeVisible();
  const { code } = seed('code', id);

  await page.getByLabel('Sign-in code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible();
  await dismissTour(page);

  // Signed out, and round again: the same code is spent.
  await context.clearCookies();
  await enterPassword(page, org);
  await expect(page.getByLabel('Sign-in code')).toBeVisible();
  await page.getByLabel('Sign-in code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText(/not right|expired/)).toBeVisible();
});

test('a wrong code says how many tries are left and does not sign anyone in', async ({ page }) => {
  const id = tag();
  const org = seed('setup', id);

  await enterPassword(page, org);
  await expect(page.getByLabel('Sign-in code')).toBeVisible();
  seed('code', id);

  await page.getByLabel('Sign-in code').fill('000000');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByText(/tries left/)).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Home' })).toHaveCount(0);
  // The rejected code is cleared rather than left to be pressed again.
  await expect(page.getByLabel('Sign-in code')).toHaveValue('');
});

test('a remembered device skips the code next time, and can be taken back in Settings', async ({ page, context }) => {
  const id = tag();
  const org = seed('setup', id);

  await enterPassword(page, org, { remember: true });
  await expect(page.getByLabel('Sign-in code')).toBeVisible();
  const { code } = seed('code', id);
  await page.getByLabel('Sign-in code').fill(code);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible();
  await dismissTour(page);

  // The device is listed, and says it is this one.
  await page.goto('/settings');
  const panel = page.getByTestId('trusted-devices-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/this device/)).toBeVisible();

  // Sign out, and the code step is skipped — the session cookie is gone but
  // the device cookie is not.
  await page.goto('/');
  await context.clearCookies({ name: 'questor_token' });
  await enterPassword(page, org);
  await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible();
  await dismissTour(page);

  // Take it back, and the code is asked for again.
  await page.goto('/settings');
  await page.getByTestId('trusted-devices-panel').getByRole('button', { name: /^Forget / }).click();
  await expect(page.getByTestId('trusted-devices-panel').getByText(/have not asked us to remember/)).toBeVisible();

  await context.clearCookies({ name: 'questor_token' });
  await enterPassword(page, org);
  await expect(page.getByLabel('Sign-in code')).toBeVisible();
});

test('the front door asks for an organisation before it asks for anything else', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('combobox', { name: 'Your organisation' })).toBeVisible();
  // There is no way to type an email and password here: an address alone does
  // not say which organisation somebody means.
  await expect(page.getByLabel('Password')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Bring your organisation to Questor/ })).toBeVisible();
});
