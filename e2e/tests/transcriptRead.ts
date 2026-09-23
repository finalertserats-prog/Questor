import { expect, type Page } from '@playwright/test';

/**
 * Satisfy the transcript requirement the way a reviewer does.
 *
 * The server refuses a verdict from a reviewer with no record of having read
 * the interview. This used to fake that record by calling the endpoint from
 * the test session, because the control that makes it did not exist yet. It
 * does now, so these specs press it — which is the only version of this helper
 * that proves a real reviewer can get through the gate at all.
 *
 * It reaches the end marker by FOCUS rather than by scrolling. That is the
 * path a keyboard or screen-reader user takes, it is the one that does not
 * depend on an intersection observer, and if it works the scrolling path is a
 * convenience rather than the only way in.
 */
export async function readTranscriptForReview(page: Page, _assessmentId?: string): Promise<void> {
  const end = page.getByTestId('transcript-end');
  await end.waitFor({ state: 'attached', timeout: 30_000 });
  // focus(), not click(): a click would also scroll, and then a regression in
  // the keyboard path would still pass here.
  await end.focus();
  // The page records the read as soon as everything has been shown, so the
  // note is what says the server accepted it.
  await expect(page.getByTestId('transcript-read-note')).toContainText(/You have read this transcript/, { timeout: 30_000 });
}

/** The assessment id out of a /assessments/:id URL the spec is already on. */
export function assessmentIdFromUrl(url: string): string {
  const match = /\/assessments\/([^/?#]+)/.exec(url);
  if (!match) throw new Error(`Not an assessment URL: ${url}`);
  return decodeURIComponent(match[1]);
}
