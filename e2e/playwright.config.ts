import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  retries: 1,
  workers: 1,
  reporter: [['html', { outputFolder: 'playwright-report', open: 'never' }], ['list']],
  use: {
    // The dev server's address. Overridable so two checkouts of this repo can
    // run their suites at once instead of silently reusing each other's server
    // — which points one branch's tests at another branch's database.
    baseURL: process.env.QUESTOR_BASE_URL ?? 'http://localhost:5173',
    storageState: './.auth/recruiter.json',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'node e2e/scripts/dev-server.mjs',
    // The API behind Vite's proxy, not the page: the page answers first, and
    // global setup's sign-in then met "We can't reach Questor right now".
    url: `${process.env.QUESTOR_BASE_URL ?? 'http://localhost:5173'}/api/health`,
    cwd: '..',
    // A run that names its own address must not silently adopt a foreign server
    // already listening there.
    reuseExistingServer: !process.env.CI && !process.env.QUESTOR_BASE_URL,
    timeout: 120_000,
  },
});