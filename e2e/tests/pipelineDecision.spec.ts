import { expect, test, type Browser, type Page } from '@playwright/test';
import { createRoleAndCandidate, instrumentCandidateBrowser, runId } from './helpers';
import { assessmentIdFromUrl, readTranscriptForReview } from './transcriptRead';

/**
 * Decisions move the hiring pipeline and the candidate journey on their own.
 * A person approves on the pipeline and the candidate is at the next stage;
 * they record "do not progress" and the journey shows that outcome as its
 * final word; a reviewer's verdict on the AI interview does the same from the
 * assessment page, and the candidate's page shows it without anyone pressing
 * "Move to …".
 */

const ANSWER = 'I owned our billing data pipeline end to end: I moved the nightly batch jobs to streaming, '
  + 'added alerting so failures surfaced within minutes, made recovery idempotent so a rerun was always safe, '
  + 'and cut failed loads by sixty percent while keeping the finance team informed at every step.';

async function openJourney(page: Page) {
  await page.getByRole('tab', { name: 'Candidate journey' }).click();
  const track = page.locator('.stage-track');
  await expect(track).toBeVisible({ timeout: 20_000 });
  return track;
}

async function recordDecision(page: Page, decision: 'APPROVED' | 'REJECTED', reason: string) {
  await page.locator('#decision').selectOption(decision);
  await page.locator('#decision-reason').fill(reason);
  await page.getByRole('button', { name: 'Record decision' }).click();
  // Ending a candidacy is confirmed by name before it is recorded.
  if (decision !== 'APPROVED') await page.getByRole('button', { name: 'Yes, record it' }).click();
}

test('approving on the pipeline moves the candidate to the next stage', async ({ page }) => {
  const id = runId();
  await createRoleAndCandidate(page, id);
  const track = await openJourney(page);
  await expect(track.locator('.pipeline-stage.stage-current')).toContainText('Bronze');

  await recordDecision(page, 'APPROVED', 'The profile review shows the experience the role needs.');

  await expect(page.getByTestId('decision-notice')).toContainText('moves to Silver');
  await expect(track.locator('.pipeline-stage.stage-current')).toContainText('Silver');
  await expect(page.getByTestId('journey-outcome')).toContainText('In progress: Silver.');
});

test('recording "do not progress" ends the journey and both views show the outcome', async ({ page }) => {
  const id = runId();
  await createRoleAndCandidate(page, id);
  const track = await openJourney(page);

  await recordDecision(page, 'REJECTED', 'The resume shows no ownership of a production pipeline.');

  await expect(page.getByTestId('pipeline-outcome')).toContainText('Not progressing. The journey ended at Bronze.');
  await expect(page.getByTestId('journey-outcome')).toContainText('Not progressing. The journey ended at Bronze.');
  await expect(track.locator('.pipeline-stage.stage-decided')).toContainText('Bronze');
  await expect(track.locator('.pipeline-stage.stage-skipped')).toHaveCount(3);
});

