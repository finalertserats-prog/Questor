import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { DEMO_BEATS } from '../../web/src/components/demo/demoScript';

/**
 * The guided demo, walked end to end against the real pages: every beat the
 * sandbox offers arrives on its screen with its element in the spotlight and
 * its caption on the player. This is the check that a page change cannot
 * strand the narration in front of a visitor; the unit test on the markup is
 * the fast version of the same promise.
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

async function openDemo(page: Page): Promise<void> {
  await page.goto(`/demo/${mintDemoLink()}`);
  await page.getByRole('button', { name: 'Start demo' }).click();
  await expect(page.getByTestId('demo-start-card')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Hello, Audit.' })).toBeVisible();
}

// Both ways of sitting the interview are the demo-interview lane's to switch
// on; until then the closing card is not offered, and the walk expects that.
const EXPECTED = DEMO_BEATS.filter((beat) => !beat.needsInterviewMode);

test('the story is told over the real pages, beat by beat', async ({ page }) => {
  await openDemo(page);
  await page.getByTestId('demo-start').click();

  for (const beat of EXPECTED) {
    const tour = page.getByTestId('demo-tour');
    await expect(tour).toHaveAttribute('data-beat', beat.id, { timeout: 15_000 });
    // Held still while it is checked: a four-second beat must not move on under the assertions.
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: /Resume/ })).toBeVisible();
    await expect(page.getByTestId('demo-caption')).toHaveText(beat.caption);
    if (beat.anchor) {
      await expect(page.locator(`[data-tour="${beat.anchor}"]`).first()).toBeVisible();
      await expect(page.getByTestId('demo-spotlight')).toBeVisible();
    } else {
      await expect(page.getByTestId('demo-card')).toBeVisible();
    }
    await page.getByTestId('demo-next').click();
  }

  await expect(page.getByTestId('demo-tour')).toHaveCount(0);
  await expect(page).toHaveURL(/\/\?tab=home$|\/$/);
  await expect(page.getByTestId('demo-replay-story')).toBeVisible();
});

test('the door is shown to the signed-in visitor and left again', async ({ page }) => {
  await openDemo(page);
  await page.getByTestId('demo-start').click();
  await page.getByTestId('demo-next').click();
  await expect(page.getByTestId('demo-tour')).toHaveAttribute('data-beat', 'B02', { timeout: 15_000 });
  await expect(page).toHaveURL(/\/o\/.+\?tour=door$/);
  await expect(page.locator('[data-tour="org-signin"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('demo-tour')).toHaveCount(0);
  await expect(page).toHaveURL(/\/$|\/\?tab=/);
});

test('the keys drive it: space pauses, R replays, Escape skips, and the story can be replayed from the bar', async ({ page }) => {
  await openDemo(page);
  await page.getByTestId('demo-start').click();
  await expect(page.getByTestId('demo-tour')).toHaveAttribute('data-beat', 'B01');
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: /Resume/ })).toBeVisible();
  await page.keyboard.press('r');
  await expect(page.getByRole('button', { name: /Pause/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('demo-tour')).toHaveCount(0);
  await page.getByTestId('demo-replay-story').click();
  await expect(page.getByTestId('demo-tour')).toHaveAttribute('data-beat', 'B01');
  await expect(page.getByTestId('demo-start-card')).toHaveCount(0);
});

test('the start card is not asked again after a reload, and skipping it leaves the app live', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: 'Skip — explore Questor instead' }).click();
  await expect(page.getByTestId('demo-start-card')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Home' })).toBeVisible();
  await expect(page.getByTestId('demo-start-card')).toHaveCount(0);
});
