/**
 * One interview through Lane A, with a real peer playing the candidate.
 *
 * The cheapest possible proof that the harness is wired to the real engine
 * before a sweep spends an hour finding out it is not.
 *
 * Run: npm run sim:smoke -w server
 */
import { templateRole } from './roleFactory.js';
import { templateCandidate } from './candidateFactory.js';
import { runLaneA } from './laneA.js';
import type { PeerId } from './peers.js';

async function main() {
  const peer = (process.env.SIM_PEER as PeerId) || 'claude';
  const band = (process.env.SIM_BAND as 'emerging') || 'emerging';

  const role = templateRole({ family: 'data_engineering', band });
  const candidate = templateCandidate({ role, band, strength: 'strong' });

  console.log(`\n=== Lane A smoke: ${role.title} · ${candidate.fullName} (${band}, played by ${peer}) ===\n`);

  const t = await runLaneA({ role, candidate, candidatePeer: peer, durationMinutes: 12 });

  for (const turn of t.turns) {
    console.log(`${turn.speaker === 'interviewer' ? 'SCHRANDERS' : 'CANDIDATE '}: ${turn.text}\n`);
  }

  console.log('---');
  console.log(`turns:        ${t.turns.length}`);
  console.log(`endedEarly:   ${t.endedEarly}`);
  console.log(`error:        ${t.error ?? '(none)'}`);
  console.log(`assessment:   ${t.assessment ? `${t.assessment.recommendation} · confidence ${t.assessment.confidence} · coverage ${t.assessment.evidenceCoverage}` : '(none)'}`);
  console.log(`wall clock:   ${(t.durationMs / 1000).toFixed(1)}s`);

  if (t.error) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
