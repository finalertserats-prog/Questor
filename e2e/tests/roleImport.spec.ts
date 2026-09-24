import { expect, test } from '@playwright/test';
import { dismissTour, jobDescription, roleTitle, runId } from './helpers';

/**
 * Creating a role from an uploaded job description file.
 *
 * The point of the flow is the step in the middle: the file is read, the text
 * is shown for a person to check and correct, and only then does the ordinary
 * create run. So the spec edits the extraction before submitting, and asserts
 * the edit is what reached the role — not the file's own words.
 */
test('creates a role from an uploaded Markdown job description', async ({ page }) => {
  const id = runId();
  const title = roleTitle(id);
  const marker = `E2E corrected line ${id}`;

  await page.goto('/roles/new');
  await dismissTour(page);
  await expect(page.getByRole('heading', { name: 'New role', exact: true })).toBeVisible();

  const pick = async (label: string) => {
    const select = page.getByLabel(label, { exact: true });
    await expect(select.locator('option').nth(1)).toBeAttached();
    await select.selectOption({ index: 1 });
  };
  await pick('Domain');
  await pick('Experience');
  await pick('Region');

  const titleBox = page.getByRole('combobox', { name: /Role title/ });
  await titleBox.fill(title);
  await titleBox.press('Escape');
  // A test title must not be published to the shared catalog on every run.
  const share = page.getByRole('checkbox', { name: /Add this title to the shared role catalog/ });
  if (await share.isVisible().catch(() => false)) await share.uncheck();

  await page.getByRole('radio', { name: 'A job description file' }).check();
  await page.getByLabel(/Job description file/).setInputFiles({
    name: 'senior-data-engineer.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(`# ${title}\n\n${jobDescription(title)}`),
  });

  // What the file was, beside what came out of it.
  await expect(page.getByTestId('jd-extraction')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('senior-data-engineer.md')).toBeVisible();
  const extracted = page.getByRole('textbox', { name: /edit anything the file got wrong/i });
  await expect(extracted).toHaveValue(/About the role/);

  // The extraction is a draft, not a verdict: correct it before creating.
  await extracted.fill(`${await extracted.inputValue()}\n\n${marker}`);

  await page.getByRole('button', { name: /^Create role$/ }).click();
  const continueButton = page.getByRole('button', { name: /Continue to the role/ });
  const roleHeading = page.getByRole('heading', { name: title, exact: true });
  await expect(continueButton.or(roleHeading)).toBeVisible({ timeout: 30_000 });
  if (await continueButton.isVisible()) await continueButton.click();
  await expect(roleHeading).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(marker).first()).toBeVisible();
});

test('refuses a file whose contents do not match the type it claims', async ({ page }) => {
  await page.goto('/roles/new');
  await dismissTour(page);
  await page.getByRole('radio', { name: 'A job description file' }).check();

  await page.getByLabel(/Job description file/).setInputFiles({
    name: 'not-really.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('This is plain text wearing a PDF name.'),
  });

  await expect(page.getByText(/does not match its declared file type/i)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('jd-extraction')).toHaveCount(0);
});

test('offers a way back out of a chosen file', async ({ page }) => {
  const title = roleTitle(runId());

  await page.goto('/roles/new');
  await dismissTour(page);
  await page.getByRole('radio', { name: 'A job description file' }).check();
  await page.getByLabel(/Job description file/).setInputFiles({
    name: 'jd.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(jobDescription(title)),
  });

  await expect(page.getByTestId('jd-extraction')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: /Remove jd\.txt/ }).click();

  // The file is detached, but the words it produced are not thrown away: by
  // now they may have been edited, and they are the only copy.
  await expect(page.getByTestId('jd-file-facts')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Job description', exact: true })).toHaveValue(/About the role/);
});
