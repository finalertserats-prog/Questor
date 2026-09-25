import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * The suite against a dev server you started yourself (the README's private-
 * ports recipe, run by hand), for a machine where Playwright's own start of
 * the server does not come up inside its two-minute allowance. Everything
 * else is the ordinary config; only the server start is left out.
 *
 *   QUESTOR_BASE_URL=http://localhost:5197 npx playwright test --config playwright.attach.config.ts
 */
export default defineConfig({ ...base, webServer: undefined });
