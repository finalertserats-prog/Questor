import type { PrismaClient } from '@prisma/client';
import type { AssessmentResult, Competency, CompetencyScore, EvidenceSpan, Proficiency, RoleSuccessProfile } from '../domain/types.js';
import { normalizeProfile } from '../engines/resumeParser.js';
import { computeFitScore } from '../engines/fitScoring.js';
import { buildInterviewPlan } from '../engines/interviewPlanner.js';
import { renderReportMarkdown } from '../engines/reportWriter.js';
import { normalizeEmail } from '../services/userEmail.js';
import { DEFAULT_DISCLOSURE_BODY, composeDisclosure } from '../domain/interviewerModel.js';
import { DEMO_RESUME } from './demoData.js';

/**
 * The hiring story the guided demo tells: one role, one candidate who has
 * already been interviewed, and the evidence that interview left behind.
 *
 * Everything here is fixed text, on purpose. The demo's narration is recorded
 * once, so what it points at can never be allowed to drift; and a prospect
 * reads this closely, so every level must be defensible from the quote beside
 * it. The seeder checks the second property at build time: an evidence quote
 * that is not verbatim in the turn it cites throws before anything is written.
 */

export const DEMO_STORY_CANDIDATE_NAME = 'Priya Sharma';
export const DEMO_STORY_CANDIDATE_EMAIL = 'priya.sharma@example.com';
export const DEMO_STORY_INTERVIEWER = 'Maya';
/** The slot Priya's interview was booked for; the transcript ends well inside it. */
export const DEMO_STORY_DURATION_MINUTES = 30;

// ---------------------------------------------------------------------------
// The scorecard, as the hiring manager approved it
// ---------------------------------------------------------------------------

interface CuratedCompetency {
  readonly name: string;
  readonly classification: Competency['classification'];
  readonly weight: number;
  readonly requiredLevel: Proficiency;
  readonly targetLevel: Proficiency;
  readonly mustPass?: boolean;
  readonly definition: string;
  readonly indicators: readonly string[];
}

/**
 * Ten competencies a hiring manager for a senior data engineer would actually
 * list, weighted by what the role spends its days on. The heuristic extracts
 * a superset of these from the job description (plus "Product Management",
 * from "partner with product teams"); this is the set a person keeps.
 */
export const DEMO_SCORECARD: readonly CuratedCompetency[] = [
  {
    name: 'SQL & Data Warehousing', classification: 'essential', weight: 0.16, requiredLevel: 3, targetLevel: 4, mustPass: true,
    definition: 'Writes and tunes complex SQL on a cloud warehouse, and reasons about layout, pruning and cost rather than syntax alone.',
    indicators: ['Diagnoses a slow query from its profile, not by guesswork', 'Chooses clustering or partitioning for a stated reason', 'Proves a rewrite is still correct before switching'],
  },
  {
    name: 'Data Engineering & Pipelines', classification: 'essential', weight: 0.16, requiredLevel: 3, targetLevel: 4, mustPass: true,
    definition: 'Builds batch and streaming pipelines that handle the real failure modes: late data, duplicates, schema drift, re-runs.',
    indicators: ['Names a concrete mechanism for late or duplicate events', 'Designs for safe re-runs and backfills', 'Has owned a pipeline end to end in production'],
  },
  {
    name: 'Reliability & Operations', classification: 'essential', weight: 0.14, requiredLevel: 3, targetLevel: 4, mustPass: true,
    definition: 'Detects failures before the business does, recovers without heroics, and can show the outcome in numbers.',
    indicators: ['Built the check that caught the incident', 'Made recovery idempotent, not manual', 'Measures incidents and can say how the count changed'],
  },
  {
    name: 'Data Modeling', classification: 'essential', weight: 0.12, requiredLevel: 3, targetLevel: 4,
    definition: 'Designs dimensional models that answer the analysts’ actual question, including point-in-time correctness.',
    indicators: ['Starts from what the report must be true of', 'Chooses between star, wide table or SCD with a reason', 'Tests keys and reconciles totals against the source'],
  },
  {
    name: 'Cloud & Platform Architecture', classification: 'preferred', weight: 0.10, requiredLevel: 2, targetLevel: 3,
    definition: 'Runs the platform on AWS so that cost tracks the workload and the SLA holds as volume changes.',
    indicators: ['Separates storage and compute deliberately', 'Can name the trade-off ruled out and why', 'Attributes cost to the teams that spend it'],
  },
  {
    name: 'Security & Compliance', classification: 'preferred', weight: 0.06, requiredLevel: 2, targetLevel: 3,
    definition: 'Applies least privilege, data classification and audit trails to the data platform without slowing the analysts down.',
    indicators: ['Has implemented role- or column-level access', 'Knows where sensitive fields live and who can read them', 'Can describe an audit or governance control they built'],
  },
  {
    name: 'Communication', classification: 'essential', weight: 0.10, requiredLevel: 3, targetLevel: 4,
    definition: 'Explains data problems to non-technical stakeholders in terms of impact and time, and checks they understood.',
    indicators: ['Leads with impact and timing, not cause', 'Follows up in writing', 'Confirms understanding rather than assuming it'],
  },
  {
    name: 'Problem Solving', classification: 'essential', weight: 0.08, requiredLevel: 3, targetLevel: 4,
    definition: 'Turns an unclear or contradictory ask into something that can be built, by finding the real need behind it.',
    indicators: ['Separates what was asked from what is needed', 'Writes the problem down before solving it', 'Validates the solution with the people who asked'],
  },
  {
    name: 'Collaboration', classification: 'essential', weight: 0.05, requiredLevel: 3, targetLevel: 4,
    definition: 'Works with analysts and product partners as peers, and settles disagreement with evidence rather than seniority.',
    indicators: ['Brings data to a disagreement early', 'Can say what the other side needed and how it felt to them', 'Describes the working relationship afterwards, not only the outcome'],
  },
  {
    name: 'Ownership & Impact', classification: 'preferred', weight: 0.03, requiredLevel: 2, targetLevel: 4,
    definition: 'Takes end-to-end ownership of a piece of the platform and can state its outcome in a number.',
    indicators: ['Owned the plan, not only a task within it', 'Quantifies the result', 'Says what they would do differently'],
  },
];

