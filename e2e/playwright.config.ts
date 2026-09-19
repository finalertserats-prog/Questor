import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  retries: 1,
  workers: 1,
  reporter: [['html', { outputFolder: 'playwright-report', open: 'never' }], ['list']],
  use: {
    baseURL: 'http://localhost:5173',
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
    url: 'http://localhost:5173/api/health',
    cwd: '..',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});