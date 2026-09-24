import type { Competency, RoleSuccessProfile } from '../../src/domain/types.js';
import type { TechStackItem } from '../../src/domain/techStack.js';
import { DATA_ENGINEER_ROLE } from './cvFixtures.js';

/**
 * CVs written to break the fit scorer, and pairs written to catch it cheating.
 *
 * `cvFixtures.ts` holds the documents the scorer was BUILT against. These are
 * the ones it has to survive: the same career told in a language the matcher
 * does not speak, a CV that games the matcher instead of describing work, and
 * pairs that differ only in something a hiring decision may never turn on.
 *
 * Most of them come in twos, because almost nothing here can be asserted about
 * a single document. "Does not penalise plain writing" is unfalsifiable on one
 * CV and a one-line assertion on two that describe the same job. The pairs are
 * therefore built from the same sentences wherever the point allows it, so a
 * difference in the score has exactly one possible cause.
 */

const competency = (over: Partial<Competency> & Pick<Competency, 'id' | 'name'>): Competency => ({
  definition: '', category: 'technical', classification: 'essential', weight: 0.2,
  requiredLevel: 3, targetLevel: 4, indicators: [], evidenceModes: ['behavioral_example'],
  ...over,
});

// --- A role whose vocabulary a CV can legitimately spell differently ------------

/**
 * Three competencies whose names are the ONLY spelling the old matcher knew.
 *
 * "SQL Development" reduces to the terms `development` and `sql`; a DBA of
 * twenty years who writes "relational databases" and "RDBMS" matched neither.
 * Same for "K8s" against Kubernetes and "ML" against machine learning. None of
 * these are obscure — they are what practitioners actually write.
 */
export const PLATFORM_ROLE: RoleSuccessProfile = {
  ...DATA_ENGINEER_ROLE,
  roleContext: 'Platform engineer running the container estate and the reporting database.',
  outcomes: [
    'Keep the container platform available for every product team',
    'Give the business a reporting database it can query without help',
  ],
  responsibilities: ['Run the container estate', 'Own the reporting database', 'Take models to production'],
  competencies: [
    competency({
      id: 'p-k8s', name: 'Kubernetes Operations', weight: 0.4,
      definition: 'Runs a production container estate.',
      indicators: ['Manages clusters and workloads', 'Handles rollout and rollback', 'Owns cluster upgrades'],
    }),
    competency({
      id: 'p-sql', name: 'SQL Development', weight: 0.35,
      definition: 'Writes and tunes queries against a normalised schema.',
      indicators: ['Tunes slow queries', 'Normalises schemas', 'Owns stored procedures'],
    }),
    competency({
      id: 'p-ml', name: 'Machine Learning Delivery', weight: 0.25, classification: 'preferred',
      definition: 'Takes a trained model from a notebook into production.',
      indicators: ['Serves models behind an API', 'Monitors drift'],
    }),
  ],
  scoringRules: { mustPassCompetencyIds: ['p-k8s'], notEnoughEvidencePolicy: 'exclude', passThreshold: 65 },
  seniority: 'senior',
};

export const PLATFORM_STACK: TechStackItem[] = [
  { name: 'Kubernetes', category: 'platform', level: 'strong', required: true },
  { name: 'SQL', category: 'language', level: 'strong', required: true },
];

/** The role's own words, spelled the role's way. The control. */
export const EXPLICIT_TERMS_CV = `Ravi Menon

Experience

Platform Engineer, Corran Systems (2020 - Present)
- Ran the production Kubernetes estate for eleven product teams, including cluster upgrades and rollback.
- Wrote and tuned SQL against the reporting schema, and normalised the two tables that caused most of the slow queries.
- Put a machine learning model into production behind an API and monitored it for drift.

Skills
Kubernetes, SQL, Python
`;

/** The same job, written the way practitioners write it. Not one role word in it. */
export const SYNONYM_TERMS_CV = `Ravi Menon

Experience

Platform Engineer, Corran Systems (2020 - Present)
- Ran the production K8s estate for eleven product teams, including cluster upgrades and rollback.
- Wrote and tuned queries against the reporting RDBMS, and normalised the two relational tables that caused most of the slow queries.
- Put an ML model into production behind an API and monitored it for drift.

Skills
K8s, RDBMS, Python
`;

// --- Recency, duration, depth, scope and ownership -----------------------------

/**
 * Used it once, long ago. The technology is genuinely on the CV — the question
 * is whether the score can tell this apart from the CV below it.
 */