const DEMO_ROLE_CONTEXT = 'Own the analytical data platform on Snowflake: reliable batch and streaming pipelines, the dimensional models finance and product report from, and an AWS platform whose cost tracks its workload and whose SLA holds as volume changes.';

/** The job description's own bullets; the heuristic also sweeps up its introductory sentences. */
const DEMO_RESPONSIBILITIES = [
  'Design robust, testable analytical data models and dimensional schemas.',
  'Build and operate batch and streaming pipelines using Python, Airflow, dbt and Spark.',
  'Own reliability of critical pipelines including detection, idempotent recovery and backfills.',
  'Architect cloud data platform on AWS for changing volume, cost and SLA.',
  'Write and optimize complex SQL; reason about performance, partitioning and correctness.',
  'Collaborate with analysts, product and engineering; handle disagreement constructively.',
];

const DEMO_OUTCOMES = [
  'Critical pipelines detect their own failures and recover idempotently, with backfills that need no heroics.',
  'Finance and product report from models they trust, with point-in-time correctness where it matters.',
  'Warehouse cost tracks the workload, and nobody is surprised by the bill.',
];

/**
 * The heuristic's extraction of DEMO_JD, curated into the scorecard above.
 * Ids and source spans are kept from the extraction so the role page shows a
 * scorecard linked to its job description the way a real one is.
 */
export function curateDemoScorecard(extracted: RoleSuccessProfile): RoleSuccessProfile {
  const competencies: Competency[] = DEMO_SCORECARD.map((curated) => {
    const found = extracted.competencies.find((c) => c.name === curated.name);
    if (!found) throw new Error(`Demo scorecard: the role heuristic no longer extracts "${curated.name}" from DEMO_JD`);
    return {
      ...found,
      classification: curated.classification,
      weight: curated.weight,
      requiredLevel: curated.requiredLevel,
      targetLevel: curated.targetLevel,
      definition: curated.definition,
      indicators: [...curated.indicators],
    };
  });
  const mustPassCompetencyIds = competencies.filter((_, i) => DEMO_SCORECARD[i].mustPass === true).map((c) => c.id);
  return {
    ...extracted,
    roleContext: DEMO_ROLE_CONTEXT,
    outcomes: [...DEMO_OUTCOMES],
    responsibilities: [...DEMO_RESPONSIBILITIES],
    competencies,
    // A competency the interview never reached is left out of the overall
    // score rather than counted as zero; the assessment says so where it happens.
    scoringRules: { ...extracted.scoringRules, mustPassCompetencyIds, passThreshold: 65, notEnoughEvidencePolicy: 'exclude' },
  };
}

