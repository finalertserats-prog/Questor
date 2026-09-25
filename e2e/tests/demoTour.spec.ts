import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { DEMO_BEATS } from '../../web/src/components/demo/demoScript';

/**
 * The guided demo, walked end to end against the real pages: every beat the
 * sandbox offers arrives on its screen with its element in the spotlight and
 * its card beside it, and nothing moves until the visitor presses Next. This
 * is the check that a page change cannot strand the story in front of a
 * visitor; the unit test on the markup is the fast version of the same promise.
 */

// The suite's recruiter session must not leak in: a demo is its own visitor.
test.use({ storageState: { cookies: [], origins: [] } });

function mintDemoLink(): string {
  const root = resolve(import.meta.dirname, '../..');
  const out = execFileSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'e2e/scripts/makeDemoLink.ts'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'file:./data/questor.db' },
  }).toString().trim();
  // The last line is the token; tsx may print notices above it.
  return out.split(/\r?\n/).pop() ?? '';
}

// The story begins by itself on the welcome card, addressed to the visitor.
async function openDemo(page: Page): Promise<void> {
  await page.goto(`/demo/${mintDemoLink()}`);
  await page.getByRole('button', { name: 'Start demo' }).click();
  await expect(page.getByTestId('tour')).toHaveAttribute('data-step', 'B01');
  await expect(page.getByRole('heading', { name: 'Hello, Audit.' })).toBeVisible();
}

// Watching one is always on offer, so the closing card is part of the walk.
// (Sitting one is not offered on a stack with no live model; the card then
// shows the watched option only, and says nothing about why.)
const EXPECTED = DEMO_BEATS;

test('the story is told over the real pages, one card at a time, at the visitor\'s pace', async ({ page }) => {
  await openDemo(page);

  for (const [index, beat] of EXPECTED.entries()) {
    const tour = page.getByTestId('tour');
    await expect(tour).toHaveAttribute('data-step', beat.id, { timeout: 15_000 });
    const card = page.getByTestId('tour-card');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText(`Step ${index + 1} of ${EXPECTED.length}`);
    await expect(card).toContainText(beat.body.slice(0, 40));
    if (beat.anchor) {
      await expect(page.locator(`[data-tour="${beat.anchor}"]`).first()).toBeVisible();
      await expect(page.getByTestId('tour-spotlight')).toBeVisible();
    } else {
      await expect(page.getByTestId('tour-spotlight')).toHaveCount(0);
    }
    // Nothing advances by itself: the card is still there after a pause.
    await page.waitForTimeout(500);
    await expect(tour).toHaveAttribute('data-step', beat.id);
    await page.getByTestId('tour-next').click();
  }

  await expect(page.getByTestId('tour')).toHaveCount(0);
  await expect(page).toHaveURL(/\/\?tab=home$|\/$/);
  await expect(page.getByTestId('demo-replay-story')).toBeVisible();
});

test('the door is shown to the signed-in visitor and left again', async ({ page }) => {
  await openDemo(page);
  await page.getByTestId('tour-next').click();
  await expect(page.getByTestId('tour')).toHaveAttribute('data-step', 'B02', { timeout: 15_000 });
  await expect(page).toHaveURL(/\/o\/.+\?tour=door$/);
  await expect(page.getByTestId('tour-card')).toBeVisible();
  // The sandbox's own door, with its name on it — not "Link not recognised".
  await expect(page.locator('[data-tour="org-signin"]').getByRole('heading', { name: 'Audit Co (demo)' })).toBeVisible();
  await expect(page.locator('[data-tour="org-signin"]').getByLabel('Email')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tour')).toHaveCount(0);
  await expect(page).toHaveURL(/\/$|\/\?tab=/);
});

test('the keys and the buttons drive it: arrows step, Escape skips, and the story can be replayed from the bar', async ({ page }) => {
  await openDemo(page);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('tour')).toHaveAttribute('data-step', 'B02', { timeout: 15_000 });
  await expect(page.getByTestId('tour-card')).toBeVisible();
  await page.getByTestId('tour-back').click();
  await expect(page.getByTestId('tour')).toHaveAttribute('data-step', 'B01', { timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tour')).toHaveCount(0);
  await page.getByTestId('demo-replay-story').click();
  await expect(page.getByTestId('tour')).toHaveAttribute('data-step', 'B01');
});

test('the closing card hands the visitor to a new role', async ({ page }) => {
  await openDemo(page);
  for (let guard = 0; guard < EXPECTED.length; guard += 1) {
    if ((await page.getByTestId('tour').getAttribute('data-step')) === 'B18') break;
    await page.getByTestId('tour-card').waitFor({ timeout: 15_000 });
    await page.getByTestId('tour-next').click();
  }
  await expect(page.getByTestId('tour')).toHaveAttribute('data-step', 'B18');
  await expect(page.getByTestId('tour-card')).toContainText('Sample data only');
  await page.getByTestId('tour-choice-new-role').click();
  await expect(page.getByTestId('tour')).toHaveCount(0);
  await expect(page).toHaveURL(/\/roles\/new$/);
});

test('End demo is on the card, behind a confirmation', async ({ page }) => {
  await openDemo(page);
  await page.getByTestId('demo-end').click();
  await expect(page.getByTestId('tour-card')).toContainText('End the demo and sign out?');
  await page.getByRole('button', { name: 'Keep going' }).click();
  await expect(page.getByTestId('demo-end')).toBeVisible();
  await expect(page.getByTestId('tour')).toHaveAttribute('data-step', 'B01');
});

test('the story is not begun again after a reload, and skipping it leaves the app live', async ({ page }) => {
  await openDemo(page);
  await page.getByTestId('tour-skip').click();
  await expect(page.getByTestId('tour')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible();
  await expect(page.getByTestId('tour')).toHaveCount(0);
});
