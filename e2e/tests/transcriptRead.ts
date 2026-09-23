import type { Page } from '@playwright/test';

/**
 * Satisfy the transcript requirement the way the review page will.
 *
 * The server refuses a verdict from a reviewer with no record of having read
 * the interview (POST /assessments/:id/transcript-read). The model and hook
 * the page needs are built — web/src/components/review/transcriptReadGate.ts
 * and useTranscriptReadGate.ts — but the control that calls them belongs to
 * the lane that owns AssessmentView and components/assessment, so it is not on
 * screen yet.
 *
 * Until it is, these specs do from the page what the page itself will do: read
 * the turns the interview has and report them, through the real endpoint, from
 * the reviewer's own authenticated session. When the control lands, this file
 * is replaced by clicking it — the request it makes is the same one.
 */
export async function readTranscriptForReview(page: Page, assessmentId: string): Promise<void> {
  const problem = await page.evaluate(async (id: string) => {
    const csrf = document.cookie.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('questor_csrf='))
      ?.slice('questor_csrf='.length) ?? '';
    const get = async (path: string) => {
      const res = await fetch(`/api${path}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
      return res.json() as Promise<Record<string, unknown>>;
    };

    try {
      const assessment = await get(`/assessments/${id}`);
      const sessionId = assessment.sessionId as string | undefined;
      if (!sessionId) return 'no session id on the assessment';
      const transcript = await get(`/interviews/${sessionId}/transcript`);
      const turns = (transcript.transcript ?? []) as Array<{ index: number }>;

      const res = await fetch(`/api/assessments/${id}/transcript-read`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'X-CSRF-Token': decodeURIComponent(csrf) },
        body: JSON.stringify({ method: 'in_app', seenIndexes: turns.map((turn) => turn.index) }),
      });
      if (!res.ok) return `transcript-read -> ${res.status} ${await res.text()}`;
      return '';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, assessmentId);
  if (problem) throw new Error(`Could not record the transcript as read: ${problem}`);
}

/** The assessment id out of a /assessments/:id URL the spec is already on. */
export function assessmentIdFromUrl(url: string): string {
  const match = /\/assessments\/([^/?#]+)/.exec(url);
  if (!match) throw new Error(`Not an assessment URL: ${url}`);
  return match[1];
}