export const KAFKA_GLANCING_CV = `Alex Prior

Experience

Data Engineer, Halston Group (2017 - 2018)
- Used Kafka on a short proof of concept that never reached production.
- Wrote batch loads into the reporting warehouse and modelled the sales fact table.

Support Analyst, Halston Group (2018 - Present)
- Answered tickets about the nightly load and wrote runbooks for the operators.

Skills
Kafka, SQL, Excel
`;

/** Owned the same technology, currently, for years, at depth. */
export const KAFKA_OWNED_CV = `Alex Prior

Experience

Data Engineer, Halston Group (2017 - 2018)
- Wrote batch loads into the reporting warehouse and modelled the sales fact table.

Streaming Platform Engineer, Halston Group (2021 - Present)
- Owned the Kafka platform end to end: brokers, topics, retention, replay and the on-call rota for it.
- Took the Kafka estate through three major upgrades without an unplanned outage.
- Answered tickets about the nightly load and wrote runbooks for the operators.

Skills
Kafka, SQL, Excel
`;

// --- Seniority by evidence rather than by years --------------------------------

/** Four years, and every one of them spent owning something. */
export const SHORT_CAREER_OWNED_CV = `Nadia Fehr

Experience

Data Engineer, Marden Freight (2022 - Present)
- Owned the streaming ingestion end to end, from the broker topics through to the warehouse load.
- Led a team of 6 engineers through the rebuild and set the technical direction for it.
- The pipelines carry 40m events/day and I hold the on-call pager for them.
- Chose the grain of the warehouse star schema and wrote the lineage down for the analysts.
- Explained the cost and freshness trade-off to the operations director, who does not write code.

Skills
Kafka, Airflow, Snowflake, Python, SQL
`;

/** Twelve years of the same week. The same technologies, none of them owned. */
export const LONG_CAREER_TASKS_CV = `Peter Selby

Experience

Data Engineer, Pellow Services (2014 - Present)
- Worked on assigned tickets from the backlog under supervision of the team lead.
- Assisted with the nightly warehouse load and helped with the monthly reporting pack.
- Supported the team during month end and shadowed the senior engineer on escalations.
- Ran the same set of Airflow jobs each week as directed, and raised a ticket when one failed.

Skills
Kafka, Airflow, Snowflake, Python, SQL
`;

// --- Hard requirements against nice-to-haves -----------------------------------

/** Everything the role would like, and nothing it insists on. */
export const NICE_TO_HAVES_ONLY_CV = `Jo Ferris

Experience

Engineering Manager, Aldbury Software (2019 - Present)
- Mentored a team of 5 junior engineers, pairing weekly and reviewing their code as teaching.
- Measured spend per service and removed the waste in the cloud bill, cutting it by a third.
- Presented options to non-technical owners and negotiated scope with them, then wrote the decisions down.

Skills
Terraform, Jira
`;

// --- Titles, idiom and register ------------------------------------------------

/** Not one job title an American screening heuristic would recognise. */
export const NON_US_TITLES_CV = `Ifeoma Adeyemi

Experience

Reader in Data Systems, University of Ardleigh (2019 - Present)
- Built the streaming ingestion that moves instrument events into the departmental warehouse every night, with replay and backfill handled unattended.
- Designed the star schema the research groups query, choosing the grain deliberately so a row always means one reading.

Senior Programmer Analyst, Ardleigh Borough Council (2013 - 2019)
- Modelled the revenues warehouse and documented its lineage for the finance analysts.
- Presented the technical trade-offs to non-technical service owners and wrote the decisions down.

Chartered Engineer (CEng MIET), Institution of Engineering and Technology

Skills
Kafka, Airflow, Snowflake, Python
`;

/** Consultancy register: the work is real, the subject of every sentence is the client. */
export const CONSULTING_CV = `Marcus Threlfall

Experience

Managing Consultant, Ardan Partners (2018 - Present)
- Engaged the client to replatform their streaming ingestion onto Kafka, delivering replay and backfill unattended.
- Delivered for a FTSE-100 client a warehouse star schema with a deliberately chosen grain, and documented its lineage.
- Ran the orchestration workstream in Airflow across a 14-month engagement into Snowflake.
- Presented the cost and freshness trade-offs to the client's non-technical sponsors and wrote the decisions down.

Skills
Kafka, Airflow, Snowflake, Python
`;

