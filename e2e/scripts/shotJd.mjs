// Review screenshots of the JD-quality work against the running dev server,
// reusing the e2e session.
//
//   node e2e/scripts/shotJd.mjs <outDir> [roleId]
//
// Three flows, each at 1440 and 375 and in both themes:
//   import-*        the new-role page with a job description FILE chosen, the
//                   file's facts beside the text that came out of it
//   competencies-*  the role page's competencies, each quoting the job
//                   description line it was read from, with the catalog panel
//   export-pdf-*    the approved role page offering the PDF
//
// The PDF itself has neither a width nor a theme, so it is captured once, as
// pages rendered from the real downloaded bytes (see renderPdf below), and the
// bytes are written out beside them.
//
// Not a spec: it drives the app but asserts nothing, so it lives in scripts/
// and never runs as part of `npm run test:e2e`.
import { chromium, request } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const out = process.argv[2];
if (!out) throw new Error('Usage: node e2e/scripts/shotJd.mjs <outDir> [roleId]');
let roleId = process.argv[3] ?? '';
const base = process.env.QUESTOR_BASE_URL ?? 'http://localhost:5173';
const state = resolve(import.meta.dirname, '../.auth/recruiter.json');
mkdirSync(out, { recursive: true });

// server/bench/jd/cases/dataEngineering.ts, case data-01-senior-data-engineer:
// the advert the competency extractor was built against. It mentions product,
// analytics and machine learning only as other people this role works with,
// which is exactly what the source spans are there to make visible.
const JD = `Senior Data Engineer
Location: Bengaluru (Hybrid)  |  Employment type: Full-time  |  Level: Senior

About us:
Northwind was founded in 2015 and is headquartered in Bengaluru. Our mission is to
make financial data trustworthy for every mid-market lender in Asia. We are a
Series C company of roughly 400 people, trusted by 120 lenders.

About the role:
We are hiring a Senior Data Engineer to design and operate our analytical data
platform.

Responsibilities:
- Design robust, testable analytical data models and dimensional schemas.
- Build and operate batch and streaming pipelines using Python, Airflow and Spark.
- Own reliability of critical pipelines including detection, idempotent recovery
  and backfills.
- Write and optimize complex SQL; reason about performance, partitioning and
  correctness.
- Partner with analytics and product teams to deliver trustworthy data.
- Work closely with the machine learning team to supply feature inputs.

Must have:
- Strong SQL and data warehousing (Snowflake, Redshift or BigQuery).
- Proven experience building production data pipelines.
- Cloud platform experience (AWS/GCP/Azure), observability and reliability practices.

Nice to have:
- Experience with data governance and data quality frameworks.

Benefits:
- Competitive salary, equity and an annual learning budget.
- Private health insurance and 25 days paid time off.

Northwind is an equal opportunity employer. We welcome applicants regardless of
race, religion, gender or age. All offers are subject to a background check.`;

const JD_FILE = { name: 'northwind-senior-data-engineer.md', mimeType: 'text/markdown', buffer: Buffer.from(JD) };

const browser = await chromium.launch();

/**
 * A context already signed in, already on the wanted theme before first paint.
 *
 * The viewport is deliberately tall. Breakpoints are decided by WIDTH, so a
 * tall window changes no layout — but it means nothing has to be scrolled to
 * be photographed, and the sticky top bar is therefore drawn once, at the top,
 * instead of appearing again halfway down a stitched full-page image.
 */
async function open(width, theme, height = width < 700 ? 3600 : 2400) {
  const ctx = await browser.newContext({ viewport: { width, height }, storageState: state });
  // The app's own switch: a pre-paint script in index.html reads this key and
  // stamps <html data-theme>. Setting it here themes the very first frame
  // rather than repainting under the camera.
  await ctx.addInitScript((t) => { try { localStorage.setItem('questor-theme', t); } catch { /* ignore */ } }, theme);
  const page = await ctx.newPage();
  return { ctx, page };
}

async function goto(page, url) {
  await page.goto(`${base}${url}`, { waitUntil: 'networkidle' });
  const skip = page.getByRole('button', { name: /skip tour/i });
  if (await skip.isVisible({ timeout: 1500 }).catch(() => false)) await skip.click();
}

