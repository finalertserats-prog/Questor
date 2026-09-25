import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { dismissTour, runId } from './helpers';

interface Seeded {
  readonly tag: string;
  readonly roleSlug: string;
  readonly thinSlug: string;
  readonly band: string;
  readonly competencyKey: string;
  readonly draftA: string;
  readonly draftB: string;
}

function seedLibrary(): Seeded {
  const root = resolve(import.meta.dirname, '../..');
  const out = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'e2e/scripts/seedLibrary.ts', runId().replace(/[^a-z0-9]/gi, '').toLowerCase()], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'file:./data/questor.db' },
  }).toString().trim();
  return JSON.parse(out.split('\n').pop() ?? '{}') as Seeded;
}

/** The browser's CSRF cookie, echoed as the header the server requires on a cookie-authenticated write. */
async function csrfHeader(page: Page): Promise<Record<string, string>> {
  const cookie = (await page.context().cookies()).find((c) => c.name === 'questor_csrf');
  return cookie ? { 'X-CSRF-Token': decodeURIComponent(cookie.value) } : {};
}

test('the platform owner sees pool health and works the queue', async ({ page }) => {
  test.setTimeout(120_000);
  const seeded = seedLibrary();

  await page.goto('/library-admin');
  await dismissTour(page);
  await expect(page.getByRole('heading', { name: 'Question library', exact: true })).toBeVisible();

  // Worker state and pool health render from seeded data.
  await expect(page.getByTestId('library-worker-state')).toBeVisible();
  const poolRow = page.getByTestId('library-pool-row').filter({ hasText: `E2e Library Role ${seeded.tag}` });
  await expect(poolRow).toContainText('4 live');

  // Details show the critic verdict before any decision is taken.
  await page.getByRole('button', { name: `Open entry ${seeded.draftA}` }).click();
  await expect(page.getByTestId('library-critic-verdict')).toContainText('All checks passed');
  await page.getByRole('button', { name: 'Close' }).click();

  // Approve one draft, reject the other with a reason. Both leave the queue.
  await page.getByRole('button', { name: `Approve entry ${seeded.draftA}` }).click();
  await expect(page.getByText('Approved. The entry is probational and can be asked in the sandbox.')).toBeVisible();
  await expect(page.getByRole('button', { name: `Approve entry ${seeded.draftA}` })).toHaveCount(0);
  await page.getByRole('button', { name: `Reject entry ${seeded.draftB}` }).click();
  const rejectForm = page.getByRole('form', { name: `Reject entry ${seeded.draftB}` });
  await rejectForm.getByLabel('Reason').fill('Not specific to this role');
  await rejectForm.getByRole('button', { name: 'Confirm rejection' }).click();
  await expect(page.getByText('Rejected. The reason is kept for the generator.')).toBeVisible();
  await expect(page.getByRole('button', { name: `Approve entry ${seeded.draftB}` })).toHaveCount(0);

  // The decisions are on the entries' history.
  const approved = await page.request.get(`/api/library/admin/entries/${seeded.draftA}`);
  expect(approved.ok()).toBe(true);
  expect((await approved.json()).history.map((h: { action: string }) => h.action)).toEqual(['approved']);
  const rejected = await page.request.get(`/api/library/admin/entries/${seeded.draftB}`);
  expect((await rejected.json()).entry.status).toBe('rejected');
});

test('select returns a ladder for a seeded live pool and an empty ladder for a thin one', async ({ page }) => {
  const seeded = seedLibrary();
  await page.goto('/');
  const headers = await csrfHeader(page);

  const full = await page.request.post('/api/library/select', { headers, data: { roleSlug: seeded.roleSlug, band: seeded.band, competencyKeys: [seeded.competencyKey] } });
  expect(full.ok()).toBe(true);
  const ladder = (await full.json()).ladders[seeded.competencyKey] as { entryId: string; form: string; anchors: string[] }[];
  expect(ladder.length).toBe(3);
  expect(new Set(ladder.map((r) => r.form)).size).toBe(3);
  expect(ladder[0].anchors).toEqual(['Names the failure mode', 'Says what changed after']);

  const thin = await page.request.post('/api/library/select', { headers, data: { roleSlug: seeded.thinSlug, band: seeded.band, competencyKeys: [seeded.competencyKey] } });
  expect(thin.ok()).toBe(true);
  expect((await thin.json()).ladders[seeded.competencyKey]).toEqual([]);
});
