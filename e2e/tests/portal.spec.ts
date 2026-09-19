import { expect, test } from '@playwright/test';
import { createRoleAndCandidate, instrumentCandidateBrowser, runId } from './helpers';

test('portal consent without voice capture starts typed mode and never asks for microphone', async ({ browser, page }) => {
  const id = runId();
  const { name } = await createRoleAndCandidate(page, id);

  await page.getByRole('tab', { name: 'Candidate journey' }).click();
  // Random is the default; pick one by name so the room can be checked for it.
  await expect(page.getByRole('radio', { name: 'Random — Recommended' })).toBeChecked();
  await page.getByRole('radio', { name: 'Maya', exact: true }).check();
  await page.getByRole('button', { name: 'Approve & create interview' }).click();
  await expect(page.getByRole('heading', { name: 'Interview', exact: true })).toBeVisible({ timeout: 20_000 });

  const invitationCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Invitation', exact: true }) });
  const sendInvitation = invitationCard.getByRole('button', { name: 'Send invitation' });
  if (await sendInvitation.isVisible({ timeout: 1000 }).catch(() => false)) {
    await sendInvitation.click();
    await expect(page.getByText('Invitation created.')).toBeVisible();
  }

  // The read-only portal link comes before the schedule field in this card.
  const portalInput = invitationCard.getByRole('textbox').first();
  await expect(portalInput).toHaveValue(/\/portal\//);
  const portalUrl = await portalInput.inputValue();

  // A fresh context: no recruiter cookies, no permissions granted.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const portalPage = await context.newPage();
  await instrumentCandidateBrowser(context, portalPage);
  await portalPage.goto(portalUrl);
  await expect(portalPage.getByText(`Hello ${name}.`, { exact: false })).toBeVisible();
  // The AI disclosure is on this screen, before the interview, naming the interviewer.
  await expect(portalPage.getByTestId('interviewer-notice')).toHaveText('Your interviewer today is Maya, an AI interviewer from Questor. A person on the hiring team reviews the interview.');
  await portalPage.getByRole('button', { name: 'Continue' }).click();

  // Leave the voice-capture consent unticked, and accept only the AI/human-review consent.
  await portalPage.getByLabel(/I understand this first round is conducted by Maya, an AI interviewer/).check();
  await expect(portalPage.getByLabel(/I consent to my voice being captured/)).not.toBeChecked();
  await portalPage.getByRole('button', { name: /I consent/ }).click();
  await expect(portalPage.getByRole('heading', { name: 'Quick audio check' })).toBeVisible();
  await portalPage.getByRole('button', { name: /Continue anyway/ }).click();
  await portalPage.getByRole('button', { name: 'Join interview' }).click();

  await expect(portalPage.getByPlaceholder(/Type your answer/)).toBeVisible({ timeout: 20_000 });
  await expect(portalPage.getByText('Typing', { exact: true })).toBeVisible();
  // The room shows just the chosen interviewer's name, as on a real call.
  const roomInterviewer = portalPage.getByTestId('room-interviewer');
  await expect(roomInterviewer).toHaveText(/^M\s*Maya$/);
  // The interview opens with a greeting, not a read-out disclosure.
  await expect(portalPage.getByText(/I'm Maya — thanks for making the time today\./).first()).toBeVisible();
  // No listening controls: those only render while the room is capturing voice.
  await expect(portalPage.getByRole('button', { name: 'Done answering' })).toHaveCount(0);
  await expect(portalPage.getByRole('button', { name: 'Voice' })).toHaveCount(0);
  await expect(portalPage.getByText('MIC OPEN')).toHaveCount(0);
  await expect(portalPage.getByText('LIVE TRANSCRIPTION')).toHaveCount(0);
  const micRequests = await portalPage.evaluate(
    () => (window as unknown as { __e2eGetUserMediaCalls?: number }).__e2eGetUserMediaCalls ?? 0,
  );
  expect(micRequests).toBe(0);

  // What the interviewer is saying, without the name label in front of it.
  const captionLine = () => portalPage.locator('.captions p').evaluate((p) => Array.from(p.childNodes)
    .filter((n) => !(n instanceof HTMLElement && n.classList.contains('cap-who')))
    .map((n) => n.textContent ?? '').join('').trim());
  await expect.poll(captionLine).not.toBe('');
  const openingLine = await captionLine();

  // A typed answer must reach the server and bring the next question. Every
  // typed answer once failed with "Invalid request" and this test never sent one.
  const answer = portalPage.getByPlaceholder(/Type your answer/);
  await answer.fill('I lead the data platform team and moved our nightly batch jobs to streaming pipelines.');
  await portalPage.getByRole('button', { name: 'Send' }).click();
  await expect(portalPage.getByText(/your answer was not sent/)).toHaveCount(0);
  await expect(answer).toBeVisible({ timeout: 20_000 });
  await expect(answer).toHaveValue('');
  await expect.poll(captionLine).not.toBe(openingLine);
  const nextQuestion = await captionLine();
  // The room once listened by voice after every typed answer — a closure from
  // its first render still thought it was not typing — and opened the
  // microphone for a candidate who had declined voice capture.
  const micRequestsAfterAnswer = await portalPage.evaluate(
    () => (window as unknown as { __e2eGetUserMediaCalls?: number }).__e2eGetUserMediaCalls ?? 0,
  );
  expect(micRequestsAfterAnswer).toBe(0);

  // A reload mid-interview resumes: the question still owed, not the opening
  // disclosure read out again.
  await portalPage.reload();
  await portalPage.getByRole('button', { name: 'Join interview' }).click();
  await expect.poll(captionLine, { timeout: 20_000 }).toBe(`Welcome back. ${nextQuestion}`);
  await expect(portalPage.getByPlaceholder(/Type your answer/)).toBeVisible();

  // The invitation link, reopened mid-interview, offers the way back in rather
  // than the consent form the server would refuse.
  await portalPage.goto(portalUrl);
  await expect(portalPage.getByText('Your interview is in progress')).toBeVisible();
  await expect(portalPage.getByLabel(/I understand this first round/)).toHaveCount(0);
  await portalPage.getByRole('button', { name: 'Rejoin interview' }).click();
  await expect(portalPage).toHaveURL(/\/room\//);
  await expect(portalPage.getByRole('button', { name: 'Join interview' })).toBeVisible();
  await context.close();
});
