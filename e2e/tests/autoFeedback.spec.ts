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
  await expect(page.getByRole('heading', { name: 'Interview', exact: true })).toBeVisible({ timeout: 20_000 });
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
  await page.goto(interviewUrl);
  await expect(page.getByTestId('invitation-status')).toContainText('Interview completed on');
  await expect(page.getByRole('button', { name: 'Resend email' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Open interview room/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Open the assessment' }).click();

  // The assessment, straight away: scores shown, no blind gate, blind review still offered.
  await expect(page.getByRole('heading', { name: 'Assessment', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Independent review required')).toHaveCount(0);
  await expect(page.getByText('Overall score')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review this blind' })).toBeVisible();

  // The feedback email went from the background job; the page records it.
  const status = page.getByTestId('feedback-email-status');
  await expect.poll(async () => {
    await page.reload();
    return (await status.textContent({ timeout: 10_000 })) ?? '';
  }, { timeout: 60_000 }).toContain('Feedback sent to the candidate on');
  const panel = page.getByTestId('feedback-email');
  await panel.getByText('View', { exact: true }).click();
  await expect(panel.getByText(/Thank you for your interview for .+ at /)).toBeVisible();
  await expect(panel.getByText(/The .+ hiring team/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Send feedback now' })).toHaveCount(0);
});
