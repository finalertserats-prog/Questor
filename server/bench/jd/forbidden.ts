import { proposeFromJd } from '../../src/engines/jdCompetencies.js';
import { resolveCanonical } from '../../src/domain/taxonomy/index.js';
import { competencyKeyOf } from '../../src/domain/calibration.js';
import { GOLD_CASES } from './cases/index.js';
for (const c of GOLD_CASES) {
  const forbidden = new Set(c.forbid.map((n) => resolveCanonical(n)?.key ?? competencyKeyOf(n)));
  for (const p of proposeFromJd(c.jd, { title: c.title, band: c.band })) {
    if (p.origin !== 'jd' || !forbidden.has(p.key ?? '')) continue;
    console.log(`${c.id} :: ${p.name}`);
    for (const s of p.spans) console.log(`      (${s.section}) ${s.text.slice(0, 120)}`);
  }
}
