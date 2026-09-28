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
 * It PRESSES the end marker rather than scrolling to it. That is the path a
 * keyboard or screen-reader user takes, it is the one that does not depend on
 * an intersection observer, and if it works the scrolling path is a
 * convenience rather than the only way in.
 *
 * Pressing, not focusing: focus alone no longer counts, because the "skip to
 * the end" control lands focus here and a skip must not stand in for having
 * read the thing.
 */
export async function readTranscriptForReview(page: Page, _assessmentId?: string): Promise<void> {
  const end = page.getByTestId('transcript-end');
  await end.waitFor({ state: 'attached', timeout: 30_000 });
  // The control's own press, reached the way a keyboard user reaches it.
  await end.focus();
  await end.press('Enter');
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