/** Page-coordinate box around one or more elements, with a little air. */
async function boxOf(page, locators, pad = 12) {
  const boxes = [];
  for (const l of locators) {
    if (await l.count() === 0) continue;
    boxes.push(await l.first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height };
    }));
  }
  if (boxes.length === 0) return null;
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const right = Math.max(...boxes.map((b) => b.x + b.w)) + pad;
  const bottom = Math.max(...boxes.map((b) => b.y + b.h)) + pad;
  return { x, y, width: right - x, height: bottom - y };
}

async function shot(page, locators, file, pad) {
  const clip = await boxOf(page, locators, pad);
  await page.screenshot({ path: resolve(out, file), fullPage: true, ...(clip ? { clip } : {}) });
  console.log(`  ${file}${clip ? '' : '  (full page — nothing to clip to)'}`);
}

/** Create the role the review needs, from the realistic advert, and approve it. */
async function seedRole() {
  const { ctx, page } = await open(1440, 'light');
  await goto(page, '/roles/new');
  const form = page.locator('form.card');
  await form.getByLabel('Domain', { exact: true }).selectOption({ label: 'Data, Analytics & Decision Science' });
  // The band the advert itself states ("Level: Senior" maps to `established`),
  // not whatever happens to be first in the list: the required levels every
  // competency is drafted at are read off this, so picking the wrong band
  // photographs the wrong scorecard.
  await form.getByLabel('Experience', { exact: true }).selectOption('established');
  await form.getByLabel('Region', { exact: true }).selectOption({ index: 1 });

  // Chosen from the catalog, not typed: the catalog link is what gives the
  // role page something to compare this scorecard against.
  const titleBox = page.getByRole('combobox', { name: /Role title/ });
  await titleBox.fill('Data Engineer');
  // Each option is its title above its domain, so its accessible name is both.
  // Matched on the title line alone, and exactly, so "Senior Data Engineer"
  // and "Analytics Engineer" are not what gets picked.
  const option = page.locator('[role="option"]').filter({ has: page.locator('span:text-is("Data Engineer")') });
  await option.first().waitFor({ timeout: 15_000 });
  await option.first().click();

  await page.getByRole('radio', { name: 'A job description file' }).check();
  await page.getByLabel(/Job description file/).setInputFiles(JD_FILE);
  await page.getByTestId('jd-extraction').waitFor({ timeout: 30_000 });

  await page.getByRole('button', { name: /^Create role$/ }).click();
  const cont = page.getByRole('button', { name: /Continue to the role/ });
  await cont.or(page.getByTestId('download-scorecard-pdf')).or(page.locator('tr.comp-row').first()).first().waitFor({ timeout: 60_000 });
  if (await cont.isVisible().catch(() => false)) await cont.click();
  await page.locator('tr.comp-row').first().waitFor({ timeout: 30_000 });

  const id = new URL(page.url()).pathname.split('/').filter(Boolean).pop();
  const approve = page.getByRole('button', { name: /^Approve scorecard$/ });
  if (await approve.isEnabled({ timeout: 3000 }).catch(() => false)) {
    await approve.click();
    await page.getByTestId('download-scorecard-pdf').waitFor({ timeout: 20_000 });
  }
  await ctx.close();
  return id;
}

/**
 * Retry a whole capture, context and all.
 *
 * Several branches share this checkout, so `tsx watch` restarts the API
 * whenever any of them saves a file — sometimes twice a minute. A page that
 * loaded during a restart shows "we could not confirm your sign-in" and no
 * data, which is a photograph of someone else's editor, not of this feature.
 * Each attempt therefore opens a fresh context and simply tries again.
 */
