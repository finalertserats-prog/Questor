import { startJob } from './jobs.js';
import { finishPlayedOutObserverRuns, sweepDemoInterviews } from './demoInterviewFinish.js';

/**
 * The half of the fifteen-minute cap that no request can enforce.
 *
 * A visitor who closes the tab at minute two makes no further requests, so
 * their sitting would sit open for ever: displayed as live, holding a spend
 * allowance, and never producing the assessment it promised. This sweep is
 * what closes it.
 *
 * Every minute rather than hourly, because the thing it is bounding is fifteen
 * minutes long — a sweep slower than the box is not a bound.
 */
export const DEMO_INTERVIEW_SWEEP_MS = 60_000;

export function startDemoInterviewSweep(intervalMs = DEMO_INTERVIEW_SWEEP_MS): () => void {
  return startJob({
    name: 'demo-interview-cap',
    intervalMs,
    ttlMs: 5 * 60_000,
    delayFirst: true,
    fn: async () => {
      const played = await finishPlayedOutObserverRuns();
      const swept = await sweepDemoInterviews();
      return `closed ${played} played-out, ${swept.assessed} at the cap, ${swept.abandoned} abandoned`;
    },
  });
}
