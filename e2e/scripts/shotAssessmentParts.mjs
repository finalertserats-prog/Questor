// One-off visual check of the three-part assessment page and the AI-drafted
// suggestions, against the running dev server, reusing the e2e session.
//
//   node e2e/scripts/shotAssessmentParts.mjs <outDir> <openAssessmentId> <reviewedAssessmentId>
//
// The draft states are captured with the /api/drafts routes stubbed in the
// browser. The dev server runs on the built-in heuristic engine, which by
// design returns no draft at all, and a screenshot of "no suggestion" would
// show nothing of the thing being reviewed. The stub returns the text a real
// model would; every other pixel is the real page.
//
// Reports the page's horizontal overflow per capture, because a phone width
// with a table on it is where that breaks first.
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';

const [out = '.', openId, reviewedId] = process.argv.slice(2);
const base = process.env.SHOT_BASE ?? 'http://localhost:5173';
const state = resolve(import.meta.dirname, '../.auth/recruiter.json');

const DRAFT = 'A senior engineer on the payments platform, owning the services that move money end to end. '
  + 'You will design for failure — retries, idempotency, circuit breakers — and be on call for what you build.';
const TIDIED = 'Arjun is not available before 11:00 IST. He would like the systems round with someone from '
  + 'Payments rather than Platform, and prefers a single 90-minute session to two 45-minute ones.';

const browser = await chromium.launch();

async function shot(page, name, width, theme) {
  await page.waitForTimeout(700);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const file = resolve(out, `${name}-${width}-${theme}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`${file}  (horizontal overflow: ${overflow}px)`);
}

async function withPage(width, theme, run) {
  const ctx = await browser.newContext({ viewport: { width, height: 1100 }, deviceScaleFactor: 2, storageState: state });
  await ctx.addInitScript((t) => {
    try { localStorage.setItem('questor-theme', t); } catch { /* private mode */ }
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  const page = await ctx.newPage();
  await run(page);
  await ctx.close();
}

/** The draft routes, answered as a configured model would answer them. */
async function stubDrafts(page, { text = DRAFT, tidied = TIDIED } = {}) {
  await page.route('**/api/drafts/suggest', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text, disabled: false }) }));
  await page.route('**/api/drafts/tidy', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: tidied, disabled: false }) }));
  await page.route('**/api/drafts/accepted', (route) =>
    route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ recorded: true }) }));
}

for (const [width, widthName] of [[1440, '1440'], [375, '375']]) {
  for (const theme of ['light', 'dark']) {
    // --- the three parts, before anyone has reviewed -----------------------
    await withPage(width, theme, async (page) => {
      await page.goto(`${base}/assessments/${openId}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-testid="assessment-part-1"]', { timeout: 30_000 });
      await shot(page, 'parts-open', widthName, theme);
    });

    // --- the three parts, after a verdict was recorded ---------------------
    await withPage(width, theme, async (page) => {
      await page.goto(`${base}/assessments/${reviewedId}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-testid="recorded-review"]', { timeout: 30_000 });
      await shot(page, 'parts-reviewed', widthName, theme);
      await page.locator('[data-testid="differences-table"]').scrollIntoViewIfNeeded();
      await shot(page, 'differences', widthName, theme);
    });

    // --- the verdict form: no draft offered, tidy after they have written --
    await withPage(width, theme, async (page) => {
      await stubDrafts(page);
      await page.goto(`${base}/assessments/${openId}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-testid="verdict-PROCEED"]', { timeout: 30_000 });
      await page.locator('[data-testid="verdict-PROCEED"]').click();
      const reason = page.locator('#verdict-reason');
      await reason.fill('he gave the whole diagnosis at 18:40, thats a 4 not a 2, worth the next round');
      await page.locator('[data-testid="no-draft-note"]').scrollIntoViewIfNeeded();
      await shot(page, 'verdict-no-draft', widthName, theme);
      await page.locator('[data-testid="tidy-run"]').click();
      await page.waitForSelector('[data-testid="tidy-panel"]', { timeout: 20_000 });
      await shot(page, 'tidy-before-after', widthName, theme);
    });

    // --- a suggestion offered, taken, and typed over -----------------------
    await withPage(width, theme, async (page) => {
      await stubDrafts(page);
      await page.goto(`${base}/roles/new`, { waitUntil: 'networkidle' });
      const jd = page.locator('textarea[id$="-jd"]');
      await jd.waitFor({ timeout: 30_000 });
      await jd.focus();
      await page.waitForSelector('[data-testid="draft-offer"]', { timeout: 20_000 });
      await shot(page, 'draft-offered', widthName, theme);
      await page.locator('[data-testid="draft-accept"]').click();
      await page.waitForSelector('[data-testid="draft-taken"]', { timeout: 20_000 });
      await shot(page, 'draft-taken', widthName, theme);
    });

    await withPage(width, theme, async (page) => {
      await stubDrafts(page);
      await page.goto(`${base}/roles/new`, { waitUntil: 'networkidle' });
      const jd = page.locator('textarea[id$="-jd"]');
      await jd.waitFor({ timeout: 30_000 });
      await jd.focus();
      await page.waitForSelector('[data-testid="draft-offer"]', { timeout: 20_000 });
      await jd.fill('My own words for this advert instead.');
      await page.waitForSelector('[data-testid="draft-dismissed"]', { timeout: 20_000 });
      await shot(page, 'draft-dismissed', widthName, theme);
    });
  }
}

await browser.close();
