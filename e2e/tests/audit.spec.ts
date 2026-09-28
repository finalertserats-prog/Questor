import { expect, test, type Browser, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The whole-app visual audit. Not part of the normal run (it takes minutes and
 * writes hundreds of screenshots): `AUDIT=1 npx playwright test audit`.
 *
 * It signs in as the seeded admin, follows every internal link it can reach,
 * and on each page at three widths and in both themes records a screenshot,
 * console errors, failed requests, sideways page scroll, and any element that
 * spills outside the card it sits in. The results land in audit-output/ with
 * report.json as the index, so the run is evidence rather than an impression.
 */

test.skip(!process.env.AUDIT, 'Set AUDIT=1 to run the visual audit.');
test.setTimeout(30 * 60_000);

const OUT = resolve(import.meta.dirname, '../audit-output');
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'phone', width: 390, height: 844 },
] as const;
const THEMES = ['light', 'dark'] as const;
const MAX_PER_PATTERN = 2;
const MAX_PAGES = 60;

interface PageFinding {
  readonly route: string;
  readonly viewport: string;
  readonly theme: string;
  readonly screenshot: string;
  readonly consoleErrors: string[];
  readonly failedRequests: string[];
  readonly pageScrollsSideways: boolean;
  readonly overflows: string[];
}

const findings: PageFinding[] = [];

function pattern(path: string): string {
  return path.split('?')[0].replace(/\/[a-z0-9]{20,}(?=\/|$)/gi, '/:id').replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, '/:token');
}

function fileName(route: string, viewport: string, theme: string): string {
  const slug = route.replace(/^\//, '').replace(/[^A-Za-z0-9]+/g, '_') || 'root';
  return `${slug}__${viewport}__${theme}.png`;
}

/** Elements whose box leaves the card they sit in, outside any scroll container. */
async function findOverflows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const scrolls = (el: Element) => {
      const s = getComputedStyle(el);
      return /(auto|scroll|hidden|clip)/.test(s.overflowX);
    };
    for (const card of Array.from(document.querySelectorAll('.card, .panel, section, figure'))) {
      const box = card.getBoundingClientRect();
      if (box.width === 0) continue;
      for (const el of Array.from(card.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        let clipped = false;
        for (let p = el.parentElement; p && p !== card; p = p.parentElement) if (scrolls(p)) { clipped = true; break; }
        if (clipped) continue;
        if (r.left < box.left - 2 || r.right > box.right + 2) {
          const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
          out.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} "${text}" leaves ${card.tagName.toLowerCase()}.${String((card as HTMLElement).className).split(' ')[0]} by ${Math.round(Math.max(box.left - r.left, r.right - box.right))}px`);
        }
      }
    }
    return Array.from(new Set(out)).slice(0, 20);
  });
}

async function capture(browser: Browser, route: string, opts: { storageState?: string; label?: string }) {
  for (const vp of VIEWPORTS) {
    for (const theme of THEMES) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, storageState: opts.storageState });
      await context.addInitScript((t) => {
        try { window.localStorage.setItem('questor-theme', t); window.localStorage.setItem('questor-tour-dismissed', '1'); } catch { /* storage blocked */ }
      }, theme);
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      const failedRequests: string[] = [];
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
      page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 300)}`));
      page.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/')) failedRequests.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
      page.on('requestfailed', (r) => failedRequests.push(`failed ${r.method()} ${r.url()}`));
      await page.goto(route, { waitUntil: 'networkidle' }).catch(() => undefined);
      await page.waitForTimeout(600);
      // Close a tour that opened on its own so it does not cover the page.
      const skip = page.getByRole('button', { name: /skip tour/i });
      if (await skip.isVisible().catch(() => false)) { await skip.click().catch(() => undefined); await page.waitForTimeout(200); }
      const shot = fileName(opts.label ?? route, vp.name, theme);
      await page.screenshot({ path: resolve(OUT, shot), fullPage: true });
      const pageScrollsSideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      findings.push({ route: opts.label ?? route, viewport: vp.name, theme, screenshot: shot, consoleErrors, failedRequests, pageScrollsSideways, overflows: await findOverflows(page) });
      // Written after every capture, so a failure later in the run keeps the evidence.
      writeFileSync(resolve(OUT, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), findings }, null, 2));
      await context.close();
    }
  }
}

async function crawl(page: Page): Promise<string[]> {
  const seen = new Map<string, number>();
  const queue = ['/', '/roles', '/roles/new', '/candidates', '/candidates/new', '/interviews', '/admin', '/audit', '/settings', '/about', '/contact'];
  const routes: string[] = [];
  while (queue.length && routes.length < MAX_PAGES) {
    const route = queue.shift()!;
    const key = pattern(route);
    if ((seen.get(key) ?? 0) >= MAX_PER_PATTERN) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    routes.push(route);
    await page.goto(route, { waitUntil: 'networkidle' }).catch(() => undefined);
    const hrefs = await page.$$eval('a[href^="/"]', (as) => as.map((a) => a.getAttribute('href') ?? ''));
    for (const h of hrefs) if (h && !h.startsWith('/api') && !h.startsWith('/portal') && !h.startsWith('/room') && !queue.includes(h)) queue.push(h);
  }
  return routes;
}

