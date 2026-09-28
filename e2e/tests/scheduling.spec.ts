import { expect, test, type Locator, type Page } from '@playwright/test';
import { createRoleAndCandidate, runId } from './helpers';

/**
 * Times are booked in a time zone picked first, not in the recruiter's own
 * clock: 14:30 in Asia/Kolkata is 09:00 UTC wherever the browser is.
 */

const DAY_MS = 86_400_000;

/** YYYY-MM-DD, some days from now. */
function futureDate(days: number) {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}

/** The next second Sunday of March (US spring-forward), as YYYY-MM-DD, still ahead. */
function nextUsSpringForward() {
  const today = new Date().toISOString().slice(0, 10);
  const secondSunday = (year: number) => {
    const firstDay = new Date(Date.UTC(year, 2, 1)).getUTCDay();
    const firstSunday = 1 + ((7 - firstDay) % 7);
    return `${year}-03-${String(firstSunday + 7).padStart(2, '0')}`;
  };
  const thisYear = new Date().getUTCFullYear();
  return secondSunday(thisYear) > today ? secondSunday(thisYear) : secondSunday(thisYear + 1);
}

/** A candidate with an interview, left on the new interview's page. */
async function createInterview(page: Page) {
  const { candidateUrl } = await createRoleAndCandidate(page, runId());
  await page.getByRole('tab', { name: 'Candidate journey' }).click();
  await page.getByRole('button', { name: 'Approve & create interview' }).click();
  await expect(page).toHaveURL(/\/interviews\/[^/?#]+$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Invitation', exact: true })).toBeVisible({ timeout: 20_000 });
  return { candidateUrl };
}

async function pickTime(picker: Locator, zone: string, date: string, time: string) {
  const zoneBox = picker.getByLabel('Time zone', { exact: true });
  // The picker fills in a suggested zone once the organisation's is known;
  // typing before then could have the suggestion land on top.
  await expect(zoneBox).not.toHaveValue('');
  await zoneBox.fill(zone);
  await picker.getByLabel('Date', { exact: true }).fill(date);
  await picker.getByLabel('Time', { exact: true }).fill(time);
}

test('schedules an interview in Asia/Kolkata and sends the invitation with that time', async ({ page }) => {
  await createInterview(page);
  const invitationCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Invitation', exact: true }) });

  await pickTime(page.getByTestId('schedule-picker'), 'Asia/Kolkata', futureDate(30), '14:30');
  const preview = page.getByTestId('schedule-preview');
  await expect(preview).toContainText('14:30 in Asia/Kolkata');
  await expect(preview).toContainText('09:00 UTC');

  await page.getByRole('button', { name: 'Save schedule and send' }).click();

  const saved = page.getByTestId('scheduled-now');
  await expect(saved).toContainText('14:30', { timeout: 20_000 });
  await expect(saved).toContainText('Asia/Kolkata');
  // Sending created the invitation. The suite's console email provider does
  // not deliver, which the page says; a delivering one reports it saved.
  await expect(page.getByText(/Schedule saved\.|No email was sent/)).toBeVisible();
  await expect(invitationCard.getByLabel('Candidate portal link')).toHaveValue(/\/portal\//);
  await expect(invitationCard.getByRole('button', { name: 'Send invitation' })).toHaveCount(0);
});

test('refuses a time the clocks skip in America/New_York and saves nothing', async ({ page }) => {
  await createInterview(page);

  await pickTime(page.getByTestId('schedule-picker'), 'America/New_York', nextUsSpringForward(), '02:30');

  await expect(page.getByTestId('schedule-preview')).toContainText('does not exist in America/New_York');
  await expect(page.getByRole('button', { name: 'Save schedule and send' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save only' })).toBeDisabled();
  await expect(page.getByTestId('scheduled-now')).toHaveCount(0);
});

test('a pipeline round booked in America/New_York shows New York time and the zone', async ({ page }) => {
  const { candidateUrl } = await createInterview(page);

  await page.goto(candidateUrl);
  await page.getByRole('tab', { name: 'Candidate journey' }).click();
  const roundForm = page.locator('form.pipeline-action').filter({ has: page.getByTestId('round-when-picker') });
  await expect(roundForm).toBeVisible({ timeout: 20_000 });

  await pickTime(roundForm.getByTestId('round-when-picker'), 'America/New_York', futureDate(30), '10:00');
  await expect(roundForm.getByTestId('round-when-preview')).toContainText('10:00 in America/New_York');
  await roundForm.getByRole('button', { name: 'Schedule', exact: true }).click();

  const rounds = page.getByRole('region', { name: 'Interview rounds' });
  await expect(rounds).toContainText(/10:00 GMT-[45] \(America\/New_York\)/, { timeout: 20_000 });
});