// ---------------------------------------------------------------------------
// The transcript, as it happened
// ---------------------------------------------------------------------------

interface StoryTurn {
  readonly speaker: 'agent' | 'candidate';
  readonly text: string;
  /** How long the turn took to say, in seconds. */
  readonly seconds: number;
  /** The competency an agent question is asking after, by scorecard name. */
  readonly asks?: string;
  readonly followUp?: true;
}

// A question is followed by a few seconds of thought; an answer by a shorter
// pause before the next question. Both are what a real transcript's times show.
const THINK_MS = 8_000;
const BREATH_MS = 4_000;

export const DEMO_STORY_TRANSCRIPT: readonly StoryTurn[] = [
  { speaker: 'agent', seconds: 20, text: 'Hello Priya, I’m Maya. Thank you for making the time. This is the first-round interview for the Senior Data Engineer role. It takes about half an hour, and everything you say is kept as a transcript for the hiring team, who make the decision. Before we begin: can you hear me clearly, and are you ready to start?' },
  { speaker: 'candidate', seconds: 7, text: 'Yes, I can hear you clearly, and I’m ready. Thank you.' },
  { speaker: 'agent', seconds: 14, asks: 'Ownership & Impact', text: 'Let’s start with where you are now. Tell me about your current role at FinEdge Analytics, and the part of it you think is most relevant to this position.' },
  { speaker: 'candidate', seconds: 118, text: 'I’m a Senior Data Engineer at FinEdge Analytics, where I own the analytical data platform on Snowflake. It serves a little over two hundred internal analysts, mostly in finance and risk. The part most relevant to this role is probably the migration from Redshift to Snowflake that I led last year. I wrote the migration plan, rebuilt the core models in dbt, and ran a dual-write validation for six weeks so that every report could be compared against its old version before we cut over. The outcome was a thirty-five percent reduction in warehouse cost, and a cutover with zero discrepancies in the validation window. Day to day, I look after pipeline reliability, the data models the finance team reports from, and the cost of the platform.' },
  { speaker: 'agent', seconds: 16, asks: 'Data Modeling', text: 'Let’s go into the modelling side of that. Describe a data model you designed for finance reporting: what the analysts needed, the choices you made, and how you tested it.' },
  { speaker: 'candidate', seconds: 132, text: 'The finance team needed point-in-time correctness. A report for March had to show the account hierarchy as it stood in March, even if an account moved cost centres in April. So I designed a star schema with conformed dimensions, and a type-two slowly changing dimension for accounts, with effective-from and effective-to dates on every row. I chose a star over one wide table because the joins stay predictable and each dimension can be tested on its own. In dbt I added uniqueness and referential-integrity tests on every key, and every night we reconciled row counts and totals against the source ledger. The visible result for the analysts was that the month-end close report went from about ninety seconds to under eight, and the finance controller stopped keeping her own spreadsheet copy, which is the outcome I cared about most.' },
  { speaker: 'agent', seconds: 15, asks: 'Reliability & Operations', text: 'Now reliability. Tell me about a time a critical pipeline went wrong. How did you find out, what did you do, and what changed afterwards?' },
  { speaker: 'candidate', seconds: 124, text: 'We had a pipeline processing about four terabytes a day that started silently dropping late-arriving events. The job succeeded every night; the numbers were just short. I found it through a freshness check and a row-count anomaly alert that I had put in place a few months earlier, which is the only reason it was caught in days rather than at quarter end. The fix had two parts. First we made the pipeline idempotent, using merge keys, so that any partition could be re-run safely. Then we ran a targeted backfill for the affected days and told the analytics stakeholders exactly which reports had been wrong and for how long. Afterwards we added a data-contract test on the source, and over the following two quarters pipeline failures fell by around sixty percent.' },
  { speaker: 'agent', seconds: 12, asks: 'Reliability & Operations', followUp: true, text: 'You said “we” for the fix and the backfill. What was your personal contribution, and how did you measure that it had worked?' },
  { speaker: 'candidate', seconds: 74, text: 'That’s fair. The idempotent redesign was mine: I wrote the merge logic and chose the partition keys. The backfill was run by a colleague, from a runbook I wrote for it. I measured it two ways. The row-count anomaly alert stopped firing for that pipeline, and the incident count for the whole platform, which I track in our on-call log, went from roughly five a month to two.' },
  { speaker: 'agent', seconds: 14, asks: 'SQL & Data Warehousing', text: 'Let’s talk about SQL. Walk me through a query you optimised: what was slow, how you diagnosed it, and how you knew the result was still correct.' },
  { speaker: 'candidate', seconds: 104, text: 'The month-end report was scanning the full fact table every time it ran. I opened the query profile in Snowflake and saw a full table scan with no pruning at all. I put clustering keys on the date and account columns so that partition pruning could work, and I rewrote a correlated subquery as a window function, which removed a nested loop. For correctness, I ran the old query and the new one against a fixed sample and compared the outputs row by row before switching. That’s the ninety-seconds-to-eight change I mentioned earlier.' },
  { speaker: 'agent', seconds: 14, asks: 'Data Engineering & Pipelines', text: 'Before Snowflake you worked on streaming. Tell me about the clickstream pipelines at ShopStack: what they had to do, and what made them hard.' },
  { speaker: 'candidate', seconds: 120, text: 'At ShopStack I built the clickstream pipelines on Spark Structured Streaming with Kafka in front. The job was to turn raw page events into sessions and funnels the product team could query within a few minutes of the event. The hard part was late and duplicated events: mobile clients would buffer and replay. I handled it with event-time watermarks and a deduplication key on the client event ID, and I wrote the on-call runbooks and SLAs for the whole streaming stack, because at the time nobody owned them. The other hard part was schema drift from the front-end teams, which is where I first started using schema checks at the boundary — the same idea I later turned into data contracts at FinEdge.' },
  { speaker: 'agent', seconds: 15, asks: 'Cloud & Platform Architecture', text: 'On the platform side: how did you architect for changing volume and cost on AWS, and what trade-off did you decide against?' },
  { speaker: 'candidate', seconds: 112, text: 'We separated storage from compute and sized Snowflake warehouses per workload, rather than running one large one for everything. For variable volume I used auto-suspend and multi-cluster warehouses, tagged cost by team so finance could see who was spending what, and enforced least-privilege access through roles. For observability we instrumented Airflow with SLAs and pushed the metrics to CloudWatch. The trade-off I decided against was an always-on large warehouse. It would have met the latency SLA, but auto-scaling met the same SLA at a much lower cost, and I’d rather explain a cold-start second to an analyst than a bill to the CFO.' },
  { speaker: 'agent', seconds: 14, asks: 'Collaboration', text: 'Tell me about a disagreement with an analyst or a product partner about the data. What was it about, and how did it end?' },
  { speaker: 'candidate', seconds: 38, text: 'An analyst wanted a table denormalised for speed, and I preferred to keep the model clean. We ran a quick benchmark together, and a materialised view gave most of the speed, so we went with that.' },
  { speaker: 'agent', seconds: 16, asks: 'Communication', text: 'How do you explain a data problem to someone non-technical — a finance stakeholder, say — when a report they depend on is going to be late?' },
  { speaker: 'candidate', seconds: 92, text: 'I lead with the impact and the time, not the cause. For the delayed close report, I told the finance lead which numbers were affected, when she would have them, and what I was confident about in the meantime. I avoided any pipeline language, followed up in writing so there was one version of the story, and at the end I checked that she had understood. That last step is the one people skip, and it’s the one that stops the follow-up email at nine at night.' },
  { speaker: 'agent', seconds: 16, asks: 'Problem Solving', text: 'One more. Tell me about a problem where the requirements were unclear or contradictory. How did you work out what to actually build?' },
  { speaker: 'candidate', seconds: 126, text: 'The risk team asked for a “real-time” exposure report, and finance asked for the same report to be reconcilable to the ledger, which is only final at month end. Those two things can’t both be true of one number. I sat down with both teams and wrote out, in one page, what each of them would do with the report. Risk needed direction and speed — is exposure rising this morning — and could live with an estimate. Finance needed exactness and could wait. So we built two: an intraday estimate labelled as such, refreshed every fifteen minutes, and a reconciled month-end figure. The disagreement went away once each side saw the other’s use written down; nobody was actually asking for the same thing.' },
  { speaker: 'agent', seconds: 16, text: 'That’s everything I need for this round, and we’re close to time — I won’t get to the question on governance and data security, so the team may follow that up. Is there anything you’d like to add, or ask?' },
  { speaker: 'candidate', seconds: 24, text: 'Only that the migration is the piece of work I’m proudest of, and that I’d invest earlier in data contracts if I did it again. Thank you, Maya — I enjoyed this.' },
  { speaker: 'agent', seconds: 10, text: 'Thank you, Priya. The hiring team will read this transcript and be in touch. Goodbye for now.' },
];