/** Academic register: postdoc, publications, grants, no commercial job title. */
export const ACADEMIC_CV = `Lena Vogt

Experience

Postdoctoral Research Associate, Institute for Climate Data (2019 - Present)
- Built the ingestion that moves sensor events into the institute warehouse every night, with replay and backfill handled unattended.
- Designed the schema the analysis groups query, choosing the grain deliberately so a row always means one observation.
- Rewrote the orchestration in Airflow after the original cron jobs became unmaintainable.
- Presented the cost and freshness trade-offs to the institute director, who does not write code, and wrote the decisions down.

Publications
- Vogt et al., "Unattended ingestion of high-frequency sensor data", Journal of Environmental Informatics, 2022.

Grants
- Principal investigator, national infrastructure grant of EUR 340,000 for the data platform.

Skills
Python, SQL, Airflow, Snowflake
`;

/** Military register: rank, unit, deployment, and a headcount written the army's way. */
export const MILITARY_CV = `Daniel Okonkwo

Experience

Captain, Royal Signals (2014 - 2022)
- Led a section of 12 signallers and held the on-call rota for the deployed communications estate.
- Built the ingestion that moved sensor events into the brigade warehouse every night, with replay and backfill handled unattended.
- Designed the reporting schema the planning cell queries, choosing the grain deliberately.
- Presented the technical trade-offs to non-technical commanders and wrote the decisions down.

Data Engineer, Stonecross Logistics (2022 - Present)
- Rebuilt the nightly orchestration in Airflow and owned the Kafka ingestion into Snowflake.

Skills
Kafka, Airflow, Snowflake, Python
`;

/**
 * The same career with a three-year gap in it, and without one.
 *
 * Built so that the ONLY difference is the gap: both first roles run for the
 * same number of months, both second roles start and end on the same dates, so
 * every technology has the same duration and the same recency in each.
 */
export const GAPPED_CAREER_CV = `Rosa Linden

Experience

Data Engineer, Ellerby Foods (2015 - 2018)
- Built the streaming ingestion in Kafka into Snowflake, with replay and backfill handled unattended.
- Designed the warehouse star schema and chose the grain deliberately.

Data Engineer, Trellis Logistics (2021 - Present)
- Rebuilt the nightly orchestration in Airflow and owned the Kafka ingestion into Snowflake.
- Presented the technical trade-offs to non-technical owners, who do not write code, and wrote the decisions down.

Skills
Kafka, Airflow, Snowflake, Python
`;

export const CONTINUOUS_CAREER_CV = `Rosa Linden

Experience

Data Engineer, Ellerby Foods (2018 - 2021)
- Built the streaming ingestion in Kafka into Snowflake, with replay and backfill handled unattended.
- Designed the warehouse star schema and chose the grain deliberately.

Data Engineer, Trellis Logistics (2021 - Present)
- Rebuilt the nightly orchestration in Airflow and owned the Kafka ingestion into Snowflake.
- Presented the technical trade-offs to non-technical owners, who do not write code, and wrote the decisions down.

Skills
Kafka, Airflow, Snowflake, Python
`;

/**
 * A career spent on the previous generation of tools.
 *
 * None of this role's technologies appear, and every competency it scores does.
 * The right answer is not a low number — it is "the competencies are there, the
 * named technologies are not", said in those words.
 */
export const LEGACY_TECH_CV = `Brian Hollis

Experience

Senior Systems Analyst, Caldbeck Insurance (2001 - Present)
- Built the overnight ingestion in Perl that loads policy events into the Oracle warehouse, unattended, with replay and backfill when a run fails.
- Designed the star schema the actuaries query, choosing the grain deliberately, and documented its lineage.
- Presented the technical trade-offs to non-technical underwriting owners, who do not write code, and wrote the decisions down.
- Measured spend per batch and removed the waste in the overnight window.
- Mentored 4 junior analysts, pairing weekly and reviewing their code as teaching.

Skills
Perl, Oracle, SVN, shell
`;

// --- Plain writing: the false-negative audit -----------------------------------

/**
 * Three strong candidates who write in short sentences and never sell.
 *
 * Every one of them is a hire. None of them contains a single word of the
 * register a CV-screening tool is usually tuned on — no "spearheaded", no
 * "delivered transformational outcomes", no adjectives at all in places.
 */
export const PLAIN_VOICE_A_CV = `Tomas Brenner

Experience

Data Engineer, Larkhill Utilities (2019 - Present)
- I built the ingestion. It reads from Kafka and writes to Snowflake. It handles replay and backfill on its own.
- I designed the star schema. The grain is one meter reading. I wrote the lineage down.
- I moved the orchestration to Airflow.
- I measured the spend per pipeline and removed the waste.

Skills
Kafka, Airflow, Snowflake, Python
`;