/** A typed AI interview from invitation to assessment; returns the candidate's page URL and the assessment's. */
async function assessedInterview(page: Page, browser: Browser, id: string) {
  const { candidateUrl } = await createRoleAndCandidate(page, id);
  await page.getByRole('tab', { name: 'Candidate journey' }).click();
  await page.getByRole('button', { name: 'Approve & create interview' }).click();
  await expect(page.getByRole('heading', { name: 'Interview plan', exact: true })).toBeVisible({ timeout: 20_000 });
  const interviewUrl = page.url();

  const invitationCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Invitation', exact: true }) });
  const sendInvitation = invitationCard.getByRole('button', { name: 'Send invitation' });
  if (await sendInvitation.isVisible({ timeout: 1000 }).catch(() => false)) {
    await sendInvitation.click();
    await expect(page.getByText('Invitation created.')).toBeVisible();
  }
  // The link box fills a moment after the invitation exists; reading it early
  // gave an empty string and "Invalid URL".
  const linkBox = invitationCard.getByRole('textbox').first();
  await expect(linkBox).toHaveValue(/^https?:\/\//, { timeout: 20_000 });
  const portalUrl = await linkBox.inputValue();
  const token = new URL(portalUrl).pathname.split('/').filter(Boolean).pop() ?? '';
  expect(token).not.toBe('');

  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const portalPage = await context.newPage();
  await instrumentCandidateBrowser(context, portalPage);
  await portalPage.goto(portalUrl);
  await portalPage.getByRole('button', { name: 'Continue' }).click();
  await portalPage.getByLabel(/I understand this first round is conducted by .+, an AI interviewer/).check();
  await portalPage.getByRole('button', { name: /I consent/ }).click();
  await portalPage.getByRole('button', { name: /Continue anyway/ }).click();
  await portalPage.getByRole('button', { name: 'Join interview' }).click();
  const answerBox = portalPage.getByPlaceholder(/Type your answer/);
  await expect(answerBox).toBeVisible({ timeout: 20_000 });
  await answerBox.fill(ANSWER);
  await portalPage.getByRole('button', { name: 'Send' }).click();
  await expect(answerBox).toHaveValue('', { timeout: 20_000 });
  await context.close();

  let done = false;
  for (let i = 0; i < 60 && !done; i += 1) {
    const res = await page.request.post(`/api/portal/${token}/turn`, { data: { text: ANSWER } });
    expect(res.ok()).toBe(true);
    const body = await res.json() as { turn: { done: boolean } };
    done = body.turn.done;
  }
  expect(done).toBe(true);

  await expect.poll(async () => {
    await page.goto(interviewUrl);
    return (await page.getByTestId('invitation-status').textContent({ timeout: 5_000 }).catch(() => '')) ?? '';
  }, { timeout: 30_000 }).toContain('Interview completed on');
  await page.getByRole('link', { name: 'Open the assessment' }).click();
  await expect(page).toHaveURL(/\/assessments\//);
  await expect(page.getByRole('heading', { name: 'Assessment', exact: true })).toBeVisible({ timeout: 20_000 });
  return { candidateUrl };
}

/**
 * The verdict, as a reviewer records it on the redesigned page: choose, read
 * what it will do, then do it. The consequence is asserted here because the
 * promise and the act being the same thing is the point of the flow, not a
 * detail of it.
 */
async function submitReview(page: Page, verdict: 'PROCEED' | 'DO_NOT_PROGRESS', reason: string, consequence: RegExp) {
  // The server refuses a verdict from a reviewer who has not read the
  // interview. See tests/transcriptRead.ts: this stands in for the control the
  // review page will carry, and makes the same request it will.
  await readTranscriptForReview(page, assessmentIdFromUrl(page.url()));
  await page.getByTestId(`verdict-${verdict}`).click();
  await expect(page.getByTestId('verdict-consequence')).toContainText(consequence);
  await page.getByLabel('Why (required)').fill(reason);
  await page.getByTestId('verdict-act').click();
  await expect(page.getByTestId('verdict-recorded')).toBeVisible({ timeout: 20_000 });
}

test('a review that says proceed leaves the candidate at Gold, progressing to the human rounds', async ({ browser, page }) => {
  test.setTimeout(180_000);
  const { candidateUrl } = await assessedInterview(page, browser, runId());

  await submitReview(page, 'PROCEED', 'Clear ownership of a production pipeline, with outcomes.', /stays at Gold|move .* to Gold/);

  await page.goto(candidateUrl);
  const track = await openJourney(page);
  await expect(track.locator('.pipeline-stage.stage-current')).toContainText('Gold');
  await expect(page.getByTestId('journey-outcome')).toContainText('Progressing to the next round: Gold.');
  await expect(page.getByTestId('pipeline-outcome')).toHaveCount(0);
});

test('a review that says do not progress ends the journey, and the candidate page shows the outcome', async ({ browser, page }) => {
  test.setTimeout(180_000);
  const { candidateUrl } = await assessedInterview(page, browser, runId());

  await submitReview(page, 'DO_NOT_PROGRESS', 'The answers did not show the depth the role needs.', /end .*journey at Gold/);

  await page.goto(candidateUrl);
  const track = await openJourney(page);
  await expect(page.getByTestId('journey-outcome')).toContainText('Not progressing. The journey ended at Gold.');
  await expect(page.getByTestId('pipeline-outcome')).toContainText('Not progressing. The journey ended at Gold.');
  await expect(track.locator('.pipeline-stage.stage-decided')).toContainText('Gold');
  await expect(page.locator('#decision')).toHaveCount(0);
});
