import type { JdGoldCase } from '../types.js';

/**
 * Infrastructure, security and ML platform adverts.
 *
 * cloud-01 is one half of a deliberate pair: it uses GCP in the cloud sense,
 * and `ls-01-clinical-research-associate` in healthcareScience.ts uses the same
 * three letters to mean Good Clinical Practice. An extractor that reads the
 * abbreviation rather than the advert will get exactly one of them right.
 */
export const PLATFORM_CASES: readonly JdGoldCase[] = [
  {
    id: 'cloud-01-site-reliability-engineer',
    domain: 'cloud',
    title: 'Site Reliability Engineer',
    band: 'senior',
    note: 'GCP in the cloud sense; the data platform and the SIEM belong to other teams.',
    jd: `Site Reliability Engineer

About us
Threadline runs the booking infrastructure behind about 4,000 independent
clinics. When we are down, receptionists apologise to people in waiting rooms,
which is a good way to keep reliability from becoming abstract.

Key responsibilities
- Own SLOs and error budgets for our tier-1 services, and be willing to spend
  the budget rather than hoard it.
- Run the on-call rotation and lead blameless post-incident reviews.
- Build and maintain our Terraform modules across AWS and GCP.
- Harden our CI/CD pipelines in GitHub Actions so a bad change fails early.
- Write tooling in Go that the product teams actually want to use.

Who you'll work with
- The data platform team, who own Airflow and Spark and will ask you for capacity.
- Our security team, who run the SIEM and own vulnerability management.

Requirements
- Deep Kubernetes experience is required, including the parts that go wrong.
- Proven experience owning production reliability for a system with real users.
- Strong Linux and networking fundamentals.

Preferred
- Experience with OpenTelemetry or another tracing stack.

Benefits
- 30 days holiday, private medical, and a genuine right to disconnect off rota.
- Conference budget and paid time to use it.

Threadline is an equal opportunity employer and we particularly encourage
applications from groups under-represented in infrastructure engineering.`,
    expect: [
      'Reliability & Operations',
      'Cloud & Platform Architecture',
      'CI/CD & Release Engineering',
      'Software Engineering',
    ],
    forbid: [
      // "The data platform team, who own Airflow and Spark".
      'Data Engineering & Pipelines',
      // "Our security team, who run the SIEM and own vulnerability management".
      'Security Engineering',
    ],
    mustHave: ['Cloud & Platform Architecture', 'Reliability & Operations'],
  },
  {
    id: 'sec-01-security-analyst',
    domain: 'security',
    title: 'Security Analyst',
    band: 'developing',
    note: 'SOC role; GDPR sits with legal, the firewalls sit with platform, and the service desk is a former life.',
    jd: `Security Analyst (SOC) — Reading

About the team
We are a six-person security operations team inside a mid-sized insurer. The
team works a shift rota covering 07:00 to 21:00.

What you'll do
* Triage alerts in our SIEM and escalate the ones that are genuinely incidents.
* Investigate reported phishing and support threat hunting across our estate.
* Keep the vulnerability backlog moving with the engineering teams who have to fix it.
* Write up what happened afterwards in language a non-specialist can read.

Who you'll work with
* Our legal team handles GDPR data subject requests; you supply them the logs.
* The platform team owns the firewalls and the VPN.

What we're looking for
* A working understanding of common attack techniques and the OWASP top ten is essential.
* Some experience in a security role — we have also hired good analysts out of a
  service desk background, so tell us if that is you.
* Willingness to be curious about something at 6pm on a Friday.

Benefits
* Shift allowance on top of base, 25 days holiday, and we pay for your first
  security certification.

We are committed to equal opportunity in employment and welcome applications
from candidates of all backgrounds and identities.`,
    expect: ['Security Engineering'],
    forbid: [
      // "Our legal team handles GDPR data subject requests".
      'Privacy & Data Protection',
      // "The platform team owns the firewalls and the VPN".
      'Network Engineering',
      // "we have also hired good analysts out of a service desk background" —
      // where a candidate may have come from, not what this role does.
      'Customer Service Delivery',
      // "Triage alerts in our SIEM" — triage is a hospital word and a SOC word.
      'Clinical & Patient Care',
    ],
    mustHave: ['Security Engineering'],
  },
  {
    id: 'sec-02-head-of-information-security',
    domain: 'security',
    title: 'Head of Information Security',
    band: 'executive',
    note: 'Executive security role; privacy is counsel\'s and the cloud is the platform team\'s.',
    jd: `Head of Information Security

About Vantis
Vantis processes payroll for around 1.1 million people in the UK and Ireland.
We were founded in 2009, we are privately held, and we have never had a
reportable breach — a sentence we would like the next person in this role to
keep being able to write. We are 900 people, and security currently sits as a
team of eight reporting into the CTO. This role reports to the CEO, which is a
change we made deliberately after last year's board review.

What you'll do
- Own the information security strategy, and be able to explain in one page what
  we are protecting, from whom, and what we have decided to accept.
- Maintain our ISO 27001 certification and lead the annual surveillance audit.
- Lead a team of eight across security engineering and governance.
- Own our major incident and breach notification process, and run it when it
  matters rather than delegating it on the day.
- Report to the board quarterly on our security posture, in terms they can act on.
- Set the guardrails the platform team builds our cloud infrastructure inside.
  They own the infrastructure; you own what "secure enough" means.
- Work with our privacy counsel, who owns GDPR and the DPIA process.

Requirements
- Proven experience leading a security function in a regulated environment.
- Deep understanding of threat modelling and security architecture.
- Evidence of hiring and developing a security team, not only running one.

What we offer
- Executive package including LTIP, car allowance, and family private medical.
- 30 days holiday plus a closed week at Christmas.

Vantis is proud to be an equal opportunity employer. All qualified applicants
will receive consideration for employment and we will make reasonable
adjustments for any candidate who needs them.`,
    expect: [
      'Security Engineering',
      'Regulatory Compliance',
      'People Leadership',
      'Stakeholder & Influence',
      'Crisis & Incident Handling',
    ],
    forbid: [
      // "Work with our privacy counsel, who owns GDPR and the DPIA process".
      'Privacy & Data Protection',
      // "They own the infrastructure" — the platform team builds the cloud, not this role.
      'Cloud & Platform Architecture',
      // "Set the guardrails the platform team builds ... inside" — a security word
      // long before it was an LLM one.
      'LLM & Generative AI Engineering',
    ],
    mustHave: ['Security Engineering', 'People Leadership'],
  },
  {
    id: 'ml-01-machine-learning-engineer',
    domain: 'ml_platform',
    title: 'Machine Learning Engineer',
    band: 'senior',
    note: 'Ingestion belongs to data engineering, the problem choice belongs to product, and AWS is in the perks.',
    jd: `Machine Learning Engineer

About us
Sightline forecasts demand for grocery retailers. Our models decide how much
bread gets baked, which is a nice change from optimising click-through.

What you'll do
• Take models from notebook to production: training pipelines, evaluation and serving.
• Own the feature store and the model registry, and make retraining boring.
• Monitor for drift and decide when a model should be retrained or retired.
• Design the offline and online evaluation that tells us a model is actually better.

Who owns what
• The data engineering team owns the ingestion pipelines that feed your features.
• Our product managers decide which problems deserve a model at all; you tell
  them honestly when one does not.

Must have
• Strong Python and hands-on experience with PyTorch or scikit-learn.
• Proven experience deploying and monitoring models in production, not only
  training them.

Nice to have
• Exposure to LLM evaluation — we are starting to use one for demand annotations
  and we do not yet trust it.
• Forecasting or time-series work.

Perks
• £2,000 a year of learning budget, which most people spend on an AWS certification.
• Hybrid, 27 days holiday, dog-friendly office.`,
    expect: [
      'Machine Learning Engineering',
      'MLOps & Model Operations',
      'LLM & Generative AI Engineering',
    ],
    forbid: [
      // "The data engineering team owns the ingestion pipelines".
      'Data Engineering & Pipelines',
      // "Our product managers decide which problems deserve a model at all".
      'Product Management',
      // "most people spend on an AWS certification" — a perk.
      'Cloud & Platform Architecture',
    ],
    mustHave: ['Machine Learning Engineering', 'MLOps & Model Operations'],
  },
];
