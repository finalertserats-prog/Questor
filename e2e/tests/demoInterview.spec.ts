import { expect, test, type Page } from '@playwright/test';
import { instrumentCandidateBrowser } from './helpers';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * The demo interview, both modes, in a real browser.
 *
 * Signed out of the recruiter session throughout the visitor's half: a demo
 * visitor holds a demo session and nothing else, and a test that kept the
 * recruiter cookie would prove the pages work for the wrong person.
 */

const repoRoot = resolve(import.meta.dirname, '../..');

function fixture(command: string): string {
  const out = execFileSync('npx', ['tsx', 'e2e/scripts/demoInterviewFixture.ts', command], {
    cwd: repoRoot, encoding: 'utf8', shell: true,
  });
  // The services the fixture reaches log through pino, which writes to stdout

  // too, so "the last line" is whoever spoke last. The fixture marks its own.

  const marker = 'QUESTOR_FIXTURE_ANSWER:';

  const line = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith(marker));

  const answer = line?.slice(marker.length) ?? '';

  if (!answer) throw new Error(`fixture ${command} produced nothing usable: ${out.slice(-400)}`);

  return answer;

}

/**
 * Open a demo sandbox and land signed in as its visitor, past the tour.
 *
 * The guided tour offers itself on the first load of a new sandbox and covers
 * the bar while it does. It has its own suite; this one skips it and goes to
 * the interview, which is what a visitor who chose to explore first does.
 */
/**
 * Tell the tour it has already been offered, before anything loads.
 *
 * The guided tour has its own suite; this one is about the interview a visitor
 * reaches when they explore first. Set as an init script rather than by
 * clicking Skip because the start card arrives after two network round trips —
 * a conditional click races it, and while it is up the app behind it is inert,
 * so everything this suite wants exists and cannot be clicked.
 */
async function withoutTheStory(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try { window.sessionStorage.setItem('questor-demo-tour-seen', '1'); } catch { /* blocked storage */ }
  });
}

