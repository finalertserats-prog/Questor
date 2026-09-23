import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { dismissTour, runId } from './helpers';

// Nobody is signed in on any of this: the person here cannot sign in, which is
// the whole reason the pages exist.
test.use({ storageState: { cookies: [], origins: [] } });

interface Seeded {
  readonly email: string;
  readonly oldPassword: string;
  readonly token: string;
  readonly userId: string;
  readonly slug: string;
}

function seedReset(): Seeded {
  const root = resolve(import.meta.dirname, '../..');
  const out = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'e2e/scripts/seedPasswordReset.ts', runId().replace(/[^a-z0-9]/gi, '').toLowerCase()], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'file:./data/questor.db' },
  }).toString();
  // The JSON is the last thing printed; tsx can write notices above it. A seed
  // that produced nothing usable says so HERE — handed on as an empty object
  // it becomes `#undefined` in the address bar and the spec fails three
  // assertions later as "this link has expired", which is a true statement
  // about a link that was never made.
  const seeded = JSON.parse(out.slice(out.lastIndexOf('{'))) as Seeded;
  if (!seeded.token || !seeded.email) throw new Error(`Seeding a reset link produced nothing usable: ${out}`);
  return seeded;
}

const NEW_PASSWORD = 'a-brand-new-long-passphrase';

test('asking for a reset link says the same thing for any address', async ({ page }) => {
  await page.goto('/forgot-password');
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();

  await page.getByLabel('Email').fill('definitely-nobody@questor.local');
  await page.getByRole('button', { name: 'Email me a link' }).click();

  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  // The toast region is also role=status; the banner is the one with words.
  const confirmation = await page.getByText(/If that address has a Questor account/).innerText();
  expect(confirmation).toContain('If that address has a Questor account');

  // And an address that does exist gets the identical page. That sameness is
  // the defence: the form cannot be used to ask who works somewhere.
  const seeded = seedReset();
  await page.goto('/forgot-password');
  await page.getByLabel('Email').fill(seeded.email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  expect(await page.getByText(/If that address has a Questor account/).innerText()).toBe(confirmation);
});

test('a reset link sets a new password, the old one stops working, and the link cannot be used twice', async ({ page }) => {
  const seeded = seedReset();

  // Follow the link exactly as it arrives: the token is in the fragment, which
  // the browser keeps to itself.
  await page.goto(`/reset-password#${seeded.token}`);
  await expect(page.getByRole('heading', { name: 'Set a new password' })).toBeVisible();
  // And it is taken straight out of the address bar, so it does not sit in
  // browser history on a shared machine.
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('');

  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel('Repeat new password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page).toHaveURL(/\/login$/);

  // The old password is refused.
  // Through the organisation's own door, which is the only door now.
  const signIn = async (password: string) => {
    await page.goto(`/o/${seeded.slug}`);
    await page.getByLabel('Email').fill(seeded.email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
  };

  await signIn(seeded.oldPassword);
  await expect(page.getByText('Invalid credentials')).toBeVisible();

  // The new one works.
  await signIn(NEW_PASSWORD);
  await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible();
  await dismissTour(page);

  // And the link is spent: following it again offers no form, only the way to
  // ask for a fresh one.
  await page.goto(`/reset-password#${seeded.token}`);
  await expect(page.getByText(/This link is no longer valid/)).toBeVisible();
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Ask for a new link' })).toBeVisible();
});

test('an invented link is refused with the same wording as a spent one', async ({ page }) => {
  await page.goto('/reset-password#this-token-was-never-issued-by-anyone');
  await expect(page.getByText(/This link is no longer valid/)).toBeVisible();
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
});

test('the sign-in page offers a way out to someone who cannot sign in', async ({ page }) => {
  const seeded = seedReset();
  await page.goto(`/o/${seeded.slug}`);
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  // The organisation is carried through, so "back to sign in" returns to the
  // door they came in by.
  await expect.poll(() => new URL(page.url()).pathname + new URL(page.url()).search)
    .toBe(`/forgot-password?org=${seeded.slug}`);
});
