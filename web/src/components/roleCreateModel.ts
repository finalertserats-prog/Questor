/**
 * The sample job description offered on the New Role page, and the rule for
 * when it may be loaded.
 *
 * The sample is a demonstration. It used to replace whatever had been typed
 * into the description while leaving the typed title in place, which produced
 * a role called one thing with a scorecard drafted for another. It now loads
 * only into an empty form, and it fills the title too, so the two agree.
 */

export const SAMPLE_ROLE_TITLE = 'Senior Data Engineer';

export const SAMPLE_JD = `Senior Data Engineer — Platform Team
We are hiring a Senior Data Engineer to design and operate our batch and streaming data platform.
Responsibilities: build reliable ETL/ELT pipelines, own data quality and lineage, and mentor engineers.
Requirements: 5+ years building production data systems; expert SQL and Python.
Deep experience with Spark or Flink and cloud data warehouses (Snowflake/BigQuery).
Strong grasp of data modeling, orchestration (Airflow), and CI/CD for data.
Nice to have: streaming (Kafka), dbt, and infrastructure-as-code.
Location: Remote (EU). Employment: Full-time.`;

export interface RoleDraft {
  readonly title: string;
  readonly sourceText: string;
}

/** True only when there is nothing of the person's own to lose. */
export function canLoadSample(draft: RoleDraft): boolean {
  return draft.sourceText.trim() === '' && draft.title.trim() === '';
}

/** The whole form as the sample, title included. */
export function sampleDraft(): RoleDraft {
  return { title: SAMPLE_ROLE_TITLE, sourceText: SAMPLE_JD };
}
