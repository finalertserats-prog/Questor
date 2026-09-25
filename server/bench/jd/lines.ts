import { contributingLines, maskCollaborationObjects } from '../../src/engines/jdSections.js';
import { GOLD_CASES } from './cases/index.js';
const c = GOLD_CASES.find((g) => g.id === process.argv[2])!;
for (const l of contributingLines(c.jd)) {
  const m = maskCollaborationObjects(l.text);
  console.log(`L${String(l.line).padStart(2)} ${l.section.padEnd(16)} ${m}${m !== l.text ? '   <<MASKED' : ''}`);
}
