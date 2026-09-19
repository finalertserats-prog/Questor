/**
 * Headless end-to-end interview simulation. Proves the full Questor loop works
 * with zero paid keys: role -> scorecard -> candidate -> plan -> live interview
 * (director + conversation runtime) -> independent evaluation -> report.
 *
 * Run: npm run test:e2e -w server
 */
import { prisma, parseJson } from '../db.js';
import { wipe, createDemoData } from './demoData.js';
import { startInterview, submitCandidateTurn, finalizeInterview } from '../realtime/interviewEngine.js';
import { renderReportMarkdown } from '../engines/reportWriter.js';
import type { AssessmentResult } from '../domain/types.js';

// Realistic, evidence-rich candidate answers for a Senior Data Engineer.
const ANSWERS: Array<{ match: RegExp; reply: string }> = [
  { match: /hear me clearly|shall we begin|check that you can hear/i, reply: 'Yes, I can hear you clearly. Thank you, I\'m ready to begin.' },
  { match: /current role|most relevant/i, reply: 'I\'m a Senior Data Engineer at FinEdge Analytics where I own our Snowflake analytical platform serving over 200 analysts. Most recently I led the migration from Redshift to Snowflake, which cut our warehouse cost by about 35% while improving query performance.' },
  { match: /data model|dimensional|schema/i, reply: 'For our finance reporting I designed a dimensional model with conformed dimensions and type-2 slowly changing dimensions for accounts. The context was that analysts needed point-in-time correctness. I chose star schemas over one big table because it kept joins predictable and made testing easier. I added dbt tests for referential integrity and uniqueness, and we validated row counts against source. The result was report latency dropping from 90 seconds to under 8 seconds.' },
  { match: /pipeline|reliability|went wrong|failure/i, reply: 'One critical pipeline processing about 4TB a day started silently dropping late-arriving events. I detected it through a freshness check and a row-count anomaly alert I had set up. I made the pipeline idempotent using merge keys so we could safely backfill, ran a targeted backfill for the affected partitions, and communicated impact to the analytics stakeholders with a clear timeline. Afterwards I added a data-contract test, and overall we reduced pipeline failures by around 60%.' },
  { match: /cloud|platform|architecture|volume|sla/i, reply: 'On AWS I architected the platform to separate storage and compute using Snowflake warehouses sized per workload. For changing volume I used auto-suspend and multi-cluster warehouses, tagged cost by team, and enforced least-privilege access. For observability I instrumented Airflow with SLAs and pushed metrics to CloudWatch. The trade-off I weighed was managed cost versus latency; I ruled out always-on large warehouses because auto-scaling met our SLA at lower cost.' },
  { match: /sql|performance|correctness|partition/i, reply: 'We had a report that was scanning a huge fact table. I looked at the query profile, saw a full scan, and introduced clustering keys on the date and account columns plus partition pruning. I also rewrote a correlated subquery as a window function. I validated correctness by comparing outputs against the previous version on a sample. Latency went from about 90 seconds to under 8.' },
  { match: /disagree|collaborat|analyst|product|conflict/i, reply: 'An analyst and I disagreed on whether to denormalize a table for speed. I listened to their concern about query complexity, then we ran a quick benchmark together. The data showed a materialized view gave us most of the speed without losing flexibility, so we compromised on that. I learned to bring data to disagreements early rather than debating opinions.' },
  { match: /resume|accomplishment|personal contribution|high-value claim|dig into/i, reply: 'The Redshift-to-Snowflake migration is the one I\'m proudest of. My personal contribution was designing the migration plan, building the dbt models, and running a dual-write validation so we could compare outputs. I measured success by cost — a 35% reduction — and by a clean cutover with zero data discrepancies in the validation window.' },
  { match: /machine learning|feature|governance|security|compliance/i, reply: 'I built feature pipelines feeding a fraud model, making sure features were computed consistently between training and serving. On governance I implemented column-level access controls and PII tagging in Snowflake, and we documented data lineage in dbt so auditors could trace any field.' },
  { match: /communication|explain|non-technical/i, reply: 'I regularly explain data issues to finance stakeholders. For a delayed report I avoided jargon, framed it in terms of business impact and expected resolution time, and followed up in writing. Checking their understanding at the end avoided confusion.' },
];

const FOLLOWUP_DEFAULT = 'To add specifics: I personally owned the design and implementation, coordinated with two other engineers, and we measured the outcome through cost savings and reduced incident counts. If I did it again I\'d invest earlier in automated data contracts.';

function answerFor(agentText: string): string {
  for (const a of ANSWERS) if (a.match.test(agentText)) return a.reply;
  if (/questions about the role|next steps|wrap up/i.test(agentText)) return 'No further questions, thank you — I appreciate your time.';
  return FOLLOWUP_DEFAULT;
}

async function main() {
  console.log('\n=== Questor headless interview simulation ===\n');
  await wipe();
  const ids = await createDemoData();
  console.log(`Session ${ids.sessionId} (Senior Data Engineer, candidate Priya Sharma)\n`);

  let agent = await startInterview(ids.sessionId);
  console.log(`AGENT: ${agent.text}\n`);

  let guard = 0;
  while (!agent.done && guard < 40) {
    guard++;
    const reply = answerFor(agent.text);
    console.log(`CANDIDATE: ${reply}\n`);
    agent = await submitCandidateTurn(ids.sessionId, reply, { startMs: guard * 45000, endMs: guard * 45000 + 30000, confidence: 0.92 });
    console.log(`AGENT: ${agent.text}\n`);
  }

  const { assessmentId } = await finalizeInterview(ids.sessionId);
  const a = await prisma.assessmentVersion.findUnique({ where: { id: assessmentId }, include: { session: { include: { candidate: true, role: true } } } });
  if (!a) throw new Error('No assessment produced');
  const result = parseJson<AssessmentResult>(a.resultJson, {} as AssessmentResult);

  console.log('\n============= ASSESSMENT =============\n');
  console.log(renderReportMarkdown({ candidateName: a.session.candidate.fullName, roleTitle: a.session.role.title, assessment: result }));

  // Assertions
  const problems: string[] = [];
  if (!result.recommendation) problems.push('missing recommendation');
  if (!(result.competencies.length > 0)) problems.push('no competency scores');
  if (!(result.evidenceCoverage > 0)) problems.push('zero evidence coverage');
  const scored = result.competencies.filter((c) => !c.notEnoughEvidence);
  if (scored.length === 0) problems.push('no competency received evidence');
  const grounded = scored.every((c) => c.evidence.length > 0);
  if (!grounded) problems.push('a scored competency lacks transcript evidence');

  console.log('\n============= E2E CHECKS =============');
  console.log(`Recommendation:      ${result.recommendation}`);
  console.log(`Overall score:       ${result.overallScore}/100`);
  console.log(`Confidence:          ${Math.round(result.confidence * 100)}%`);
  console.log(`Evidence coverage:   ${Math.round(result.evidenceCoverage * 100)}%`);
  console.log(`Competencies scored: ${scored.length}/${result.competencies.length}`);
  console.log(`Turns recorded:      ${await prisma.turn.count({ where: { sessionId: ids.sessionId } })}`);
  console.log(`All scores grounded: ${grounded ? 'yes' : 'NO'}`);

  await prisma.$disconnect();
  if (problems.length) {
    console.error(`\n❌ E2E FAILED: ${problems.join('; ')}\n`);
    process.exit(1);
  }
  console.log('\n✅ E2E PASSED — full interview completed and assessed end to end.\n');
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