async function attempt(label, fn, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= tries) throw err;
      console.log(`  retrying ${label} (${err.message.split('\n')[0]})`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/** One retryable capture, in a context of its own that is always closed. */
function capture(label, width, theme, body) {
  return attempt(label, async () => {
    const { ctx, page } = await open(width, theme);
    try {
      return await body(page);
    } finally {
      await ctx.close();
    }
  });
}

if (!roleId) {
  roleId = await attempt('role creation', seedRole);
  console.log(`Created and approved role ${roleId}`);
}

for (const [size, width] of [['1440', 1440], ['375', 375]]) {
  for (const theme of ['light', 'dark']) {
    console.log(`${size} / ${theme}`);

    // 1. Importing a job description FILE: the picker, the file's own facts,
    //    and the text that was read out of it, side by side.
    await capture(`import-${size}-${theme}`, width, theme, async (page) => {
      await goto(page, '/roles/new');
      await page.getByRole('radio', { name: 'A job description file' }).check();
      await page.getByLabel(/Job description file/).setInputFiles(JD_FILE);
      await page.getByTestId('jd-extraction').waitFor({ timeout: 30_000 });
      await page.waitForTimeout(400);
      // Padded enough to keep the field's own label above the picker.
      await shot(page, [page.getByLabel(/Job description file/), page.getByTestId('jd-extraction')], `import-${size}-${theme}.png`, 58);
    });

    // 2. The competencies with their source spans, and the catalog panel.
    await capture(`competencies-${size}-${theme}`, width, theme, async (page) => {
      await goto(page, `/roles/${roleId}`);
      await page.locator('tr.comp-row').first().waitFor({ timeout: 30_000 });
      // The whole competencies card — its heading, the table and the source
      // line under each row — not just the scroll region inside it.
      const comps = page.locator('.card').filter({ has: page.getByTestId('add-competency') });
      const catalog = page.getByTestId('catalog-comparison');
      await comps.scrollIntoViewIfNeeded();
      await page.waitForTimeout(600);
      if (await catalog.count() === 0) console.log('  ! no catalog comparison panel on this role');
      if (await page.locator('[data-testid^="competency-uncertain-"]').count() === 0) {
        console.log('  ! no low-confidence competency on this role');
      }
      await shot(page, [comps, catalog], `competencies-${size}-${theme}.png`);
    });

    // 3. The approved role offering its PDF.
    await capture(`export-pdf-${size}-${theme}`, width, theme, async (page) => {
      await goto(page, `/roles/${roleId}`);
      const button = page.getByTestId('download-scorecard-pdf');
      await button.waitFor({ timeout: 30_000 });
      await page.waitForTimeout(400);
      // Down to the banner under the header, so the button is shown in the
      // state that earns it — an approved scorecard — rather than alone.
      await shot(page, [
        page.locator('main').getByRole('heading', { level: 1 }),
        button,
        page.getByText(/Scorecard approved/),
      ], `export-pdf-${size}-${theme}.png`, 20);
    });
  }
}

await browser.close();

// The document itself. Downloaded through the real route, written out as the
// file a reviewer would receive, and rendered page by page so it can simply be
// looked at. Playwright's bundled Chromium has no PDF viewer and downloads the
// file instead, so the render uses the browser on this machine that does have
// one; if neither is installed the bytes are still saved.
const api = await request.newContext({ baseURL: base, storageState: state });
const bytes = await attempt('the export', async () => {
  const res = await api.get(`/api/roles/${roleId}/export.pdf`);
  if (!res.ok()) throw new Error(`Export refused: ${res.status()} ${await res.text()}`);
  return res.body();
});
const pdfPath = resolve(out, 'export-pdf-downloaded.pdf');
writeFileSync(pdfPath, bytes);
console.log(`export-pdf-downloaded.pdf (${bytes.byteLength} bytes, starts ${bytes.subarray(0, 5).toString('latin1')})`);
await api.dispose();

async function renderPdf() {
  for (const channel of ['msedge', 'chrome']) {
    let viewer;
    try {
      viewer = await chromium.launch({ channel, args: ['--headless=new'] });
    } catch {
      continue;
    }
    try {
      const page = await viewer.newPage({ viewport: { width: 1000, height: 1400 } });
      await page.goto(`file:///${pdfPath.replace(/\\/g, '/')}`, { waitUntil: 'load', timeout: 30_000 });
      await page.waitForTimeout(4000);
      if (await page.locator('embed, object').count() === 0) throw new Error(`${channel} downloaded the file instead of showing it`);
      // The viewer's own toolbar is browser furniture, not the document.
      const toolbar = 46;
      for (const [index, top] of [0, 1190, 2380].entries()) {
        await page.mouse.wheel(0, index === 0 ? 0 : 1190);
        await page.waitForTimeout(900);
        await page.screenshot({
          path: resolve(out, `export-pdf-rendered-p${index + 1}.png`),
          clip: { x: 0, y: toolbar, width: 1000, height: 1400 - toolbar },
        });
        console.log(`export-pdf-rendered-p${index + 1}.png (rendered by ${channel}, scrolled to ${top})`);
      }
      await viewer.close();
      return true;
    } catch (err) {
      console.log(`  ${channel}: ${err.message}`);
      await viewer.close().catch(() => undefined);
    }
  }
  return false;
}

if (!await renderPdf()) {
  console.log('! No browser on this machine renders PDFs, and poppler is not installed.');
  console.log('! The document is saved as export-pdf-downloaded.pdf — open it to review it.');
}
console.log(`Wrote review screenshots to ${out}`);
