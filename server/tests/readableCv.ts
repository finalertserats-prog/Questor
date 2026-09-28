/**
 * A CV the fit engine is willing to compare on, for the specs that walk a
 * candidate up the ladder.
 *
 * Bronze is struck only from a fit the product will rank, and `fix(fit): a
 * reading the product calls unreadable stops being a number to rank by` made
 * that strictly narrower: a reading banded `not_enough_evidence`, or one whose
 * coverage is below the comparable floor, is no longer a number at all. A
 * six-line CV lands there — correctly — and the specs that used one stopped
 * earning Bronze without a word about the ladder changing.
 *
 * Shared rather than copied into each file, because the next time that floor
 * moves it must move for every spec at once. A ladder spec whose candidate
 * silently holds nothing asserts the ladder about nobody.
 *
 * Written against `DEMO_JD` in `src/seed/demoData.ts`, which is the role every
 * one of those specs seeds.
 */
export const READABLE_CV = [
  'Pat Lee',
  'Senior Data Engineer | Bengaluru',
  'pat.lee@example.test',
  '',
  'Experience:',
  'Senior Data Engineer, Northwind Data (2021 - Present)',
  '- Owned the analytical data platform on Snowflake serving 200+ internal analysts.',
  '- Designed dimensional data models and slowly changing dimensions for finance reporting.',
  '- Built and operated Airflow + dbt pipelines processing 4TB/day; cut pipeline failures by 60% with idempotent recovery and better detection.',
  '- Led the migration from Redshift to Snowflake, cutting warehouse cost by 35%.',
  '- Optimized critical SQL, improving key report latency from 90s to under 8s using partitioning and clustering.',
  '',
  'Data Engineer, ShopStack (2018 - 2021)',
  '- Built streaming pipelines with Spark and Kafka for clickstream analytics.',
  '- Implemented observability and alerting; established on-call runbooks and SLAs.',
  '- Architected the AWS data platform for changing volume, cost and SLA.',
  '- Partnered with analysts and product on data governance, security and compliance reviews.',
  '',
  'Skills: SQL, Python, Airflow, dbt, Spark, Kafka, Snowflake, Redshift, BigQuery, AWS, data modelling, data governance',
  '',
  'Education: B.E. Computer Science, 2018.',
].join('\n');
