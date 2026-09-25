import type { JdGoldCase } from '../types.js';

/**
 * Data and analytics adverts. The first case is the one the whole feature was
 * built for: a data engineering role that mentions product, analytics and ML
 * only as other people it works with.
 */
export const DATA_CASES: readonly JdGoldCase[] = [
  {
    id: 'data-01-senior-data-engineer',
    domain: 'data',
    title: 'Senior Data Engineer',
    band: 'senior',
    note: 'The reported failure: "partner with product teams" must not become Product Management.',
    jd: `Senior Data Engineer
Location: Bengaluru (Hybrid)  |  Employment type: Full-time  |  Level: Senior

About us:
Northwind was founded in 2015 and is headquartered in Bengaluru. Our mission is to
make financial data trustworthy for every mid-market lender in Asia. We are a
Series C company of roughly 400 people, trusted by 120 lenders.

About the role:
We are hiring a Senior Data Engineer to design and operate our analytical data
platform.

Responsibilities:
- Design robust, testable analytical data models and dimensional schemas.
- Build and operate batch and streaming pipelines using Python, Airflow and Spark.
- Own reliability of critical pipelines including detection, idempotent recovery
  and backfills.
- Write and optimize complex SQL; reason about performance, partitioning and
  correctness.
- Partner with analytics and product teams to deliver trustworthy data.
- Work closely with the machine learning team to supply feature inputs.

Must have:
- Strong SQL and data warehousing (Snowflake, Redshift or BigQuery).
- Proven experience building production data pipelines.
- Cloud platform experience (AWS/GCP/Azure), observability and reliability practices.

Nice to have:
- Experience with data governance and data quality frameworks.

Benefits:
- Competitive salary, equity and an annual learning budget.
- Private health insurance and 25 days paid time off.

Northwind is an equal opportunity employer. We welcome applicants regardless of
race, religion, gender or age. All offers are subject to a background check.`,
    expect: [
      'SQL & Data Warehousing',
      'Data Engineering & Pipelines',
      'Data Modeling',
      'Cloud & Platform Architecture',
      'Reliability & Operations',
      'Data Governance & Quality',
    ],
    forbid: [
      // "partner with analytics and product teams" — their disciplines, not this role's.
      'Product Management',
      'Analytics & Insight',
      // "work closely with the machine learning team" — likewise.
      'Machine Learning Engineering',
    ],
    mustHave: ['SQL & Data Warehousing', 'Data Engineering & Pipelines'],
  },
  {
    id: 'data-02-analytics-engineer',
    domain: 'data',
    title: 'Analytics Engineer',
    band: 'established',
    note: 'dbt-shaped role; the BI tool is named as something another team owns.',
    jd: `Analytics Engineer

What you will do:
- Build and maintain our dbt models, from staging through to the semantic layer.
- Write well-tested SQL transformations that analysts can read and trust.
- Define and document data contracts with upstream service owners.
- Improve data quality checks and the freshness SLAs on core tables.

Requirements:
- Strong SQL, including window functions and query tuning.
- Hands-on dbt experience and a solid grasp of dimensional modelling.
- Comfortable in a fast-paced environment with evolving requirements.

Nice to have:
- Exposure to Airflow or another orchestrator.

What we offer:
- Remote-first working, a generous learning budget and private healthcare.

We are committed to diversity and welcome applications from everyone.`,
    expect: [
      'SQL & Data Warehousing',
      'Data Modeling',
      'Data Governance & Quality',
      'Data Engineering & Pipelines',
      'Working Under Ambiguity',
    ],
    forbid: ['Analytics & Insight', 'Product Management', 'Cloud & Platform Architecture'],
    mustHave: ['SQL & Data Warehousing', 'Data Modeling'],
  },
  {
    id: 'data-03-data-analyst',
    domain: 'data',
    title: 'Data Analyst',
    band: 'developing',
    note: 'A genuine analytics role — Analytics & Insight SHOULD appear here, unlike data-01.',
    jd: `Data Analyst — Commercial

The opportunity:
Join our commercial team to turn sales and marketing data into decisions.

Responsibilities:
- Build and maintain dashboards in Looker for the commercial leadership team.
- Run cohort and funnel analyses to explain changes in conversion.
- Design and read A/B tests, and say plainly what they did and did not show.
- Present findings to senior stakeholders and translate them into recommendations.

Requirements:
- Strong SQL and confident data analysis.
- Experience with a BI tool such as Looker, Tableau or Power BI.
- Excellent communication: you can explain a caveat without burying the answer.

Bonus points:
- Familiarity with Python for analysis.

Benefits: 28 days holiday, pension, flexible working.`,
    expect: [
      'Analytics & Insight',
      'SQL & Data Warehousing',
      'Stakeholder & Influence',
    ],
    forbid: ['Data Engineering & Pipelines', 'Product Management', 'Marketing & Demand Generation', 'Sales Execution'],
    mustHave: ['Analytics & Insight', 'SQL & Data Warehousing'],
  },
];