export const PLAIN_VOICE_B_CV = `Hanne Dalgaard

Experience

Data Engineer, Vesterbro Retail (2018 - Present)
- Built streaming ingestion. Kafka in, Snowflake out. Replay and backfill run unattended.
- Star schema for the sales warehouse. Grain is one order line. Lineage documented.
- Orchestration in Airflow. Nightly.
- Mentored 2 junior engineers. Weekly pairing. Code review as teaching.

Skills
Kafka, Airflow, Snowflake, Python
`;

export const PLAIN_VOICE_C_CV = `Sunil Rao

Experience

Data Engineer, Perrott Media (2017 - Present)
- Looked after the streaming ingestion from Kafka into Snowflake. Replay and backfill are unattended.
- Did the star schema for the warehouse. Chose the grain. Wrote down the lineage.
- Ran the nightly orchestration on Airflow.
- Explained the technical trade-offs to the commercial owners, who do not write code. Wrote the decisions down.

Skills
Kafka, Airflow, Snowflake, Python
`;

// --- Keyword stuffing against work described in its own words -------------------

/**
 * The scorecard, pasted back at the scorer, twice.
 *
 * Every competency name and every indicator word is on this CV. No sentence on
 * it says what the person did.
 */
export const KEYWORD_STUFFED_CV = `Devon Ashby

Core Competencies
Pipeline Engineering, Dimensional Modelling, Stakeholder Communication, Mentoring, Cost Optimisation
Pipeline Engineering, Dimensional Modelling, Stakeholder Communication, Mentoring, Cost Optimisation
Streaming ingestion, nightly pipelines, warehouse, star schema, grain, lineage, backfill, replay, unattended
Kafka, Airflow, Snowflake, Terraform, Python, SQL, dbt

Experience

Data Associate, Cartwright Ltd (2019 - Present)
- Various duties as required.

Skills
Pipeline Engineering, Dimensional Modelling, Stakeholder Communication, Mentoring, Cost Optimisation
`;

/** The same role, described. Not one competency name written out. */
export const OWN_WORDS_CV = `Devon Ashby

Experience

Data Engineer, Cartwright Ltd (2019 - Present)
- I look after the overnight ingestion that moves events out of Kafka and into Snowflake. It handles its own replay and backfill when a night fails, so nobody gets paged.
- I laid out the warehouse star schema. The grain is one order line, chosen deliberately, and I wrote the lineage down.
- I sat with the finance lead, who does not write code, and talked through the technical trade-offs of arriving an hour earlier. We wrote the decision down.
- I take two of the newer engineers through their code each week as teaching.
- I worked out what each pipeline costs to run and removed the waste.

Skills
Kafka, Airflow, Snowflake, Python
`;

// --- Bias pairs ----------------------------------------------------------------

/**
 * The same five bullets under a different logo.
 *
 * The employer's name is the one thing that changes, and it is a thing the
 * score may never see. It is passed in rather than written twice so that no
 * stray word can differ between the two.
 */
export function cvAtEmployer(employer: string): string {
  return `Sam Ellery

Experience

Senior Data Engineer, ${employer} (2020 - Present)
- Built the streaming ingestion in Kafka into Snowflake, with replay and backfill handled unattended.
- Designed the warehouse star schema and chose the grain deliberately, then documented the lineage.
- Rebuilt the nightly orchestration in Airflow.
- Presented the technical trade-offs to product owners, who do not write code, and wrote the decisions down.
- Mentored 3 junior engineers, pairing weekly and reviewing their code as teaching.

Skills
Kafka, Airflow, Snowflake, Python
`;
}

export const PRESTIGE_EMPLOYER = 'Google';
export const SECOND_PRESTIGE_EMPLOYER = 'Goldman Sachs';
/** A firm nobody has heard of, doing exactly the same work. */
export const UNKNOWN_EMPLOYER = 'Brightmoor Components Ltd';

/** The same career under a different degree certificate. */
export function cvFromUniversity(institution: string, year: string): string {
  return `Sam Ellery

Experience

Senior Data Engineer, Corran Systems (2020 - Present)
- Built the streaming ingestion in Kafka into Snowflake, with replay and backfill handled unattended.
- Designed the warehouse star schema and chose the grain deliberately, then documented the lineage.
- Rebuilt the nightly orchestration in Airflow.
- Presented the technical trade-offs to product owners, who do not write code, and wrote the decisions down.
- Mentored 3 junior engineers, pairing weekly and reviewing their code as teaching.

Skills
Kafka, Airflow, Snowflake, Python

Education
B.Sc Computer Science, ${institution}, ${year}
`;
}

