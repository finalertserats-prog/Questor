// Visual check of organisation onboarding against the running dev server:
// the public form, the owner's approval view with a request's details in it,
// and a scoped organisation's role catalog — at phone and desk widths, light
// and dark. Run the onboard spec first so there is a request to look at.
//
// Usage: node e2e/scripts/shotOnboard.mjs <outDir>
import { chromium, expect } from '@playwright/test';

const out = process.argv[2] ?? '.';
const base = process.env.QUESTOR_BASE_URL ?? 'http://localhost:5173';
const OPERATOR_EMAIL = 'approver@questor.local';
const OPERATOR_SECRET = 'e2e-operator-passphrase-long-enough';
const sizes = [['1440', 1440, 1000], ['375', 375, 900]];
const themes = ['light', 'dark'];

const browser = await chromium.launch();
const id = `${Date.now()}`.slice(-8);
const orgName = `Shot Onboard ${id}`;
const orgSlug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
// Its own domain per run, for the same reason the specs use one.
const adminEmail = `founder@shot-onboard-${id}.test`;
const adminSecret = `shot-onboard-${id}-passphrase`;

async function signIn(page, email, secret, orgPath) {
  await page.goto(`${base}${orgPath}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(secret);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible({ timeout: 20_000 });
}

/** One page, at both widths and in both themes. `prepare` runs per shot. */
async function shoot(label, prepare, { storageState } = {}) {
  for (const [width, w, h] of sizes) {
    for (const theme of themes) {
      const ctx = await browser.newContext({
        viewport: { width: w, height: h }, colorScheme: theme, baseURL: base,
        storageState: storageState ?? { cookies: [], origins: [] },
      });
      // The console's theme is a stored choice, not the OS preference — see
      // web/src/components/theme.tsx, which deliberately ignores the OS. So
      // colorScheme alone renders every "dark" shot in light.
      await ctx.addInitScript((t) => {
        try { window.localStorage.setItem('questor-theme', t); } catch { /* blocked storage */ }
      }, theme);
      const page = await ctx.newPage();
      await prepare(page);
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
      await page.screenshot({ path: `${out}/onboard-${label}-${width}-${theme}.png`, fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      console.log(`${label} ${width} ${theme}: horizontal overflow ${overflow}px`);
      if (overflow > 0) console.log(`  !! ${label} scrolls sideways at ${width}px`);
      await ctx.close();
    }
  }
}

// --- a request to look at ---------------------------------------------------
const seedCtx = await browser.newContext({ baseURL: base });
const seed = await seedCtx.newPage();
await seed.goto(`${base}/onboard`);
await seed.getByLabel('Organisation name').fill(orgName);
await seed.getByLabel('Where you hire').selectOption({ label: 'India' });
await seed.getByLabel('Roughly how many people work there').selectOption({ index: 2 });
await seed.getByLabel('Your name').fill('Priya Rao');
await seed.getByLabel('Work email').fill(adminEmail);
await seed.getByLabel('Choose a password').fill(adminSecret);
for (const term of ['Software Engineering', 'Finance, Accounting', 'Data, Analytics']) {
  await seed.getByPlaceholder('Search business areas…').fill(term);
  await seed.locator('.onboard-area').first().locator('input[type="checkbox"]').check();
}
await seed.getByRole('button', { name: 'Send request' }).click();
await expect(seed.getByRole('heading', { name: 'Your request has been sent' })).toBeVisible();
await seedCtx.close();

// --- 1. the public form, part-filled so the choices show --------------------
await shoot('form', async (page) => {
  await page.goto(`${base}/onboard`);
  await expect(page.getByRole('heading', { name: 'Bring your organisation to Questor' })).toBeVisible();
  await page.getByLabel('Organisation name').fill('Northstar Robotics');
  await page.getByLabel('Where you hire').selectOption({ label: 'India' });
  await page.getByLabel('Roughly how many people work there').selectOption({ index: 2 });
  await page.getByLabel('Your name').fill('Priya Rao');
  await page.getByLabel('Work email').fill('priya@northstar.test');
  await page.getByPlaceholder('Search business areas…').fill('Engineering');
  await page.locator('.onboard-area').first().locator('input[type="checkbox"]').check();
  await page.locator('.onboard-area').nth(1).locator('input[type="checkbox"]').check();
});

// --- 2. the owner's approval view -------------------------------------------
const ownerCtx = await browser.newContext({ baseURL: base });
const owner = await ownerCtx.newPage();
await signIn(owner, OPERATOR_EMAIL, OPERATOR_SECRET, '/o/acme');
const ownerState = await ownerCtx.storageState();
await ownerCtx.close();

await shoot('approval', async (page) => {
  await page.goto(`${base}/admin/signups`);
  await expect(page.getByRole('heading', { name: 'Account requests' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(orgName)).toBeVisible({ timeout: 20_000 });
}, { storageState: ownerState });

// --- 3. a scoped organisation's role catalog --------------------------------
const approve = await browser.newContext({ storageState: ownerState, baseURL: base });
const approver = await approve.newPage();
await approver.goto(`${base}/admin/signups`);
await approver.getByRole('row').filter({ hasText: orgName }).getByRole('button', { name: /^Approve/ }).click();
await expect(approver.getByText(/request was approved/)).toBeVisible({ timeout: 20_000 });
await approve.close();

const newOrgCtx = await browser.newContext({ baseURL: base });
const newAdmin = await newOrgCtx.newPage();
await signIn(newAdmin, adminEmail, adminSecret, `/o/${orgSlug}`);
const newOrgState = await newOrgCtx.storageState();
await newOrgCtx.close();

await shoot('scoped-catalog', async (page) => {
  await page.goto(`${base}/roles/new`);
  const skip = page.getByRole('button', { name: /skip tour/i });
  if (await skip.isVisible({ timeout: 2000 }).catch(() => false)) await skip.click();
  await expect(page.getByText(/Showing your 3 business areas/)).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Domain', { exact: true }).selectOption({ index: 1 });
}, { storageState: newOrgState });

await browser.close();
