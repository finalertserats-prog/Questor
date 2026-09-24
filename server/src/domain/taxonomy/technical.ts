import type { CanonicalCompetencyDef } from './types.js';

/**
 * Technical competencies.
 *
 * Every `cues` entry is a phrase that states a requirement, not a word that
 * happens to appear. The distinction is the point: "product" appears in
 * "partner with product teams" and means nothing about this role, whereas
 * "own the product roadmap" is a requirement. Cues are matched one line at a
 * time against lines that have already survived sectioning, exclusion and
 * collaboration masking.
 */
export const TECHNICAL_COMPETENCIES: readonly CanonicalCompetencyDef[] = [
  {
    name: 'SQL & Data Warehousing',
    category: 'technical',
    definition: 'Writes and reasons about non-trivial SQL, and models data for analytical use in a warehouse.',
    indicators: ['Explains a query they tuned and why it was slow', 'Reasons about partitioning, indexing and correctness', 'Describes a warehouse schema they designed and its trade-offs'],
    aliases: ['SQL', 'Advanced SQL', 'Data Warehousing', 'Data Warehousing / SQL', 'Databases', 'Relational Databases', 'SQL & Databases'],
    cues: [
      /\b(advanced |complex |strong |expert |deep )?sql\b/i,
      /\b(data ?warehous(e|ing)|snowflake|redshift|bigquery|synapse|teradata|databricks sql)\b/i,
      /\b(query (tuning|optimis|optimiz|performance)|window functions|stored procedures)\b/i,
      /\b(postgres(ql)?|mysql|oracle db|sql server|t-sql|pl\/sql)\b/i,
    ],
    domains: ['data', 'software', 'bfsi', 'retail', 'ml_platform'],
  },
  {
    name: 'Data Engineering & Pipelines',
    category: 'technical',
    definition: 'Builds and operates production data pipelines that other people depend on.',
    indicators: ['Describes a pipeline they own end to end', 'Explains how failures are detected and recovered', 'Reasons about idempotency, backfills and late data'],
    aliases: ['ETL', 'ELT', 'Data Pipelines', 'Pipeline Engineering', 'Data Integration'],
    cues: [
      /\b(data pipelines?|etl\b|elt\b|ingestion pipelines?|batch and streaming|streaming pipelines?)\b/i,
      /\b(airflow|dagster|prefect|dbt\b|luigi|nifi|fivetran|informatica)\b/i,
      /\b(spark|flink|beam|hadoop|kafka|kinesis|pubsub|pub\/sub)\b/i,
      /\b(backfill|idempotent|data ingestion|feature pipelines?)\b/i,
    ],
    domains: ['data', 'ml_platform', 'bfsi', 'retail'],
  },
  {
    name: 'Data Modeling',
    category: 'technical',
    definition: 'Designs data models that stay correct and usable as the business changes.',
    indicators: ['Explains a modelling decision and what it cost', 'Handles slowly changing dimensions and grain', 'Describes how the model survived a requirement change'],
    aliases: ['Dimensional Modelling', 'Dimensional Modeling', 'Schema Design', 'Data Architecture'],
    cues: [
      /\b(data model(s|ling|ing)?\b|dimensional (model|schema)|star schema|snowflake schema|slowly changing dimension|scd\b|normalis(ed|ation)|denormalis)/i,
      /\b(schema design|entity relationship|data vault|semantic layer|canonical model)\b/i,
    ],
    domains: ['data', 'software', 'bfsi'],
  },
  {
    name: 'Analytics & Insight',
    category: 'technical',
    definition: 'Turns data into a conclusion someone can act on, and is honest about its limits.',
    indicators: ['States the question before the chart', 'Explains a confounder they found', 'Says what the analysis could not settle'],
    aliases: ['Data Analysis', 'Business Intelligence', 'BI', 'Reporting & Analytics', 'Insights'],
    cues: [
      // A dashboard has to be one this role BUILDS. Everybody has a dashboard
      // with their numbers on it, and the bare noun made iOS engineers analysts.
      /\b(data analysis|business intelligence|\bbi\b|reporting suite|self-service analytics)\b/i,
      /\b(build|built|building|maintain|create|design|own|develop|produce)\w*\s+(?:\w+\s+){0,2}(dashboards?|reports?)\b/i,
      /\b(tableau|power ?bi|looker|qlik|metabase|superset|mode analytics)\b/i,
      /\b(cohort analysis|funnel analysis|ab test|a\/b test|experimentation|statistical significance)\b/i,
    ],
    domains: ['data', 'product', 'marketing', 'retail', 'strategy'],
  },
  {
    name: 'Machine Learning Engineering',
    category: 'technical',
    definition: 'Builds models that hold up outside the notebook, and knows when a model is the wrong answer.',
    indicators: ['Explains a model they put into production and how it was evaluated', 'Describes drift and how it was caught', 'Names a problem they solved without a model'],
    aliases: ['ML', 'Machine Learning', 'ML / AI Engineering', 'Applied ML', 'Data Science'],
    cues: [
      /\b(machine learning|deep learning|\bml\b models?|model (training|evaluation|serving|deployment)|feature engineering)\b/i,
      /\b(tensorflow|pytorch|scikit-?learn|xgboost|hugging ?face|keras)\b/i,
      /\b(classification|regression model|recommendation (system|engine)|forecasting model|nlp\b|computer vision)\b/i,
    ],
    domains: ['ml_platform', 'frontier_ai', 'data', 'science'],
  },
  {
    name: 'LLM & Generative AI Engineering',
    category: 'technical',
    definition: 'Builds on large language models with an engineer\'s scepticism about what they will actually do.',
    indicators: ['Describes an evaluation they built for a non-deterministic system', 'Explains a failure mode they designed around', 'Reasons about cost, latency and grounding'],
    aliases: ['GenAI', 'LLM Engineering', 'Prompt Engineering', 'Applied AI'],
    cues: [
      /\b(large language model|\bllm(s)?\b|generative ai|gen ?ai\b|foundation model)\b/i,
      /\b(rag\b|retrieval[- ]augmented|vector (database|store|search)|embeddings?|prompt engineering)\b/i,
      // "Guardrails" is security's word too — it has to be the model's.
      /\b(agentic|ai agents?|fine[- ]tun(e|ing)|model evaluation harness|(model|ai|llm|safety)\s+guardrails)\b/i,
    ],
    domains: ['frontier_ai', 'ml_platform', 'software', 'product'],
  },
  {
    name: 'MLOps & Model Operations',
    category: 'technical',
    definition: 'Keeps models running, measured and reproducible after the launch.',
    indicators: ['Describes a model registry and why it mattered', 'Explains how a retrain is triggered and validated', 'Names what they monitor and what they ignore'],
    aliases: ['MLOps', 'ML Platform', 'Model Ops'],
    cues: [
      /\b(mlops|ml ?ops|model (registry|monitoring|governance|lifecycle)|feature store)\b/i,
      /\b(mlflow|kubeflow|sagemaker|vertex ai|weights ?(and|&) ?biases|seldon)\b/i,
      /\b(model drift|retrain(ing)? pipeline|experiment tracking|reproducib(le|ility))\b/i,
    ],
    domains: ['ml_platform', 'frontier_ai', 'data'],
  },
  {
    name: 'Software Engineering',
    category: 'technical',
    definition: 'Writes software other engineers can read, change and trust.',
    indicators: ['Explains a design they chose and the one they rejected', 'Describes how they made a change safe', 'Talks about readability as a cost, not a virtue'],
    aliases: ['Programming', 'Coding', 'Software Development', 'Application Development'],
    cues: [
      /\b(software (engineering|development)|writ(e|ing) (clean|maintainable|production) code|object[- ]oriented|functional programming)\b/i,
      // "Go" needs the hyphen excluded on both sides or it matches inside
      // "Go-to-market" and "Go-live", which appear on adverts that have
      // nothing to do with the language.
      /\b(java\b|python\b|typescript|javascript|golang|(?<![\w-])go(?![\w-])|rust\b|c\+\+|c#|kotlin|swift|scala|ruby|php)\b/i,
      /\b(code review|refactor(ing)?|design patterns|clean code|solid principles)\b/i,
    ],
    domains: ['software', 'frontier_ai', 'cloud', 'semiconductor', 'media'],
    general: true,
  },
  {
    name: 'API & Service Design',
    category: 'technical',
    definition: 'Designs interfaces between systems that survive their second consumer.',
    indicators: ['Explains a versioning decision', 'Describes a contract they had to change and how', 'Reasons about idempotency and failure semantics'],
    aliases: ['API Design', 'Microservices', 'Service Architecture', 'Integration'],
    cues: [
      /\b(api design|rest(ful)? api|graphql|grpc|openapi|swagger|api contract|api versioning)\b/i,
      /\b(microservices?|service[- ]oriented|event[- ]driven architecture|message (queue|broker)|webhooks?)\b/i,
    ],
    domains: ['software', 'cloud', 'bfsi', 'retail'],
  },
  {
    name: 'Frontend Engineering',
    category: 'technical',
    definition: 'Builds interfaces that work for real people on real devices.',
    indicators: ['Describes a performance problem they fixed', 'Explains an accessibility decision', 'Reasons about state and re-render cost'],
    aliases: ['Front-end Development', 'UI Engineering', 'Web Development', 'Client-side Development'],
    cues: [
      /\b(front[- ]?end|react\b|vue\b|angular\b|svelte|next\.?js|web components)\b/i,
      /\b(responsive design|css\b|browser compatibility|web performance|core web vitals)\b/i,
      /\b(accessib(le|ility)|wcag|aria\b|screen reader)\b/i,
    ],
    domains: ['software', 'product', 'media', 'retail'],
  },
  {
    name: 'Mobile Engineering',
    category: 'technical',
    definition: 'Ships applications to devices that cannot be hot-fixed.',
    indicators: ['Explains a release they could not roll back', 'Describes offline and battery trade-offs', 'Reasons about store review and versioning'],
    aliases: ['iOS Development', 'Android Development', 'Mobile Development'],
    cues: [
      // Kotlin and Swift are both written server-side; only iOS, Android and
      // the cross-platform frameworks actually mean "mobile".
      /\b(ios\b|android\b|react native|flutter|mobile app(lication)?s?)\b/i,
      /\b(app store|play store|push notifications|offline[- ]first)\b/i,
    ],
    // A web app being fast on an Android handset is a front-end requirement,
    // not a mobile-engineering one.
    notWhen: [/\b(core web vitals|browser|web app|responsive)\b/i],
    domains: ['software', 'product', 'retail', 'media'],
  },
  {
    name: 'Cloud & Platform Architecture',
    category: 'technical',
    definition: 'Designs systems on cloud infrastructure with cost, failure and scale in view.',
    indicators: ['Explains a design for a failure they expected', 'Reasons about cost as a design constraint', 'Describes a migration and what it broke'],
    aliases: ['Cloud Architecture', 'Cloud Engineering', 'Infrastructure', 'Platform Engineering'],
    cues: [
      /\b(aws\b|azure\b|gcp\b|google cloud|cloud (platform|architecture|infrastructure|native))\b/i,
      /\b(kubernetes|k8s\b|docker|containeris|containeriz|serverless|lambda functions|ecs\b|eks\b)\b/i,
      /\b(terraform|pulumi|cloudformation|infrastructure as code|\biac\b|ansible|helm)\b/i,
    ],
    // On a trials advert GCP is Good Clinical Practice. "Run to protocol" and
    // "protocol deviation" are the tell, and neither is about a cloud.
    notWhen: [/good clinical practice|\bich\b|clinical trial|run to protocol|protocol deviation|\bstudies\b/i],
    domains: ['cloud', 'software', 'ml_platform', 'security'],
  },
  {
    name: 'Reliability & Operations',
    category: 'technical',
    definition: 'Keeps a running system healthy, and learns from it when it is not.',
    indicators: ['Walks through an incident they ran', 'Explains an SLO and why that number', 'Describes a fix that removed a class of failure'],
    aliases: ['SRE', 'Site Reliability', 'Observability', 'Production Support', 'DevOps'],
    cues: [
      /\b(reliabilit(y|ies)|\bsre\b|site reliability|observability|monitoring and alerting|\bslo\b|\bsla\b|\bsli\b)\b/i,
      /\b(incident (management|response|command)|on[- ]call|postmortem|post[- ]mortem|root cause analysis|\brca\b)\b/i,
      /\b(prometheus|grafana|datadog|splunk|opentelemetry|pagerduty|new relic)\b/i,
      /\b(uptime|fault toleran|disaster recovery|high availability|capacity planning)\b/i,
    ],
    notWhen: [/campaign|marketing|project post[- ]?mortem/i],
    domains: ['cloud', 'software', 'data', 'energy'],
  },
  {
    name: 'CI/CD & Release Engineering',
    category: 'technical',
    definition: 'Makes shipping frequent, boring and reversible.',
    indicators: ['Describes a pipeline they built and what it caught', 'Explains a rollback that worked', 'Reasons about deployment risk'],
    aliases: ['Continuous Integration', 'Continuous Delivery', 'Build & Release', 'DevOps Practices'],
    cues: [
      /\b(ci\/cd|continuous (integration|delivery|deployment)|build pipeline|release (engineering|process|management))\b/i,
      /\b(jenkins|github actions|gitlab ci|circleci|argo ?cd|spinnaker|teamcity)\b/i,
      /\b(blue[- ]green|canary (release|deploy)|feature flags?|trunk[- ]based)\b/i,
    ],
    domains: ['cloud', 'software', 'ml_platform'],
  },
  {
    name: 'Testing & Quality Engineering',
    category: 'technical',
    definition: 'Builds the evidence that a change is safe, at the level where it is cheapest.',
    indicators: ['Explains what they chose not to test and why', 'Describes a bug their tests should have caught', 'Reasons about flakiness as a real cost'],
    aliases: ['QA', 'Test Automation', 'Quality Assurance', 'SDET'],
    cues: [
      /\b(test automation|automated test|unit test|integration test|end[- ]to[- ]end test|e2e test|regression (test|suite))\b/i,
      /\b(selenium|cypress|playwright|junit|pytest|jest\b|testng)\b/i,
      /\b(quality (assurance|engineering)|test strateg|test coverage|\btdd\b|\bbdd\b)\b/i,
    ],
    domains: ['software', 'manufacturing', 'semiconductor', 'automotive'],
  },
  {
    name: 'Security Engineering',
    category: 'technical',
    definition: 'Finds and closes the ways a system can be abused, before someone else does.',
    indicators: ['Describes a vulnerability they found and its blast radius', 'Explains a control and what it does not cover', 'Reasons about the attacker, not the checklist'],
    aliases: ['Application Security', 'AppSec', 'Cyber Security', 'Information Security', 'Security'],
    cues: [
      /\b(security engineering|application security|appsec|infosec|cyber ?security|threat model|penetration test|pen test)\b/i,
      /\b(vulnerabilit(y|ies)|owasp|zero trust|encryption at rest|secure coding|\bsast\b|\bdast\b)\b/i,
      /\b(identity and access|\biam\b|authentication|authorisation|authorization|\bsso\b|\boauth\b|\bmfa\b)\b/i,
      /\b(incident (response|handling) (for |to )?(security|breach)|\bsoc\b analyst|\bsiem\b|threat (hunting|intelligence))\b/i,
    ],
    domains: ['security', 'cloud', 'software', 'bfsi', 'public_sector'],
  },
  {
    name: 'Privacy & Data Protection',
    category: 'technical',
    definition: 'Designs systems that hold personal data lawfully and only for as long as they should.',
    indicators: ['Explains a retention decision', 'Describes a data-subject request they handled', 'Reasons about minimisation at design time'],
    aliases: ['Data Privacy', 'GDPR Compliance', 'Privacy Engineering'],
    cues: [
      /\b(data (privacy|protection)|privacy (engineering|by design|impact assessment)|\bdpia\b|\bgdpr\b|\bccpa\b|\bhipaa\b)\b/i,
      /\b(data (retention|minimis|minimiz|residency)|personally identifiable|\bpii\b|anonymis|pseudonymis)/i,
    ],
    domains: ['security', 'legal', 'healthcare', 'bfsi'],
  },
  {
    name: 'Embedded & Firmware Engineering',
    category: 'technical',
    definition: 'Writes software that runs where memory, power and timing are hard limits.',
    indicators: ['Explains a timing or memory constraint they designed around', 'Describes debugging without a debugger', 'Reasons about field updates'],
    aliases: ['Firmware', 'Embedded Systems', 'Embedded Software'],
    cues: [
      /\b(embedded (systems?|software|c\b)|firmware|\brtos\b|bare[- ]metal|microcontroller|\bmcu\b|\bfpga\b|\bvhdl\b|verilog)\b/i,
      /\b(device drivers?|\bi2c\b|\bspi\b|\bcan bus\b|interrupt handl)/i,
    ],
    domains: ['semiconductor', 'robotics', 'automotive', 'aerospace', 'trades'],
  },
  {
    name: 'Hardware & Electronics Design',
    category: 'technical',
    definition: 'Designs physical electronics that can be built, tested and manufactured.',
    indicators: ['Explains a design-for-manufacture trade-off', 'Describes a board bring-up', 'Reasons about tolerance and yield'],
    aliases: ['Electronics Design', 'PCB Design', 'Hardware Engineering', 'Circuit Design'],
    cues: [
      /\b(pcb\b|schematic (capture|design)|circuit design|analog design|signal integrity|altium|cadence|kicad)\b/i,
      /\b(hardware (design|engineering)|board bring[- ]up|design for manufactur|\bdfm\b|asic\b|soc design|rtl design)\b/i,
    ],
    domains: ['semiconductor', 'robotics', 'aerospace', 'automotive'],
  },
  {
    name: 'Control & Robotics Engineering',
    category: 'technical',
    definition: 'Makes physical systems behave predictably in an unpredictable world.',
    indicators: ['Explains a controller they tuned and how they knew', 'Describes a safety case', 'Reasons about sensor error and latency'],
    aliases: ['Robotics', 'Control Systems', 'Automation Engineering', 'Motion Control'],
    cues: [
      /\b(robotics?|control systems?|\bpid\b (loop|control)|motion (control|planning)|kinematics|\bslam\b|path planning)\b/i,
      /\b(\bros\b|ros2|plc\b|scada|industrial automation|servo|actuator)\b/i,
    ],
    domains: ['robotics', 'manufacturing', 'automotive', 'aerospace', 'agriculture'],
  },
  {
    name: 'Network Engineering',
    category: 'technical',
    definition: 'Designs and runs the networks everything else depends on.',
    indicators: ['Describes a fault they traced across layers', 'Explains a segmentation decision', 'Reasons about latency and throughput'],
    aliases: ['Networking', 'Network Infrastructure', 'Network Architecture'],
    cues: [
      /\b(network (engineering|architecture|design|infrastructure)|\btcp\/ip\b|\bbgp\b|\bospf\b|\bvpn\b|\bsd-?wan\b|load balanc)/i,
      /\b(cisco|juniper|firewall (rules|configuration)|\bvlan\b|subnet|dns\b management)\b/i,
    ],
    domains: ['cloud', 'security', 'trades', 'public_sector'],
  },
  {
    name: 'Data Governance & Quality',
    category: 'technical',
    definition: 'Makes data trustworthy on purpose rather than by luck.',
    indicators: ['Explains a quality check and what it caught', 'Describes ownership of a dataset', 'Reasons about lineage when something is wrong'],
    aliases: ['Data Governance', 'Data Quality', 'Master Data Management', 'Data Stewardship'],
    cues: [
      /\b(data (governance|quality|lineage|catalog(ue)?|stewardship|contracts?)|master data|\bmdm\b)\b/i,
      /\b(data (dictionary|glossary)|great expectations|data observability|\bsla\b for data)\b/i,
    ],
    domains: ['data', 'bfsi', 'healthcare', 'public_sector'],
  },
  {
    name: 'Systems Architecture',
    category: 'technical',
    definition: 'Chooses the shape of a system and can say what it gives up.',
    indicators: ['Names the constraint that drove the design', 'Describes an architecture they later regretted', 'Reasons about change cost over time'],
    aliases: ['Solution Architecture', 'Technical Architecture', 'Enterprise Architecture'],
    cues: [
      /\b((solution|technical|enterprise|system|software) architect(ure)?|architectural (decision|trade[- ]?off|review))\b/i,
      /\b(scalab(le|ility) (design|architecture)|distributed systems?|system design|\badr\b)\b/i,
    ],
    domains: ['software', 'cloud', 'bfsi', 'strategy'],
  },
];
