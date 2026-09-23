// Visual check of the password pages against the running dev server: forgot
// password, set a new password, the change form in Settings, and the admin's
// "send reset link" action — at desk and phone widths, in both themes.
// Reuses the e2e session (run the e2e suite first, or global setup).
// Usage: node e2e/scripts/shotPassword.mjs <outDir>
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const out = process.argv[2] ?? '.';
const base = process.env.QUESTOR_BASE_URL ?? 'http://localhost:5173';
const statePath = resolve(import.meta.dirname, '../.auth/recruiter.json');
const root = resolve(import.meta.dirname, '../..');
mkdirSync(out, { recursive: true });

const sizes = [['1440', 1440, 1000], ['375', 375, 900]];
const themes = ['light', 'dark'];

// A live link to photograph the set-a-new-password page with. Minted the same
// way the spec does; never spent, so the screenshot run leaves no account with
// a password nobody knows.
const seeded = JSON.parse(
  execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'e2e/scripts/seedPasswordReset.ts', `shot${Date.now()}`], {
    cwd: root, env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'file:./data/questor.db' },
  }).toString().trim().split(/\r?\n/).pop(),
);

// An organisation whose policy asks for a code, so the code step can be
// photographed. Never completed, so nothing is left signed in.
const signin = JSON.parse(
  execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'e2e/scripts/seedSignInCode.ts', 'setup', `shot${Date.now()}`], {
    cwd: root, env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'file:./data/questor.db' },
  }).toString().trim().split(/\r?\n/).pop(),
);

const browser = await chromium.launch();

/** One page, every size and theme. `prepare` runs once the page has loaded. */
async function shoot(label, path, { signedIn = false, prepare } = {}) {
  for (const [sizeName, width, height] of sizes) {
    for (const theme of themes) {
      const ctx = await browser.newContext({
        viewport: { width, height },
        baseURL: base,
        colorScheme: theme,
        storageState: signedIn ? statePath : { cookies: [], origins: [] },
      });
      const page = await ctx.newPage();
      await page.goto(path, { waitUntil: 'networkidle' });
      // Held still so two runs are comparable.
      await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; }' });
      if (prepare) await prepare(page);
      await page.screenshot({ path: `${out}/${label}-${sizeName}-${theme}.png`, fullPage: true });
      // 375 with a horizontal scrollbar is the house failure; report it rather
      // than leaving it to be noticed in the image.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      console.log(`${label} ${sizeName} ${theme}: overflow ${overflow}px`);
      await ctx.close();
    }
  }
}

await shoot('forgot', '/forgot-password');
await shoot('forgot-sent', '/forgot-password', {
  prepare: async (page) => {
    await page.getByLabel('Email').fill('someone@example.com');
    await page.getByRole('button', { name: 'Email me a link' }).click();
    await page.getByRole('heading', { name: 'Check your email' }).waitFor({ timeout: 10_000 });
  },
});
await shoot('reset', `/reset-password#${seeded.token}`, {
  prepare: async (page) => { await page.getByLabel('New password', { exact: true }).waitFor({ timeout: 10_000 }); },
});
await shoot('reset-dead', '/reset-password#a-link-that-was-never-issued-at-all', {
  prepare: async (page) => { await page.getByText(/This link is no longer valid/).waitFor({ timeout: 10_000 }); },
});
// The code step is not photographed here: this stack runs the console mail
// provider, so the server skips the code rather than asking for one nobody
// could receive. The password step, which carries the remembered-device offer,
// is the part of the new sign-in a browser can show.
await shoot('signin-password', `/o/${signin.slug}`, {
  prepare: async (page) => { await page.getByLabel(/Keep me signed in on this device/).waitFor({ timeout: 10_000 }); },
});
await shoot('settings-devices', '/settings', {
  signedIn: true,
  prepare: async (page) => { await page.getByTestId('trusted-devices-panel').waitFor({ timeout: 15_000 }); },
});
await shoot('admin-signin-policy', '/admin/organisation', {
  signedIn: true,
  prepare: async (page) => { await page.getByTestId('signin-policy').waitFor({ timeout: 15_000 }); },
});
await shoot('settings-change', '/settings', {
  signedIn: true,
  prepare: async (page) => { await page.getByTestId('change-password-panel').waitFor({ timeout: 15_000 }); },
});
await shoot('admin-reset', '/admin/users', {
  signedIn: true,
  prepare: async (page) => {
    await page.getByRole('table').waitFor({ timeout: 15_000 });
    // The confirm step is the action worth photographing: it is the moment an
    // admin is told what sending a link does and does not do.
    const first = page.getByRole('button', { name: /^Send .* a password reset link$/ }).first();
    if (await first.isVisible().catch(() => false)) await first.click();
  },
});

await browser.close();
console.log(`Screenshots written to ${out}`);
