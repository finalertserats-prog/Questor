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
  await expect(page.getByRole('heading', { name: 'New Role' })).toBeVisible();
  await page.getByPlaceholder('Senior Data Engineer').fill(title);
  await page.getByLabel('Job description').fill(jobDescription(title));
  await page.getByRole('button', { name: /^Create role$/ }).click();
  const continueButton = page.getByRole('button', { name: /Continue to the role/ });
  if (await continueButton.isVisible({ timeout: 3000 }).catch(() => false)) await continueButton.click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 20_000 });
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
  await expect(page.getByRole('heading', { name: 'Add Candidate' })).toBeVisible();
  const roleSelect = page.getByRole('combobox').first();
  const roleValue = await roleSelect.locator('option').filter({ hasText: title }).first().getAttribute('value');
  if (!roleValue) throw new Error('Created role was not available for candidate creation.');
  await roleSelect.selectOption(roleValue);
  const inputs = page.locator('form.card input');
  await inputs.nth(0).fill(name);
  await inputs.nth(1).fill(email);
  await page.getByLabel('Or paste resume text').fill(resumeText(name, email));
  await page.getByRole('button', { name: /^Add candidate$/ }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 20_000 });
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

export async function assertNoMicrophoneRequest(context: BrowserContext, page: Page) {
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
  });
}