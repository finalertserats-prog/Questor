import { expect, test } from '@playwright/test';
import { createRoleAndCandidate, instrumentCandidateBrowser, runId } from './helpers';

/**
 * A typed interview from invitation to assessment, and what the hiring team
 * sees afterwards: the assessment with its scores straight away (no blind
 * gate unless the organisation requires one), the feedback email recorded as
 * sent, and an invitation card that no longer offers a resend.
 */

const ANSWER = 'I owned our billing data pipeline end to end: I moved the nightly batch jobs to streaming, '
  + 'added alerting so failures surfaced within minutes, made recovery idempotent so a rerun was always safe, '
  + 'and cut failed loads by sixty percent while keeping the finance team informed at every step.';

test('a completed typed interview shows its assessment at once and records the feedback email', async ({ browser, page }) => {
  test.setTimeout(180_000);
  const id = runId();
  await createRoleAndCandidate(page, id);

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
  // Before the candidate starts, the invitation can still be resent.
  await expect(invitationCard.getByRole('button', { name: 'Resend email' })).toBeVisible();
  const portalUrl = await invitationCard.getByRole('textbox').first().inputValue();
  const token = new URL(portalUrl).pathname.split('/').filter(Boolean).pop() ?? '';
  expect(token).not.toBe('');

  // The candidate: consent without voice capture, join, and answer by typing.
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

  // The rest of the answers over the room's own typed-answer endpoint, which
  // is what the room calls; the UI round trip for each is covered by portal.spec.
  let done = false;
  for (let i = 0; i < 60 && !done; i += 1) {
    const res = await page.request.post(`/api/portal/${token}/turn`, { data: { text: ANSWER } });
    expect(res.ok()).toBe(true);
    const body = await res.json() as { turn: { done: boolean }; assessmentReady: boolean };
    done = body.turn.done;
  }
  expect(done).toBe(true);

  // The interview page now says what happened instead of offering a resend.
  // Polled with a reload: the last answer returns as soon as the assessment is
  // written, and the session's own state lands a moment later.
  await expect.poll(async () => {
    await page.goto(interviewUrl);
    return (await page.getByTestId('invitation-status').textContent({ timeout: 5_000 }).catch(() => '')) ?? '';
  }, { timeout: 30_000 }).toContain('Interview completed on');
  await expect(page.getByRole('button', { name: 'Resend email' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Open interview room/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Open the assessment' }).click();
  await expect(page).toHaveURL(/\/assessments\//);
  const assessmentUrl = page.url();

  // The assessment, straight away: no blind gate, and the AI's reading is
  // there to be read.
  await expect(page.getByRole('heading', { name: 'Assessment', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Independent review required')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Review this blind' })).toBeVisible();

  // The transcript comes first, above the readings and the form — with who
  // spoke, when, and what each question was asked for.
  const transcript = page.getByTestId('transcript-reader');
  await expect(transcript.getByTestId('transcript-turn').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('review-facts')).toContainText('Interviewer');
  await expect(transcript.getByText(ANSWER).first()).toBeVisible();
  const transcriptTop = (await transcript.boundingBox())?.y ?? Number.NaN;
  const tabsTop = (await page.getByRole('tablist', { name: 'Assessment readings' }).boundingBox())?.y ?? Number.NaN;
  expect(transcriptTop).toBeLessThan(tabsTop);

  // On a short screen the transcript is longer than the page, so the note
  // asks for it to be read first, and the sticky control offers the review.
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.evaluate(() => window.scrollTo(0, 0));
  // The decision leads the page; the transcript is the column beside it, and
  // the note asks for it to be read before a verdict is recorded.
  await expect(page.getByTestId('verdict-panel')).toBeVisible();
  await expect(page.getByTestId('transcript-read-note')).toContainText('Read the transcript before recording your review');
  await expect(page.getByTestId('assessment-transcript')).toBeVisible();

  // The AI's reading, with its confidence and the one thing it is unsure of.
  await expect(page.getByTestId('verdict-ai')).toBeVisible();
  // Nobody has recorded a verdict yet, so no choice is marked.
  await expect(page.getByTestId('verdict-consequence')).toHaveCount(0);

  // The feedback email is prepared but waiting for the hiring team.
  await page.goto(assessmentUrl);
  await expect(page.getByTestId('feedback-email-status')).toContainText(/on its way|has been sent|No feedback/);

  // A reviewer records their verdict, changing one level along the way. The
  // consequence is on screen before the button is pressed.
  await page.getByTestId('verdict-CONSIDER').click();
  await expect(page.getByTestId('verdict-consequence')).toContainText(/Consider/);
  await page.getByTestId('levels-fold').getByText('Change a level where you read it differently').click();
  const firstLevel = page.locator('select[id^="level-"]').first();
  await firstLevel.selectOption('2');
  await page.locator('input[id^="level-reason-"]').first().fill('Read the transcript differently.');
  await page.getByLabel('Why (required)').fill('I read the evidence on this one differently from the AI.');
  await page.getByTestId('verdict-act').click();
  await expect(page.getByTestId('verdict-recorded')).toBeVisible({ timeout: 20_000 });

  // The reviewer's verdict is now what the page leads with, and the comparison
  // with the AI is kept in its fold.
  await expect(page.getByText("reviewer's verdict")).toBeVisible();
  await page.getByText('Where the reviewer and the AI differ').click();
  await expect(page.getByText(/The reviewer changed 1 of/)).toBeVisible();
  await expect(page.getByText('Read the transcript differently.')).toBeVisible();

  // The completed review releases the candidate's feedback at once.
  const status = page.getByTestId('feedback-email-status');
  await expect.poll(async () => {
    await page.goto(assessmentUrl);
    return (await status.textContent({ timeout: 10_000 })) ?? '';
  }, { timeout: 60_000 }).toContain('Feedback sent to the candidate on');
  const panel = page.getByTestId('feedback-email');
  await panel.getByText('View', { exact: true }).click();
  await expect(panel.getByText(/AT A GLANCE/)).toBeVisible();
  await expect(panel.getByText(/YOUR INTERVIEW IN FOUR PARTS/)).toBeVisible();
  // The four boxes are still four boxes; only the two tone-deaf headings went.
  await expect(panel.getByText(/Worth working on/)).toBeVisible();
  await expect(panel.getByText(/Worth being aware of/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Send feedback now' })).toHaveCount(0);

  // And it lays out on a phone without pushing the page sideways.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(assessmentUrl);
  await expect(page.getByRole('heading', { name: 'Assessment', exact: true })).toBeVisible({ timeout: 20_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
