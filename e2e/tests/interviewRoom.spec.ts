import { expect, test, type Browser, type Page } from '@playwright/test';
import { createRoleAndCandidate, instrumentCandidateBrowser, runId } from './helpers';

/** Invite a fresh candidate and open their room, answering by typing (no voice consent). */
async function openTypedRoom(browser: Browser, page: Page) {
  const id = runId();
  await createRoleAndCandidate(page, id);
  await page.getByRole('tab', { name: 'Candidate journey' }).click();
  await page.getByRole('button', { name: 'Approve & create interview' }).click();
  await expect(page.getByRole('heading', { name: 'Interview plan', exact: true })).toBeVisible({ timeout: 20_000 });

  const invitationCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Invitation', exact: true }) });
  const sendInvitation = invitationCard.getByRole('button', { name: 'Send invitation' });
  if (await sendInvitation.isVisible({ timeout: 1000 }).catch(() => false)) {
    await sendInvitation.click();
    await expect(page.getByText('Invitation created.')).toBeVisible();
  }
  const portalInput = invitationCard.getByRole('textbox').first();
  await expect(portalInput).toHaveValue(/\/portal\//);
  const portalUrl = await portalInput.inputValue();

  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const room = await context.newPage();
  await instrumentCandidateBrowser(context, room);
  await room.goto(portalUrl);
  await room.getByRole('button', { name: 'Continue' }).click();
  await room.getByLabel(/I understand this first round/).check();
  await room.getByRole('button', { name: /I consent/ }).click();
  await room.getByRole('button', { name: /Continue anyway/ }).click();
  await room.getByRole('button', { name: 'Join interview' }).click();
  await expect(room.getByPlaceholder(/Type your answer/)).toBeVisible({ timeout: 20_000 });
  return { context, room };
}

test('a code answer keeps its indentation from the editor to the conversation', async ({ browser, page }) => {
  const { context, room } = await openTypedRoom(browser, page);

  await room.getByRole('button', { name: 'Code', exact: true }).click();
  await expect(room.getByRole('button', { name: 'Code', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const editor = room.getByLabel('Your answer');
  await expect(editor).toHaveAttribute('placeholder', /Indentation is kept/);

  // Tab indents inside the editor.
  await editor.fill('SELECT user_id,\n  COUNT(*) AS n\nFROM events\n');
  await editor.press('End');
  await editor.press('Tab');
  await editor.pressSequentially('GROUP BY user_id;');
  await expect(editor).toHaveValue('SELECT user_id,\n  COUNT(*) AS n\nFROM events\n  GROUP BY user_id;');

  // Esc hands Tab back to the page, so a keyboard user is never trapped.
  await editor.press('Escape');
  await editor.press('Tab');
  await expect(editor).not.toBeFocused();
  await expect(editor).toHaveValue('SELECT user_id,\n  COUNT(*) AS n\nFROM events\n  GROUP BY user_id;');

  await room.getByRole('button', { name: 'Send' }).click();
  await expect(room.getByText(/your answer was not sent/)).toHaveCount(0);
  const sent = room.locator('.room-msg-you pre').last();
  await expect(sent).toBeVisible({ timeout: 20_000 });
  const text = await sent.evaluate((el) => el.textContent ?? '');
  expect(text).toBe('SELECT user_id,\n  COUNT(*) AS n\nFROM events\n  GROUP BY user_id;');
  await expect(editor).toHaveValue('');
  await context.close();
});

test('the room shows the conversation and a confirm step before leaving', async ({ browser, page }) => {
  const { context, room } = await openTypedRoom(browser, page);

  const conversation = room.getByRole('list', { name: 'Conversation so far' });
  await expect(conversation.locator('.room-msg-ai').first()).toBeVisible();
  await expect(room.getByText('Current question')).toBeVisible();

  const answer = room.getByPlaceholder(/Type your answer/);
  await answer.fill('I run the data platform team.');
  await room.getByRole('button', { name: 'Send' }).click();
  await expect(conversation.getByText('I run the data platform team.')).toBeVisible({ timeout: 20_000 });

  // Leaving asks first; staying changes nothing.
  await expect(answer).toBeEnabled({ timeout: 20_000 });
  await room.getByRole('button', { name: 'Leave', exact: true }).click();
  const dialog = room.getByRole('dialog', { name: 'Leave the interview?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Stay in the interview' }).click();
  await expect(dialog).toBeHidden();

  // Confirming ends the interview as the Leave action: a neutral marker in the
  // conversation, not words the candidate never said, and an ending that says
  // they left rather than that their interview was submitted for review.
  await answer.fill('A draft I had not sent');
  await room.getByRole('button', { name: 'Leave', exact: true }).click();
  await dialog.getByRole('button', { name: 'Leave interview' }).click();
  await expect(conversation.getByText('(Left the interview)')).toBeVisible({ timeout: 20_000 });
  const ending = room.getByRole('heading', { name: "You've left the interview." });
  await expect(ending).toBeVisible({ timeout: 20_000 });
  // The control they used is gone; focus lands on the ending, not the page.
  await expect(ending).toBeFocused();
  await expect(room.getByText('submitted for human review')).toHaveCount(0);
  // There is nothing left to leave.
  await expect(room.getByRole('button', { name: 'Leave', exact: true })).toHaveCount(0);
  await context.close();
});