// ---------------------------------------------------------------------------
// The assessment: every level with the quote a reader can check it against
// ---------------------------------------------------------------------------

interface StoryEvidence {
  /** Index into DEMO_STORY_TRANSCRIPT; must be a candidate turn. */
  readonly turn: number;
  /** Verbatim from that turn, or the seeder refuses to write it. */
  readonly quote: string;
}

interface StoryGrade {
  readonly name: string;
  readonly level: Proficiency | null;
  readonly confidence: number;
  readonly evidence: readonly StoryEvidence[];
  readonly rationale: string;
}

export const DEMO_STORY_GRADES: readonly StoryGrade[] = [
  {
    name: 'SQL & Data Warehousing', level: 4, confidence: 0.86,
    evidence: [
      { turn: 11, quote: 'I opened the query profile in Snowflake and saw a full table scan with no pruning at all. I put clustering keys on the date and account columns so that partition pruning could work, and I rewrote a correlated subquery as a window function, which removed a nested loop.' },
      { turn: 11, quote: 'I ran the old query and the new one against a fixed sample and compared the outputs row by row before switching.' },
    ],
    rationale: 'Diagnosed from the query profile, fixed at both the storage layout and the query, and proved correct by comparison before switching. Above the required level for a senior: she reasons about pruning and plan shape, not syntax.',
  },
  {
    name: 'Data Engineering & Pipelines', level: 4, confidence: 0.84,
    evidence: [
      { turn: 13, quote: 'I handled it with event-time watermarks and a deduplication key on the client event ID' },
      { turn: 7, quote: 'First we made the pipeline idempotent, using merge keys, so that any partition could be re-run safely.' },
    ],
    rationale: 'Batch and streaming both, with the failure modes named (late data, duplicates, schema drift) and a specific mechanism for each. Owned end to end at two employers.',
  },
  {
    name: 'Reliability & Operations', level: 3, confidence: 0.8,
    evidence: [
      { turn: 7, quote: 'I found it through a freshness check and a row-count anomaly alert that I had put in place a few months earlier' },
      { turn: 9, quote: 'the incident count for the whole platform, which I track in our on-call log, went from roughly five a month to two' },
    ],
    rationale: 'Detection she built herself, a durable fix and a measured outcome. The first answer leaned on “we”; the follow-up separated her contribution clearly, which is why this sits at the required level rather than below it.',
  },
  {
    name: 'Data Modeling', level: 4, confidence: 0.88,
    evidence: [
      { turn: 5, quote: 'a type-two slowly changing dimension for accounts, with effective-from and effective-to dates on every row' },
      { turn: 5, quote: 'I chose a star over one wide table because the joins stay predictable and each dimension can be tested on its own.' },
    ],
    rationale: 'Requirement (point-in-time correctness), design, trade-off, tests and outcome, in that order and each specific. The strongest answer of the interview.',
  },
  {
    name: 'Cloud & Platform Architecture', level: 3, confidence: 0.78,
    evidence: [
      { turn: 15, quote: 'I used auto-suspend and multi-cluster warehouses, tagged cost by team so finance could see who was spending what, and enforced least-privilege access through roles.' },
      { turn: 15, quote: 'The trade-off I decided against was an always-on large warehouse.' },
    ],
    rationale: 'The cost-versus-latency trade-off is reasoned explicitly and the one she ruled out is named. No evidence of infrastructure as code or multi-region design, so not higher.',
  },
  {
    name: 'Security & Compliance', level: null, confidence: 0,
    evidence: [],
    rationale: 'Not reached: the interviewer ran out of time before the governance question, and said so. Nothing said counts against her, and the CV does not speak to it either. One for the next round.',
  },
  {
    name: 'Communication', level: 3, confidence: 0.74,
    evidence: [
      { turn: 19, quote: 'I lead with the impact and the time, not the cause.' },
      { turn: 19, quote: 'at the end I checked that she had understood.' },
    ],
    rationale: 'One clear example, structured the way the role needs: impact, timing, written follow-up, confirmation. A single situation, so at the required level; her answers throughout were also unusually easy to follow.',
  },
  {
    name: 'Problem Solving', level: 4, confidence: 0.82,
    evidence: [
      { turn: 21, quote: 'I sat down with both teams and wrote out, in one page, what each of them would do with the report.' },
      { turn: 21, quote: 'So we built two: an intraday estimate labelled as such, refreshed every fifteen minutes, and a reconciled month-end figure.' },
    ],
    rationale: 'Separated a contradictory requirement into two real needs and built to each, and validated it with the people who asked. Above the required level.',
  },
  {
    name: 'Collaboration', level: 2, confidence: 0.6,
    evidence: [
      { turn: 17, quote: 'We ran a quick benchmark together, and a materialised view gave most of the speed, so we went with that.' },
    ],
    rationale: 'A real disagreement settled with evidence, but told in two sentences: nothing about what the analyst needed, how it felt to them, or how the two work together since. Below the required level on the evidence given, not on the outcome. A follow-up in the human round would settle it.',
  },
  {
    name: 'Ownership & Impact', level: 4, confidence: 0.85,
    evidence: [
      { turn: 3, quote: 'I wrote the migration plan, rebuilt the core models in dbt, and ran a dual-write validation for six weeks' },
      { turn: 23, quote: 'I’d invest earlier in data contracts if I did it again' },
    ],
    rationale: 'Owned the plan, not a task within it, with two measured outcomes (thirty-five percent cost, sixty percent fewer failures) and a reflection on what she would change.',
  },
];

