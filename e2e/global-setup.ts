import { chromium, expect, type FullConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const authFile = resolve(import.meta.dirname, '.auth/recruiter.json');

function readDemoPassword(): string {
  const seedSource = readFileSync(resolve(import.meta.dirname, '../server/src/seed/demoData.ts'), 'utf8');
  const match = seedSource.match(/const password\s*=\s*'([^']+)'/);
  if (!match) throw new Error('Could not read demo password from seed source.');
  return match[1];
}

async function globalSetup(config: FullConfig) {
  const root = resolve(import.meta.dirname, '..');
  execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'e2e/scripts/ensureAcmeSlug.ts'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'file:./data/questor.db' },
    stdio: 'ignore',
  });

  mkdirSync(dirname(authFile), { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL: config.projects[0].use.baseURL });
  await page.goto('/o/acme');
  await expect(page.getByRole('heading', { name: 'Acme Corp' })).toBeVisible();
  await page.getByLabel('Email').fill('demo@questor.local');
  await page.getByLabel('Password').fill(readDemoPassword());
  await page.getByRole('button', { name: 'Sign in' }).click();

  // The seeded account is this deployment's platform owner, and the platform
  // owner is asked for a sign-in code whatever an organisation has chosen —
  // deliberately, since that account reaches every organisation's shared
  // catalog. The console mail provider delivers nothing, so the code is made
  // knowable the only way it can be: by replacing its stored hash with the
  // hash of one we know. Every other part of the step is real.
  const codeField = page.getByLabel('Sign-in code');
  if (await codeField.isVisible({ timeout: 5_000 }).catch(() => false)) {
    const out = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'e2e/scripts/seedSignInCode.ts', 'code', 'demo@questor.local'], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'file:./data/questor.db' },
    }).toString().trim();
    // The last line the script printed is the JSON; tsx may write notices above it.
    const { code } = JSON.parse(out.slice(out.lastIndexOf('{'))) as { code: string };
    await codeField.fill(code);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible();
  await page.context().storageState({ path: authFile });
  await browser.close();
}

export default globalSetup;