export const PRESTIGE_UNIVERSITY = 'Massachusetts Institute of Technology';
export const UNKNOWN_UNIVERSITY = 'Wolverhampton Polytechnic';

/**
 * One career, two Englishes.
 *
 * Written sentence for sentence against each other, on the same content words,
 * so that the ONLY difference is idiom — tense, article, word order. A score
 * that moves between these two is scoring fluency.
 */
export const FLUENT_ENGLISH_CV = `Wei Zhang

Experience

Data Engineer, Halberd Systems (2020 - Present)
- I built the streaming ingestion in Kafka. It moves events into Snowflake every night, and it handles replay and backfill by itself.
- I designed the warehouse star schema and chose the grain deliberately, so analysts can query it without asking me.
- I moved the nightly orchestration to Airflow, and it fails far less often now.
- I explained the technical trade-offs to the product owner, who does not write code, and wrote the decision down.
- I mentored 3 junior engineers. I pair with them weekly and review their code as teaching.

Skills
Kafka, Airflow, Snowflake, Python
`;

export const NON_IDIOMATIC_ENGLISH_CV = `Wei Zhang

Experience

Data Engineer, Halberd Systems (2020 - Present)
- I am building the streaming ingestion in Kafka. It is moving events into Snowflake every night, and it is handling replay and backfill by itself.
- I designed the warehouse star schema and I choose the grain deliberately, so analysts can query it without asking to me.
- I moved the nightly orchestration to Airflow, now it is failing far less often.
- I explained the technical trade-offs to the product owner, he does not write code, and I wrote down the decision.
- I mentored 3 junior engineers. I am pairing with them weekly and I am reviewing their code as teaching.

Skills
Kafka, Airflow, Snowflake, Python
`;

// --- A role outside engineering ------------------------------------------------

/**
 * A marketing role, because the false-negative risk is not hypothetical.
 *
 * The CV-parsing lane found that a senior marketing manager parsed to the
 * skills `["Salesforce", "Go"]` — the second a false positive from
 * "go-to-market" — and missed Eloqua, Google Analytics, SEO, A/B testing and
 * account-based marketing entirely. The competency reading does not depend on
 * that catalogue, and this pair exists to show which half works and which does
 * not.
 */
export const MARKETING_ROLE: RoleSuccessProfile = {
  ...DATA_ENGINEER_ROLE,
  roleContext: 'Senior demand generation manager owning the pipeline the sales team works.',
  outcomes: ['Grow qualified pipeline from marketing', 'Prove which campaigns produced revenue'],
  responsibilities: ['Own demand generation', 'Own marketing attribution', 'Run the campaign calendar'],
  competencies: [
    competency({
      id: 'm-demand', name: 'Demand Generation', weight: 0.4, category: 'domain',
      definition: 'Runs campaigns that produce qualified leads the sales team accepts.',
      indicators: ['Runs multi-channel campaigns', 'Owns lead scoring', 'Works a nurture sequence'],
    }),
    competency({
      id: 'm-analytics', name: 'Marketing Attribution', weight: 0.35, category: 'domain',
      definition: 'Shows which spend produced which revenue.',
      indicators: ['Builds attribution reporting', 'Runs split tests', 'Reads funnel conversion'],
    }),
    competency({
      id: 'm-brand', name: 'Brand Positioning', weight: 0.25, classification: 'preferred', category: 'domain',
      definition: 'Decides how the product is described to a market.',
      indicators: ['Writes positioning', 'Runs message testing'],
    }),
  ],
  scoringRules: { mustPassCompetencyIds: ['m-demand'], notEnoughEvidencePolicy: 'exclude', passThreshold: 65 },
  seniority: 'senior',
};

export const MARKETING_CV = `Priya Shah

Experience

Senior Demand Generation Manager, Halloway Software (2016 - Present)
- Ran multi-channel campaigns across email, paid search and events, and owned the lead scoring model the sales team accepts leads from.
- Built the attribution reporting in Google Analytics that shows which spend produced which revenue, and read the funnel conversion off it weekly.
- Ran split tests on the nurture sequence in Eloqua and lifted qualified pipeline by 22%.
- Wrote the positioning for two product launches and ran message testing with customers before each.

Skills
Eloqua, Google Analytics, SEO, A/B testing, account-based marketing, Salesforce
`;

// --- Uncertainty ---------------------------------------------------------------

/**
 * A CV the scorer has no business having an opinion about: two lines, no dates,
 * nothing that speaks to the role either way. The right output is "a person
 * needs to look at this", not a low number.
 */
export const UNREADABLE_CV = `Kit Marlow

Available on request.
`;