const DEMO_STORY_NARRATIVE = {
  summary: 'Priya’s platform and modelling work is specific, measured and her own: the Snowflake migration, the point-in-time finance model and the idempotent pipeline redesign are each described with a decision, a trade-off and a number. Reliability sits at the required level once the follow-up separated her contribution from the team’s. Collaboration is the one essential competency below its level: the disagreement story is real but thin, and the hiring team should probe how she works with analysts day to day. Security and compliance were not reached, so they are left out of the score and carried as an open question rather than counted as a miss. Overall 71 against a threshold of 65, with Collaboration short of its level: for the team to consider, with one question to settle in the human round.',
  strengths: [
    'Explains decisions as trade-offs with the rejected option named (star vs wide table; auto-scaling vs always-on).',
    'Every claim of impact comes with a mechanism and a measure in her own words: incidents “from roughly five a month to two”, the month-end report “ninety-seconds-to-eight”, and auto-scaling chosen over an always-on warehouse.',
    'Built the detection that caught her own incident, and made recovery idempotent rather than manual.',
  ],
  concerns: [
    'Collaboration answered in two sentences with no view of the other side; below the required level on the evidence given.',
    'Security and governance were not reached in the interview and are not evidenced by the CV.',
  ],
  contradictions: [],
  openQuestions: [
    'How does she work with the analysts and product partners week to week, beyond one benchmark?',
    'What access controls, classification or audit trails has she built on a data platform?',
  ],
  limitations: [
    'Scored from a single transcript; no work sample or reference was available to the assessment.',
  ],
};