const FIXTURE_ROLES = [
  { title: 'Customer Support Specialist (rehearsal)', candidates: 8 },
  { title: 'Senior Backend Engineer (Payments)', candidates: 3, jdLevel: 'Senior' },
  { title: 'Senior Backend Engineer (Payments)', candidates: 1, jdLevel: 'Lead' },
  { title: 'Senior Backend Engineer (Payments)', candidates: 1, jdLevel: 'Principal' },
  { title: 'Principal Machine Learning Platform Reliability Engineer — Global Payments Infrastructure', candidates: 2 },
  { title: 'Head of Human Resources — India', candidates: 1 },
] as const;

/**
 * Seeds the shapes that broke the dashboard in production: long titles, the
 * same title on three roles, and uneven candidate counts. Idempotent: a role
 * whose exact title and level already exist is reused.
 */
async function seedFixtures(page: Page) {
  const existing = await page.evaluate(async () => (await (await fetch('/api/roles')).json()) as { roles: { title: string; level: string }[] });
  const csrf = await page.evaluate(() => document.cookie.split('; ').find((c) => c.startsWith('questor_csrf='))?.split('=')[1] ?? '');
  for (const [index, spec] of FIXTURE_ROLES.entries()) {
    const level = 'jdLevel' in spec ? spec.jdLevel : '';
    if (existing.roles.some((r) => r.title === spec.title && (!level || r.level === level))) continue;
    const jd = `${spec.title}\nLevel: ${level || 'Senior'}\nLocation: Remote\n\nResponsibilities:\n- Own the work described in the title.\n\nRequirements:\n- Relevant experience.`;
    const role = await page.evaluate(async ({ jd, title, csrf }) => {
      const r = await fetch('/api/roles', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ sourceType: 'paste', sourceText: jd, title, useLlm: false }) });
      return (await r.json()) as { role?: { id: string } };
    }, { jd, title: spec.title, csrf });
    if (!role.role) continue;
    for (let c = 0; c < spec.candidates; c += 1) {
      await page.evaluate(async ({ roleId, n, csrf }) => {
        await fetch('/api/candidates', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ roleId, fullName: `Audit Candidate ${n}`, email: `audit-${n}-${Date.now()}@example.test` }) });
      }, { roleId: role.role.id, n: `${index}-${c}`, csrf });
    }
  }
}

test('visual audit of every reachable page', async ({ browser, page }) => {
  mkdirSync(OUT, { recursive: true });
  const authState = resolve(import.meta.dirname, '../.auth/recruiter.json');
  await page.goto('/');
  await seedFixtures(page);

  // Signed-in pages, found by following links from the main sections.
  const routes = await crawl(page);
  for (const route of routes) await capture(browser, route, { storageState: authState });

  // Public pages, signed out.
  for (const route of ['/login', '/o/acme', '/signup', '/demo', '/demo/not-a-real-token-000000000000', '/demo/ended']) {
    await capture(browser, route, {});
  }

  // A real demo session: redeem a one-time link, then the demo's own pages.
  const root = resolve(import.meta.dirname, '../..');
  const token = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'e2e/scripts/makeDemoLink.ts'], { cwd: root, env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'file:./data/questor.db' } }).toString().trim();
  await runDemoSection(browser, token);

  writeFileSync(resolve(OUT, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), routes, findings }, null, 2));
  const problems = findings.filter((f) => f.consoleErrors.length || f.failedRequests.length || f.pageScrollsSideways || f.overflows.length);
  console.log(`AUDIT pages=${new Set(findings.map((f) => f.route)).size} captures=${findings.length} withProblems=${problems.length}`);
  expect(findings.length).toBeGreaterThan(0);
});

async function runDemoSection(browser: Browser, token: string) {
  const demo = await browser.newContext();
  const demoPage = await demo.newPage();
  await demoPage.goto(`/demo/${token}`);
  await demoPage.getByRole('button', { name: /start demo/i }).click();
  await expect(demoPage.getByText(/Demo · ends in/)).toBeVisible({ timeout: 15_000 });
  const demoState = resolve(OUT, 'demo-state.json');
  await demo.storageState({ path: demoState });
  const portal = await demoPage.evaluate(async () => (await (await fetch('/api/demo/interview')).json()) as { portalUrl?: string });
  await demo.close();
  for (const route of ['/', '/roles', '/candidates', '/interviews']) await capture(browser, route, { storageState: demoState, label: `demo${route === '/' ? '_dashboard' : route}` });
  if (portal.portalUrl) await capture(browser, new URL(portal.portalUrl).pathname, { label: 'demo_candidate_portal' });
}
