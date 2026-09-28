import { expect, test } from '@playwright/test';
import { createRoleThroughUi, runId } from './helpers';

/**
 * HR adds a technology to a role: the job description is updated once they
 * confirm the section it gains, the competency the stack suggests is offered
 * rather than added, and accepting it puts it on the scorecard with the
 * weights still totalling 100%. The dev server runs the built-in heuristic
 * model, so every step here is deterministic.
 */

const totalText = /Scored weights total 100%/;

test('adds a technology, updates the JD after confirming, and accepts the proposed competency', async ({ page }) => {
  const title = `E2E Data Engineer ${runId()}`;
  await createRoleThroughUi(page, title);
  await expect(page.getByTestId('weights-total')).toHaveText(totalText);
  const before = await page.locator('tr.comp-row').count();

  // Kubernetes is not in this JD, so nothing on the scorecard covers it yet.
  const panel = page.getByTestId('tech-stack-panel');
  await panel.getByTestId('tech-stack-input').fill('Kubernetes');
  await panel.getByTestId('tech-stack-add').click();
  await expect(panel.getByTestId('tech-stack-item')).toHaveCount(1);
  await panel.getByLabel('Level of Kubernetes').selectOption('strong');
  await panel.getByTestId('tech-stack-save').click();

  // The JD has no tech-stack section: the page shows what it would gain and asks first.
  const confirm = panel.getByTestId('tech-stack-confirm');
  await expect(confirm).toContainText('Add a tech-stack section with these 1 technology to the job description?');
  await expect(confirm).toContainText('+ - Kubernetes: strong experience (required)');
  await panel.getByTestId('tech-stack-confirm-yes').click();
  await expect(page.getByText('Tech stack saved and the job description updated.')).toBeVisible();
  await expect(page.getByText('Tech: Kubernetes')).toBeVisible();

  // The competency is proposed, not added: the row count holds until Add is pressed.
  const proposal = panel.getByTestId('tech-stack-proposal');
  await expect(proposal).toHaveCount(1);
  await expect(proposal).toContainText('Kubernetes');
  await expect(page.locator('tr.comp-row')).toHaveCount(before);
  await proposal.getByTestId('tech-stack-proposal-add').click();
  await expect(page.getByText('Kubernetes added to the scorecard.')).toBeVisible();
  await expect(page.locator('tr.comp-row')).toHaveCount(before + 1);
  await expect(page.getByLabel('Name of competency Kubernetes')).toHaveValue('Kubernetes');
  await expect(page.getByTestId('weights-total')).toHaveText(totalText);
  await expect(panel.getByTestId('tech-stack-proposal')).toHaveCount(0);
});

test('suggests the technologies a pasted job description names when creating a role', async ({ page }) => {
  await page.goto('/roles/new');
  await expect(page.getByRole('heading', { name: 'New role', exact: true })).toBeVisible();
  await page.getByPlaceholder(/Paste the full job description/).fill('Build pipelines with Python and Airflow. Familiarity with Terraform is a plus.');
  await page.getByTestId('tech-stack-detect').click();

  const editor = page.getByTestId('tech-stack-editor');
  await expect(editor.getByTestId('tech-stack-item')).toHaveCount(3);
  await expect(editor.getByLabel('Level of Terraform')).toHaveValue('familiar');
  // A nice-to-have arrives unticked, for the person to confirm or change.
  await expect(editor.getByRole('checkbox', { name: 'Required' }).nth(2)).not.toBeChecked();
});
