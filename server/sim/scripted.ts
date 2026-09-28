/**
 * Replay the production Sessions A and B through the real engine and print
 * the transcripts with their audit (npm run sim:scripted). Uses whatever LLM
 * provider the environment configures, so the same scripts check the model
 * path and the built-in one. Writes to the configured database, like every
 * other lane, and refuses production the same way (sim/session.ts).
 */
import {
  SESSION_A, SESSION_A_COME_BACK, SESSION_A_STOP, SESSION_B, SESSION_B_CLOSING_QUESTION,
  auditScriptedTranscript, createScriptedSession, renderScripted, runScript,
} from './scriptedSessions.js';

async function main(): Promise<void> {
  const runs = [
    { label: 'Session A', script: SESSION_A, opts: {} },
    { label: 'Session A (typed Stop)', script: SESSION_A_STOP, opts: {} },
    { label: 'Session A (come back after exams)', script: SESSION_A_COME_BACK, opts: {} },
    { label: 'Session B', script: SESSION_B, opts: { untilClose: true, closingQuestion: SESSION_B_CLOSING_QUESTION } },
  ];
  let failed = false;
  for (const r of runs) {
    const run = await runScript(await createScriptedSession({}), r.script, r.opts);
    const audit = auditScriptedTranscript(run.lines);
    const bad = audit.askedAfterEnding || audit.repeatedTopics.length > 0 || audit.followedUpNonAnswers.length > 0;
    failed ||= bad;
    process.stdout.write(`\n=== ${r.label} — ended ${run.last.kind}, state ${run.state} ===\n${renderScripted(run.lines)}\n`);
    process.stdout.write(`audit: ${JSON.stringify(audit)}\n`);
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
