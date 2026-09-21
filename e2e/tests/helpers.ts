import { expect, type BrowserContext, type Page } from '@playwright/test';

export const runId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function roleTitle(id: string) {
  return `E2E Data Engineer ${id}`;
}

export function jobDescription(title: string) {
  return `${title}\nLocation: Remote\nEmployment type: Full-time\nLevel: Senior\n\nAbout the role:\nWe are hiring a senior data engineer to build reliable analytics pipelines and data models.\n\nResponsibilities:\n- Build batch and streaming pipelines with Python, SQL, Airflow, dbt, and Spark.\n- Design dimensional models and keep warehouse data trustworthy.\n- Improve observability, backfills, and incident recovery for production datasets.\n- Partner with product, analytics, and security stakeholders.\n\nRequirements:\n- Strong SQL and data warehousing experience.\n- Production data pipeline ownership.\n- Cloud platform experience and clear written communication.`;
}

export function resumeText(name: string, email: string) {
  return `${name}\nSenior Data Engineer\n${email}\n\nExperience\nSenior Data Engineer, Example Analytics\n- Built Python, Airflow, dbt, Spark, and SQL pipelines for analytics teams.\n- Designed dimensional data models in Snowflake and improved data quality checks.\n- Owned incident response, observability, and backfills for production datasets.\n\nSkills: SQL, Python, Airflow, dbt, Spark, Snowflake, AWS, data modeling`;
}

export async function dismissTour(page: Page) {
  const skip = page.getByRole('button', { name: /skip tour/i });
  if (await skip.isVisible({ timeout: 1000 }).catch(() => false)) await skip.click();
}

export async function createRoleThroughUi(page: Page, title: string) {
  await page.goto('/roles/new');
  await dismissTour(page);
  await expect(page.getByRole('heading', { name: 'New role', exact: true })).toBeVisible();
  // Domain, experience and region are required before a role can be created.
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
  await page.getByPlaceholder(/Paste the full job description/).fill(jobDescription(title));
  await page.getByRole('button', { name: /^Create role$/ }).click();
  // Fairness warnings on the JD hold the page until someone moves on.
  const continueButton = page.getByRole('button', { name: /Continue to the role/ });
  const roleHeading = page.getByRole('heading', { name: title, exact: true });
  await expect(continueButton.or(roleHeading)).toBeVisible({ timeout: 20_000 });
  if (await continueButton.isVisible()) await continueButton.click();
  await expect(roleHeading).toBeVisible({ timeout: 20_000 });
  return page.url();
}

export async function approveRoleIfNeeded(page: Page) {
  const approve = page.getByRole('button', { name: /^Approve scorecard$/ });
  if (await approve.isEnabled({ timeout: 1000 }).catch(() => false)) {
    await approve.click();
    await expect(page.getByRole('button', { name: /^Approved$/ })).toBeVisible();
  }
}

export async function addCandidateThroughUi(page: Page, title: string, name: string, email: string) {
  await page.goto('/candidates/new');
  await dismissTour(page);
  await expect(page.getByRole('heading', { name: 'Add candidate', exact: true })).toBeVisible();
  const form = page.locator('form.card');
  // By label: the Full name field is a combobox too (it searches people already in Questor).
  const roleSelect = form.getByLabel('Role', { exact: true });
  const roleValue = await roleSelect.locator('option').filter({ hasText: title }).first().getAttribute('value');
  if (!roleValue) throw new Error('Created role was not available for candidate creation.');
  await roleSelect.selectOption(roleValue);
  await form.getByLabel('Full name').fill(name);
  await form.getByLabel('Email', { exact: true }).fill(email);
  await page.getByPlaceholder(/Paste the candidate's resume text/).fill(resumeText(name, email));
  await page.getByRole('button', { name: 'Add candidate & analyse resume' }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 20_000 });
}

export async function createRoleAndCandidate(page: Page, id: string) {
  const title = roleTitle(id);
  await createRoleThroughUi(page, title);
  await approveRoleIfNeeded(page);
  const name = `E2E Candidate ${id}`;
  const email = `e2e-${id}@example.test`;
  await addCandidateThroughUi(page, title, name, email);
  return { title, name, email, candidateUrl: page.url() };
}

/**
 * Counts microphone requests instead of granting them, and makes speech
 * synthesis finish at once. Headless Chromium has no audio output, so a real
 * utterance only ends on the page's own watchdog — up to a minute — before
 * the room opens the answer box.
 */
export async function instrumentCandidateBrowser(context: BrowserContext, page: Page) {
  await context.clearPermissions();
  await page.addInitScript(() => {
    const mediaDevices = navigator.mediaDevices ?? {};
    let gumCalls = 0;
    Object.defineProperty(window, '__e2eGetUserMediaCalls', { get: () => gumCalls });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        ...mediaDevices,
        getUserMedia: async () => {
          gumCalls += 1;
          throw new Error('E2E detected an unexpected microphone request');
        },
      },
    });
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        speak: (utterance: SpeechSynthesisUtterance) => {
          setTimeout(() => utterance.onend?.call(utterance, new Event('end') as SpeechSynthesisEvent), 0);
        },
        cancel: () => undefined,
        pause: () => undefined,
        resume: () => undefined,
        getVoices: () => [],
        speaking: false,
        pending: false,
        paused: false,
        onvoiceschanged: null,
      },
    });
  });
}