/**
 * Every figure the narrative quotes has to be one the candidate said.
 *
 * Competency ratings already carry verbatim spans and are checked against the
 * transcript. The narrative bullets beside them are prose, and prose is where
 * an unsupported claim hides: "35% warehouse cost, 60% fewer failures" reads
 * as assessment output to anyone looking at the page, and nothing stopped a
 * later edit from changing 35 to 55.
 *
 * A number is the checkable part of such a claim, so a number is what is
 * checked. Adjectives are the seeder's judgement and are left alone; a figure
 * that is not in the transcript is a fabrication and stops the seed.
 */
function assertNarrativeFiguresAreSaid(timed: readonly TimedStoryTurn[]): void {
  const said = timed.filter((t) => t.speaker === 'candidate').map((t) => t.text).join(' ');
  const claims = [
    ...DEMO_STORY_NARRATIVE.strengths,
    ...DEMO_STORY_NARRATIVE.concerns,
    ...DEMO_STORY_NARRATIVE.openQuestions,
  ];
  for (const claim of claims) {
    for (const figure of claim.match(/\d+/g) ?? []) {
      if (!new RegExp(`(?<![0-9])${figure}(?![0-9])`).test(said)) {
        throw new Error(`Demo story: the narrative claims "${figure}" but no candidate turn says it: "${claim.slice(0, 60)}"`);
      }
    }
    // And anything in curly quotes is offered as her words, so it has to be
    // hers. This bullet once read "35% warehouse cost, 60% fewer failures,
    // 90 seconds to 8" — three figures, none of them anywhere in the
    // transcript. She says "roughly five a month to two" and
    // "ninety-seconds-to-eight" in words, and never gives a cost percentage
    // at all. Derived numbers presented as quoted ones are the exact thing
    // this product exists to stop, and the demo was doing it on the page
    // where a visitor learns to trust the assessment.
    for (const quoted of claim.match(/“([^”]+)”/g) ?? []) {
      const phrase = quoted.slice(1, -1);
      if (!said.includes(phrase)) {
        throw new Error(`Demo story: the narrative quotes "${phrase}" but no candidate turn contains it`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Building it
// ---------------------------------------------------------------------------

export interface TimedStoryTurn extends StoryTurn { readonly index: number; readonly startMs: number; readonly endMs: number }

/** The transcript with its times laid out as they would be recorded. */
export function timedTranscript(): TimedStoryTurn[] {
  let cursor = 0;
  return DEMO_STORY_TRANSCRIPT.map((turn, index) => {
    const startMs = cursor;
    const endMs = startMs + turn.seconds * 1000;
    cursor = endMs + (turn.speaker === 'agent' ? THINK_MS : BREATH_MS);
    return { ...turn, index, startMs, endMs };
  });
}

/**
 * The assessment as the grader would have written it, keyed to the scorecard's
 * own competency ids and to the transcript's turn ids. The overall score is
 * the weighted mean of the graded levels (as a share of the five-point scale),
 * over the competencies that had evidence, so a reader who checks the levels
 * finds the number follows from them.
 */
export function buildStoryAssessment(profile: RoleSuccessProfile, turnIds: readonly string[], timed: readonly TimedStoryTurn[], scorecardId: string, assessmentVersion: string): AssessmentResult {
  assertNarrativeFiguresAreSaid(timed);
  const competencies: CompetencyScore[] = profile.competencies.map((c) => {
    const grade = DEMO_STORY_GRADES.find((g) => g.name === c.name);
    if (!grade) throw new Error(`Demo story: no grade written for "${c.name}"`);
    const evidence: EvidenceSpan[] = grade.evidence.map((ev) => {
      const turn = timed[ev.turn];
      if (!turn || turn.speaker !== 'candidate') throw new Error(`Demo story: evidence for "${c.name}" cites turn ${ev.turn}, which is not a candidate turn`);
      if (!turn.text.includes(ev.quote)) throw new Error(`Demo story: evidence for "${c.name}" is not verbatim in turn ${ev.turn}: "${ev.quote.slice(0, 50)}"`);
      return { turnId: turnIds[ev.turn], startMs: turn.startMs, endMs: turn.endMs, quote: ev.quote };
    });
    return {
      id: c.id, name: c.name, level: grade.level, requiredLevel: c.requiredLevel, confidence: grade.confidence,
      notEnoughEvidence: grade.level === null, evidence, rationale: grade.rationale, rubricVersion: scorecardId,
    };
  });
  const graded = competencies.filter((c) => c.level !== null);
  const weightOf = (id: string) => profile.competencies.find((c) => c.id === id)?.weight ?? 0;
  const gradedWeight = graded.reduce((sum, c) => sum + weightOf(c.id), 0);
  const overallScore = Math.round(graded.reduce((sum, c) => sum + weightOf(c.id) * ((c.level ?? 0) / 5) * 100, 0) / gradedWeight);
  return {
    assessmentVersion,
    roleScorecardVersion: scorecardId,
    recommendation: 'CONSIDER',
    confidence: 0.76,
    evidenceCoverage: Number((graded.length / competencies.length).toFixed(2)),
    overallScore,
    competencies,
    ...DEMO_STORY_NARRATIVE,
    contradictions: [...DEMO_STORY_NARRATIVE.contradictions],
    strengths: [...DEMO_STORY_NARRATIVE.strengths],
    concerns: [...DEMO_STORY_NARRATIVE.concerns],
    openQuestions: [...DEMO_STORY_NARRATIVE.openQuestions],
    limitations: [...DEMO_STORY_NARRATIVE.limitations],
  };
}

export interface SeedDemoStoryInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly scorecardId: string;
  readonly profile: RoleSuccessProfile;
  readonly interviewer: { readonly interviewerId: string; readonly name: string };
  readonly now: Date;
}

export interface SeededDemoStory { readonly candidateId: string; readonly sessionId: string; readonly assessmentId: string }

/**
 * Priya's completed, unreviewed interview, written inside the provisioning
 * transaction. No invitation row: hers is over, and the sandbox's one open
 * invitation must stay the visitor's own (routes/demo.ts picks it by that).
 */
export async function seedDemoStory(tx: PrismaClient, input: SeedDemoStoryInput): Promise<SeededDemoStory> {
  const timed = timedTranscript();
  // The interview happened yesterday morning, so "what needs you" lists it as
  // waiting and the times on the page read as a real day, not as seconds ago.
  const startedAt = new Date(input.now.getTime() - 26 * 60 * 60_000);
  const completedAt = new Date(startedAt.getTime() + timed[timed.length - 1].endMs);

  const candidate = await tx.candidate.create({ data: { tenantId: input.tenantId, roleId: input.roleId, fullName: DEMO_STORY_CANDIDATE_NAME, email: DEMO_STORY_CANDIDATE_EMAIL, emailNormalized: normalizeEmail(DEMO_STORY_CANDIDATE_EMAIL), phone: '' } });
  const parsed = normalizeProfile(DEMO_RESUME);
  const { fit } = computeFitScore(parsed, DEMO_RESUME, input.profile);
  await tx.candidateProfileVersion.create({ data: { candidateId: candidate.id, version: 1, rawText: DEMO_RESUME, profileJson: JSON.stringify(parsed), fitScoreJson: JSON.stringify(fit) } });

  const disclosureText = composeDisclosure(input.interviewer.name, DEFAULT_DISCLOSURE_BODY);
  const consent = {
    disclosureText, recordingRequested: false, humanReviewRequired: true,
    recording: false, consentVersion: 'v2', consentedAt: startedAt.toISOString(), channel: 'portal', monitoringDisclosed: false, observerDisclosed: false, disclosureShown: disclosureText,
  };
  const session = await tx.interviewSession.create({
    data: {
      tenantId: input.tenantId, candidateId: candidate.id, roleId: input.roleId, scorecardId: input.scorecardId,
      state: 'REVIEW_READY', provider: 'hosted', language: 'en', durationMinutes: DEMO_STORY_DURATION_MINUTES,
      personaJson: JSON.stringify({ interviewerId: input.interviewer.interviewerId, name: input.interviewer.name, tone: 'warm' }),
      consentJson: JSON.stringify(consent), startedAt, completedAt,
    },
  });
  const plan = buildInterviewPlan({ role: input.profile, fit, durationMinutes: DEMO_STORY_DURATION_MINUTES, language: 'en', modules: [] });
  await tx.interviewPlanVersion.create({ data: { sessionId: session.id, version: 1, planJson: JSON.stringify(plan) } });

  const turnIds: string[] = [];
  for (const turn of timed) {
    const competencyId = turn.asks ? input.profile.competencies.find((c) => c.name === turn.asks)?.id ?? '' : '';
    const row = await tx.turn.create({
      data: {
        sessionId: session.id, index: turn.index, speaker: turn.speaker, text: turn.text, startMs: turn.startMs, endMs: turn.endMs,
        confidence: turn.speaker === 'agent' ? 1 : 0.93, competencyId, metaJson: JSON.stringify(turn.followUp ? { followUp: true } : {}),
      },
    });
    turnIds.push(row.id);
  }

  const assessmentVersion = `A-${session.id.slice(0, 6)}-v1`;
  const result = buildStoryAssessment(input.profile, turnIds, timed, input.scorecardId, assessmentVersion);
  const assessment = await tx.assessmentVersion.create({
    data: { sessionId: session.id, scorecardId: input.scorecardId, version: 1, recommendation: result.recommendation, confidence: result.confidence, evidenceCoverage: result.evidenceCoverage, resultJson: JSON.stringify(result), createdAt: completedAt },
  });

  const report = renderReportMarkdown({ candidateName: DEMO_STORY_CANDIDATE_NAME, roleTitle: 'Senior Data Engineer', assessment: result });
  await tx.artifact.create({ data: { tenantId: input.tenantId, sessionId: session.id, candidateId: candidate.id, kind: 'report', filename: `${assessmentVersion}.md`, contentType: 'text/markdown', storageKey: report, sizeBytes: report.length, retentionDays: 180 } });
  const transcript = timed.map((t) => `[${formatClock(t.startMs)}] ${t.speaker.toUpperCase()}: ${t.text}`).join('\n');
  await tx.artifact.create({ data: { tenantId: input.tenantId, sessionId: session.id, candidateId: candidate.id, kind: 'transcript', filename: `${session.id}-transcript.txt`, contentType: 'text/plain', storageKey: transcript, sizeBytes: transcript.length, retentionDays: 180 } });

  await tx.candidateAssignment.create({ data: { candidateId: candidate.id, userId: input.userId, relation: 'owner' } });
  return { candidateId: candidate.id, sessionId: session.id, assessmentId: assessment.id };
}

function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
