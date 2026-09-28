import { runBench } from './score.js';
import { GOLD_CASES } from './cases/index.js';

/**
 * `npm run jd:bench -w server`
 *
 * Prints precision and recall overall and per domain, then every defect it
 * found, so the number can be checked again later by anyone — which is the
 * whole point of measuring rather than asserting.
 *
 * `--json` prints the summary as JSON for a machine.
 * `--case <id>` runs one case and shows what it proposed.
 */
function main(): void {
  const args = process.argv.slice(2);
  const only = args.includes('--case') ? args[args.indexOf('--case') + 1] : null;
  const cases = only ? GOLD_CASES.filter((c) => c.id === only) : GOLD_CASES;
  if (cases.length === 0) {
    console.error(only ? `No case with id "${only}".` : 'The gold set is empty.');
    process.exit(1);
  }

  // `--compare` runs the same gold set through the extractor as it stood
  // before this work, so the improvement is a measurement rather than a claim.
  if (args.includes('--compare')) {
    const before = runBench(cases, 'legacy');
    const after = runBench(cases, 'current');
    console.log(`\nJD competency extraction — ${cases.length} hand-labelled job descriptions\n`);
    console.log(`  ${''.padEnd(12)} ${'precision'.padStart(9)}  ${'recall'.padStart(6)}  ${'F1'.padStart(6)}  ${'forbidden'.padStart(9)}  ${'no span'.padStart(7)}`);
    for (const [label, s] of [['before', before], ['after', after]] as const) {
      console.log(`  ${label.padEnd(12)} ${pct(s.precision).padStart(9)}  ${pct(s.recall).padStart(6)}  ${pct(s.f1).padStart(6)}  ${String(s.forbiddenHits).padStart(9)}  ${String(s.unsupported).padStart(7)}`);
    }
    console.log('\n  by domain              before            after');
    console.log(`  ${'domain'.padEnd(18)} ${'n'.padStart(3)}  ${'prec'.padStart(6)} ${'rec'.padStart(6)}   ${'prec'.padStart(6)} ${'rec'.padStart(6)}`);
    for (const row of after.byDomain) {
      const was = before.byDomain.find((b) => b.domain === row.domain)!;
      console.log(`  ${row.domain.padEnd(18)} ${String(row.cases).padStart(3)}  ${pct(was.precision).padStart(6)} ${pct(was.recall).padStart(6)}   ${pct(row.precision).padStart(6)} ${pct(row.recall).padStart(6)}`);
    }
    console.log('');
    return;
  }

  const summary = runBench(cases);
  if (args.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`\nJD competency extraction — ${cases.length} hand-labelled job descriptions\n`);
  console.log(`  precision   ${pct(summary.precision)}   (of what it proposed, how much was right)`);
  console.log(`  recall      ${pct(summary.recall)}   (of what it should have found, how much it found)`);
  console.log(`  F1          ${pct(summary.f1)}`);
  console.log(`  forbidden   ${summary.forbiddenHits}   (competencies that must never appear — any is a defect)`);
  console.log(`  must-have   ${summary.mustHaveMisses}   (expected essentials that came out otherwise)`);
  console.log(`  unsupported ${summary.unsupported}   (JD-derived competencies with no source span — must be 0)`);

  console.log('\n  by domain');
  console.log(`  ${'domain'.padEnd(18)} ${'n'.padStart(3)}  ${'precision'.padStart(9)}  ${'recall'.padStart(6)}`);
  for (const row of summary.byDomain) {
    console.log(`  ${row.domain.padEnd(18)} ${String(row.cases).padStart(3)}  ${pct(row.precision).padStart(9)}  ${pct(row.recall).padStart(6)}`);
  }

  const defective = summary.cases.filter(
    (c) => c.forbiddenHits.length || c.falsePositives.length || c.falseNegatives.length || c.mustHaveMisses.length || c.unsupported.length,
  );
  if (defective.length > 0) {
    console.log('\n  where it went wrong');
    for (const c of defective) {
      console.log(`\n  ${c.id} — ${c.title}`);
      if (c.forbiddenHits.length) console.log(`    FORBIDDEN     ${c.forbiddenHits.join(', ')}`);
      if (c.falsePositives.length) console.log(`    spurious      ${c.falsePositives.join(', ')}`);
      if (c.falseNegatives.length) console.log(`    missed        ${c.falseNegatives.join(', ')}`);
      if (c.mustHaveMisses.length) console.log(`    not essential ${c.mustHaveMisses.join(', ')}`);
      if (c.unsupported.length) console.log(`    no span       ${c.unsupported.join(', ')}`);
      if (only) console.log(`    proposed      ${c.proposed.join(', ')}`);
    }
  } else {
    console.log('\n  no defects.');
  }
  console.log('');
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

main();
