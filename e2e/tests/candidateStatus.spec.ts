import { expect, test } from '@playwright/test';
import { createRoleAndCandidate, instrumentCandidateBrowser, runId } from './helpers';
import { assessmentIdFromUrl, readTranscriptForReview } from './transcriptRead';

/**
 * The walk the whole feature exists for: an interview is finished, the
 * candidate opens the same link they were sent, and instead of a dead end they
 * get their status page — then the feedback lands and the same link shows it.
 *
 * Also checked here, because only a real browser can: that the page cannot be
 * used to start another interview, that it carries nothing assessed, and that
 * it lays out on a phone without pushing the page sideways.
 */

const ANSWER = 'I owned our billing data pipeline end to end: I moved the nightly batch jobs to streaming, '
  + 'added alerting so failures surfaced within minutes, made recovery idempotent so a rerun was always safe, '
  + 'and cut failed loads by sixty percent while keeping the finance team informed at every step.';

test('a finished interview turns its invitation link into the candidate status page', async ({ browser, page }) => {
  test.setTimeout(180_000);
  const id = runId();
  const { name } = await createRoleAndCandidate(page, id);

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
  // Waited for, not read straight away: the field renders empty for a moment
  // after the invitation is created, and reading it then yields "".
  const portalInput = invitationCard.getByRole('textbox').first();
  await expect(portalInput).toHaveValue(/\/portal\//, { timeout: 20_000 });
  const portalUrl = await portalInput.inputValue();
  const token = new URL(portalUrl).pathname.split('/').filter(Boolean).pop() ?? '';
  expect(token).not.toBe('');

  // The candidate consents and joins, then answers through the room's own
  // endpoint — the UI round trip for a typed answer is portal.spec's job.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const portalPage = await context.newPage();
  await instrumentCandidateBrowser(context, portalPage);
  await portalPage.goto(portalUrl);
  await portalPage.getByRole('button', { name: 'Continue' }).click();
  await portalPage.getByLabel(/I understand this first round is conducted by .+, an AI interviewer/).check();
  await portalPage.getByRole('button', { name: /I consent/ }).click();
  await portalPage.getByRole('button', { name: /Continue anyway/ }).click();
  await portalPage.getByRole('button', { name: 'Join interview' }).click();
  await expect(portalPage.getByPlaceholder(/Type your answer/)).toBeVisible({ timeout: 20_000 });

  let done = false;
  for (let i = 0; i < 60 && !done; i += 1) {
    const res = await page.request.post(`/api/portal/${token}/turn`, { data: { text: ANSWER } });
    expect(res.ok()).toBe(true);
    const body = await res.json() as { turn: { done: boolean } };
    done = body.turn.done;
  }
  expect(done).toBe(true);

  // --- the same link, reopened after the interview ------------------------
  await portalPage.goto(portalUrl);

  await expect(portalPage.getByRole('heading', { level: 1 })).toContainText(name.split(' ')[0], { timeout: 20_000 });
  await expect(portalPage.getByText(/can’t start another interview/)).toBeVisible();
  await expect(portalPage.getByRole('heading', { name: 'Where you are' })).toBeVisible();
  await expect(portalPage.getByRole('heading', { name: 'What happens next' })).toBeVisible();

  // It is a status page, not an invitation: nothing here can consent again.
  await expect(portalPage.getByLabel(/I understand this first round/)).toHaveCount(0);
  await expect(portalPage.getByRole('button', { name: /I consent/ })).toHaveCount(0);
  await expect(portalPage.getByRole('button', { name: 'Join interview' })).toHaveCount(0);

  // And nothing assessed reaches it, whatever the assessment said.
  const shown = (await portalPage.locator('body').textContent()) ?? '';
  expect(shown).not.toMatch(/PROCEED|CONSIDER|DO_NOT_PROGRESS/);
  expect(shown).not.toMatch(/score|verdict|competenc|recommendation/i);

  // A way to reach a person is on the page, and asking is recorded once.
  const askForAPerson = portalPage.getByRole('button', { name: /speak to someone/ });
  await expect(askForAPerson).toBeVisible();
  await askForAPerson.click();
  await expect(portalPage.getByTestId('cstatus-talk-recorded')).toBeVisible({ timeout: 20_000 });
  await portalPage.reload();
  await expect(portalPage.getByTestId('cstatus-talk-recorded')).toBeVisible({ timeout: 20_000 });

  // On a phone, in one column, with no sideways scroll.
  await portalPage.setViewportSize({ width: 375, height: 800 });
  await portalPage.reload();
  await expect(portalPage.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 });
  const overflow = await portalPage.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // --- the feedback arrives, and the same link shows it -------------------
  // A completed review releases the candidate's letter at once.
  // Polled with a reload: the assessment is written a moment after the last
  // answer comes back, and the page renders after that again.
  await expect.poll(async () => {
    await page.goto(interviewUrl);
    await page.getByTestId('invitation-status').waitFor({ timeout: 10_000 }).catch(() => undefined);
    return page.getByRole('link', { name: 'Open the assessment' }).count();
  }, { timeout: 90_000 }).toBeGreaterThan(0);
  await page.getByRole('link', { name: 'Open the assessment' }).click();
  await expect(page).toHaveURL(/\/assessments\//, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Assessment', exact: true })).toBeVisible({ timeout: 20_000 });
  // The server refuses a verdict from a reviewer who has not read the
  // interview; this presses the page's own control. See tests/transcriptRead.ts.
  await readTranscriptForReview(page, assessmentIdFromUrl(page.url()));
  await page.getByTestId('verdict-CONSIDER').click();
  await page.getByLabel('Why (required)').fill('Read the evidence the same way; recording it so the letter goes.');
  await page.getByTestId('verdict-act').click();
  await expect(page.getByTestId('verdict-recorded')).toBeVisible({ timeout: 30_000 });

  await expect.poll(async () => {
    await portalPage.reload();
    return (await portalPage.getByTestId('cstatus-letter').textContent({ timeout: 5_000 }).catch(() => '')) ?? '';
  }, { timeout: 90_000 }).not.toBe('');

  await expect(portalPage.getByRole('heading', { name: 'Feedback from your conversation' })).toBeVisible();
  await expect(portalPage.getByText(/Decisions are always made by people/)).toBeVisible();
  // The letter is theirs; the assessment behind it is still not.
  const withLetter = (await portalPage.locator('body').textContent()) ?? '';
  expect(withLetter).not.toMatch(/PROCEED|CONSIDER|DO_NOT_PROGRESS/);

  await context.close();
});