async function openDemo(page: Page): Promise<void> {
  await withoutTheStory(page);
  const token = fixture('link');
  await page.goto(`/demo/${token}`);
  await page.getByRole('button', { name: 'Start demo' }).click();
  await expect(page.getByText(/Demo . ends in/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('demo-start-card')).toHaveCount(0);
}

test.describe('the demo interview', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a visitor watches a whole interview, sees its assessment and leaves feedback', async ({ page }) => {
    test.setTimeout(120_000);
    await openDemo(page);

    // The bar offers it — that is the assertion. It is not clicked: the bar
    // carries a countdown that rewrites itself every second, so the link is
    // never "stable" for long enough, and this test is about the interview
    // rather than about the bar.
    await expect(page.getByRole('link', { name: 'Try the interview' })).toBeVisible({ timeout: 20_000 });
    await page.goto('/demo/interview');
    await expect(page.getByRole('heading', { name: 'Try the interview' })).toBeVisible({ timeout: 20_000 });

    // Both bounds are stated HERE, before anything starts. That is what buys
    // the right to say nothing during the interview.
    await expect(page.getByText(/15 minutes/).first()).toBeVisible();
    await expect(page.getByText(/written candidate/i)).toBeVisible();

    await page.getByRole('button', { name: 'Watch one happen — start' }).click();
    await page.waitForURL(/\/demo\/watch\//, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'You are watching an interview' })).toBeVisible({ timeout: 30_000 });

    // Said on the page at all times, not once at the start.
    await expect(page.getByText(/is a written candidate from Questor/i)).toBeVisible();

    // The conversation arrives over time rather than all at once.
    await expect(page.getByRole('region', { name: 'The conversation' })).toContainText('Hello Ravi', { timeout: 30_000 });
    await expect(page.getByText(/The conversation is still going/)).toBeVisible();

    // A screen reader is told each new turn, once, with the speaker named.
    await expect(page.getByTestId('demo-watch-announcer')).toContainText(/said:/);

    // The clock is behind a press: never beside the interviewer.
    await expect(page.getByText(/minutes left/)).toHaveCount(0);
    await page.getByRole('button', { name: 'How long is left?' }).click();
    await expect(page.getByText(/minutes left/)).toBeVisible();

    // Wind the sitting past the end of the written script.
    fixture('rush-played');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'The interview finished' })).toBeVisible({ timeout: 30_000 });

    // The assessment is the product's own, written from the conversation.
    await page.getByRole('link', { name: 'Read the assessment it wrote' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 });

    // The feedback step, which runs after the session is cleared.
    const ticket = await page.evaluate(async () => {
      const res = await fetch('/api/demo/interview/feedback-ticket', {
        method: 'POST',
        headers: { 'X-CSRF-Token': (document.cookie.match(/questor_csrf=([^;]+)/) ?? [])[1] ?? '' },
      });
      return (await res.json()).token as string;
    });
    expect(ticket).toBeTruthy();

    await page.goto(`/demo/feedback/${ticket}`);
    await expect(page.getByRole('heading', { name: 'What did you make of it?' })).toBeVisible();
    await page.getByLabel('Your feedback').fill('The follow-up about the schema contracts felt like a real interviewer listening.');
    await page.getByRole('button', { name: 'Send it' }).click();
    await expect(page.getByRole('heading', { name: 'Thank you' })).toBeVisible();
  });

  // Owner, 2026-09-24: when it cannot be delivered properly it is absent, not
  // disclaimed. The dev server runs the built-in writer and browser speech, so
  // this is the state the suite's stack is genuinely in.
  test('the candidate-side mode is absent, and nothing explains its absence', async ({ page }) => {
    await openDemo(page);
    await page.goto('/demo/interview');
    await expect(page.getByRole('heading', { name: 'Watch one happen' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Be the candidate' })).toHaveCount(0);

    const body = (await page.locator('main, .demo-choice').first().textContent()) ?? '';
    expect(body).not.toMatch(/unavailable|not available|cannot|quota|credit|budget/i);
  });
});

test.describe('the candidate side of the demo interview', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // Started through the fixture because readiness withdraws this mode on a
  // stack with no real model or speech — a policy the suite covers above. This
  // test is about the interview BEHIND that policy: that it runs, and that the
  // fifteen minutes closes it in the interviewer's own voice.
  test('runs the real interview and is closed in character at the box', async ({ page, browser }) => {
    test.setTimeout(180_000);
    await openDemo(page);
    const portalUrl = fixture('candidate');
    expect(portalUrl).toMatch(/\/portal\//);

    // A candidate holds a link and nothing else: a fresh context, with no
    // console session and no granted permissions.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const visitor = await context.newPage();
    await instrumentCandidateBrowser(context, visitor);
    await visitor.goto(new URL(portalUrl).pathname);

    await visitor.getByRole('button', { name: 'Continue' }).click();
    await visitor.getByLabel(/I understand this first round is conducted by/).check();
    await visitor.getByRole('button', { name: /I consent/ }).click();
    await expect(visitor.getByRole('heading', { name: 'Quick audio check' })).toBeVisible({ timeout: 30_000 });
    await visitor.getByRole('button', { name: /Continue anyway/ }).click();
    await visitor.getByRole('button', { name: 'Join interview' }).click();

    const answerBox = visitor.getByPlaceholder(/Type your answer/);
    await expect(answerBox).toBeVisible({ timeout: 45_000 });

    await answerBox.fill('I run the ingestion layer for a logistics platform: about ninety Airflow DAGs into Snowflake, with dbt on top.');
    await visitor.getByRole('button', { name: /^Send/ }).first().click();
    await expect(answerBox).toHaveValue('', { timeout: 45_000 });

    // Wind the sitting to the point the interviewer must stop asking.
    fixture('rush-close');

    await answerBox.fill('We had a pipeline drop four hours of records after an upstream type change, so I added schema contracts at the ingestion boundary.');
    await visitor.getByRole('button', { name: /^Send/ }).first().click();

    // Past the box the interviewer stops asking and closes. Which words it
    // closes with are the engine's; what is asserted here is that the room
    // ends up closing and that NOTHING in it breaks character. The added
    // "since this is a demo interview" line is asserted directly, against the
    // engine, in server/tests/demoInterview.test.ts — a browser cannot pin
    // down which turn the director had chosen when the box arrived.
    await expect(visitor.getByText(/wrap up|any questions|covers everything/i).first())
      .toBeVisible({ timeout: 90_000 });
    const room = (await visitor.locator('body').textContent()) ?? '';
    expect(room).not.toMatch(/limit reached|quota|unavailable|something went wrong|budget|credit/i);
    await context.close();
  });
});

test.describe('where the owner reads the feedback', () => {
  // The default storage state is the platform operator in the e2e stack.
  test('shows who took which demo, how far they got and what they said', async ({ page }) => {
    await page.goto('/admin/demo-feedback');
    await expect(page.getByRole('heading', { level: 1, name: 'Demo feedback' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Watched one happen|No demo feedback yet/).first()).toBeVisible();
  });
});
