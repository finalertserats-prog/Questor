/**
 * The CV corpus, measured and printed.
 *
 *   cd server && npx tsx scripts/cv-corpus-report.mts
 *
 * Deliberately outside vitest: this is the number that goes in a commit
 * message and a report, and it should not need a database to produce one.
 */
import { measureCorpus, corpusTotals } from '../tests/fixtures/cv/measure.js';

const rows = measureCorpus();
const totals = corpusTotals(rows);

const pct = (pair: readonly [number, number]) =>
  pair[1] === 0 ? 'n/a' : `${pair[0]}/${pair[1]} (${Math.round((pair[0] / pair[1]) * 100)}%)`;

console.log('\nPER FIXTURE');
console.log('id                    roles    dates   current  tech     false+  years  flags  refused');
for (const r of rows) {
  const cells = [
    r.id.padEnd(21),
    `${r.rolesMatched}/${r.rolesExpected}`.padEnd(8),
    `${r.datesCorrect}/${r.rolesExpected}`.padEnd(7),
    (r.currentRoleExpected ? (r.currentRoleCorrect ? 'yes' : 'NO') : '-').padEnd(8),
    `${r.techFound}/${r.techExpected}`.padEnd(8),
    (r.techFalsePositives.join(',') || '-').padEnd(7),
    String(r.totalYears ?? '-').padEnd(6),
    `${r.flagCount}${r.flaggedAsExpected ? '' : '!'}`.padEnd(6),
    r.kind === 'unreadable' ? (r.refused ? 'yes' : 'NO') : '-',
  ];
  console.log(cells.join(' '));
}

console.log('\nTOTALS');
console.log(`  current-role recall      ${pct(totals.currentRoleRecall)}`);
console.log(`  role recall              ${pct(totals.roleRecall)}`);
console.log(`  date accuracy            ${pct(totals.dateAccuracy)}`);
console.log(`  technology recall        ${pct(totals.techRecall)}`);
console.log(`  technology false +ves    ${totals.techFalsePositives}`);
console.log(`  years-of-experience      ${pct(totals.totalYearsAccuracy)}`);
console.log(`  flagging accuracy        ${pct(totals.flagAccuracy)}`);
console.log(`  noise rejection          ${pct(totals.noiseRejection)}`);
console.log('');
