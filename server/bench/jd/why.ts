import { proposeFromJd } from '../../src/engines/jdCompetencies.js';
import { GOLD_CASES } from './cases/index.js';
const id = process.argv[2]; const want = process.argv[3]?.toLowerCase();
const c = GOLD_CASES.find((g) => g.id === id)!;
for (const p of proposeFromJd(c.jd, { title: c.title, band: c.band })) {
  if (want && !p.name.toLowerCase().includes(want)) continue;
  console.log(`${p.name}  [${p.classification} conf=${p.confidence} w=${p.weight}]`);
  for (const s of p.spans) console.log(`    L${s.line} (${s.section}) ${s.text}`);
}
