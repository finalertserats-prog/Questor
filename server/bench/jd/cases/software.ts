import type { JdGoldCase } from '../types.js';

/**
 * Software engineering adverts.
 *
 * The recurring trap here is the one every engineering advert carries: the
 * other disciplines it names. A backend role that says "partner with product
 * and design" is describing the people in the room, and a role whose benefits
 * pay for an AWS certification is not a cloud role. The tools another team
 * owns — Terraform, the CI pipelines, the GraphQL API — are the same mistake
 * wearing a different noun.
 */
export const SOFTWARE_CASES: readonly JdGoldCase[] = [
  {
    id: 'sw-01-backend-engineer',
    domain: 'software',
    title: 'Backend Engineer, Payments',
    band: 'established',
    note: 'Collaboration with product and design, plus infrastructure another team owns and a certification in the perks.',
    jd: `Backend Engineer — Payments
Manchester (hybrid, 2 days in office)  |  Permanent  |  £70,000–£85,000

About us
Cadence Pay was started in 2018 by two people who had spent a decade watching
small merchants wait five days for their money. We now move about £2bn a year
for 9,000 UK businesses. Everything we run sits on Kubernetes in AWS, and we
are quietly proud of how boring our deploys have become.

What you'll do
• Design and build the services behind our payments API, in Java and Spring Boot.
• Own the contracts our partner banks integrate against — versioning, idempotency
  and the failure semantics we promise them.
• Design the schema behind our ledger and reconciliation tables in Postgres.
• Write the unit and integration tests that let us change payment code without fear.
• Partner with product and design to shape the roadmap for the next release.

The platform team owns our Terraform and the CI pipelines, and they carry the
infrastructure pager — you will not be on call for infrastructure.

Must have
• Strong commercial experience with Java or Kotlin and a modern JVM framework.
• Proven experience designing and versioning REST APIs consumed by third parties.
• Solid SQL and relational database design.

Nice to have
• Exposure to event-driven systems — we publish settlement events onto Kafka.
• Any experience in payments, cards or open banking.

Benefits
• 28 days holiday plus bank holidays, and your birthday off.
• A £1,500 annual learning budget that covers any AWS certification you fancy.
• Private medical, 6% pension match, cycle to work.

Cadence Pay is an equal opportunity employer. We make hiring decisions without
regard to race, religion, sex, gender identity, sexual orientation, disability
or age, and we are happy to make adjustments at any stage of the process.`,
    expect: [
      'Software Engineering',
      'API & Service Design',
      'SQL & Data Warehousing',
      'Data Modeling',
      'Testing & Quality Engineering',
    ],
    forbid: [
      // "Partner with product and design to shape the roadmap" — their jobs, not this one.
      'Product Management',
      'Product & Interaction Design',
      // "Everything we run sits on Kubernetes in AWS" is the company blurb, and the
      // AWS certification is a perk. Neither is a requirement of this role.
      'Cloud & Platform Architecture',
      // "The platform team owns our Terraform and the CI pipelines" / "you will not
      // be on call for infrastructure".
      'CI/CD & Release Engineering',
      'Reliability & Operations',
      // Kafka appears as a message bus for settlement events, not as a data pipeline.
      'Data Engineering & Pipelines',
      // "our ledger and reconciliation tables in Postgres" — reconciliation here is a
      // table name, not a month-end close.
      'Accounting & Controls',
      // "Java or Kotlin and a modern JVM framework" — Kotlin on the JVM, not Android.
      'Mobile Engineering',
    ],
    mustHave: ['Software Engineering', 'API & Service Design', 'SQL & Data Warehousing'],
  },
  {
    id: 'sw-02-frontend-engineer',
    domain: 'software',
    title: 'Frontend Engineer',
    band: 'developing',
    note: 'The design system and the API both belong to other teams; only the browser work is this role.',
    jd: `Frontend Engineer

We are Ledgerly. We make accounting software that does not make people cry.
Forty of us, remote across the UK and Portugal.

What you'll do
- Build features in React and TypeScript across our customer-facing web app.
- Make the app fast on mid-range Android phones — Core Web Vitals are a team metric
  we look at every week, not a report nobody reads.
- Meet WCAG 2.1 AA. Accessibility is not a phase at the end here.
- Write unit tests for the components you ship.

How you'll work
- Our design team maintains the design system in Figma; you implement against it
  and tell them when a component does not survive contact with real data.
- Our backend team owns the REST APIs you will consume.

About you
- A year or two building production web interfaces with React or something like it.
- Strong modern CSS, and comfortable living in browser dev tools.
- You care when something is slow.

What we offer
- Remote-first, a home office budget, and four-day weeks in August.
- 25 days holiday, pension, and a yearly trip somewhere warm.

We are committed to building a team that reflects the people who use our
software, and we welcome applications from everyone.`,
    expect: ['Frontend Engineering', 'Testing & Quality Engineering'],
    forbid: [
      // "Our backend team owns the REST APIs you will consume."
      'API & Service Design',
      // "Our design team maintains the design system in Figma" — the trap is that
      // both "design system" and "Figma" appear on a role that only consumes them.
      'Product & Interaction Design',
      // "We make accounting software that does not make people cry" — the company
      // blurb naming what the product is about.
      'Accounting & Controls',
      // "Make the app fast on mid-range Android phones" — the device the web app
      // runs on, not a native mobile role.
      'Mobile Engineering',
    ],
    mustHave: ['Frontend Engineering'],
  },
  {
    id: 'sw-03-graduate-software-engineer',
    domain: 'software',
    title: 'Graduate Software Engineer',
    band: 'emerging',
    note: 'Thin advert. Label only what is genuinely supportable, and read "mentoring" as a perk they receive.',
    jd: `Graduate Software Engineer — Leeds

We are a team of eleven building software for independent pharmacies. We are
looking for a graduate to join us in September.

What we're looking for
- A degree in computer science, or equivalent practical experience.
- Some programming in Python, Java or similar — coursework and side projects count.
- Curiosity, and a willingness to learn from code review.

What we offer
- Mentoring from day one and a named buddy for your first six months.
- 25 days holiday, a hybrid week, and a decent chair.

We are a Disability Confident employer and guarantee an interview to any
disabled applicant who meets the minimum criteria.`,
    expect: ['Software Engineering'],
    forbid: [
      // "Mentoring from day one" sits in the perks: this graduate receives mentoring,
      // they are not being hired to give it.
      'Mentoring & Coaching',
    ],
    mustHave: [],
  },
  {
    id: 'sw-04-principal-engineer',
    domain: 'software',
    title: 'Principal Engineer, Platform',
    band: 'principal',
    note: 'Long and rambling; explicitly says the role does not line manage, and the cloud is in the blurb.',
    jd: `Principal Engineer, Platform

About Harbourline
Harbourline started in 2013 in a shared office in Bristol with one product and
four customers. Eleven years later we are 600 people across three countries and
our software sits underneath about a fifth of the UK's freight bookings. We have
grown the way most companies do, which is to say unevenly, and some of our
architecture still shows the shape of decisions made when there were four of us.
Our infrastructure runs on Azure. We are hiring a Principal Engineer because we
have reached the point where nobody can hold the whole system in their head, and
pretending otherwise has started to cost us.

What the role actually is
1. Set technical direction across three product teams, and own the architecture
   decision record process — including the unglamorous part, which is going back
   and marking the ones we got wrong.
2. Lead the decomposition of our booking monolith into services with contracts
   that will survive their second consumer.
3. Mentor senior engineers and raise the standard of design review. Most of your
   impact will arrive through other people's hands.
4. Be the person who is willing to say no to a design, in a room where saying no
   is expensive.
5. Work with our VP of Product on what is technically possible in the next two
   quarters, and on what is not.

A thing worth saying plainly: you will not line manage anyone. We have
engineering managers who are good at that, and we are not going to make you do
it badly alongside the technical work.

Requirements
- Deep experience with distributed systems, and scars from at least one migration
  that went sideways.
- Strong coding ability in at least one of Go, Java or Rust. You will still write
  code; not most days, but real code that ships.
- Proven experience influencing senior stakeholders across an engineering
  organisation without having authority over them.

Nice to have
- You have been an incident commander during an outage and can describe what you
  did in the first ten minutes.
- Experience in logistics, or any domain where the physical world argues back.

Benefits
- Equity, a 10% pension contribution, private medical for you and your family.
- Sabbatical after five years. Two people took one last year and both came back.

Harbourline is an equal opportunities employer and all applicants will receive
consideration without regard to any protected characteristic.`,
    expect: [
      'Systems Architecture',
      'API & Service Design',
      'Software Engineering',
      'Mentoring & Coaching',
      'Stakeholder & Influence',
      'Reliability & Operations',
    ],
    forbid: [
      // "Work with our VP of Product on what is technically possible".
      'Product Management',
      // "you will not line manage anyone" — stated outright.
      'People Leadership',
      // "Our infrastructure runs on Azure" is the founding story, not a requirement.
      'Cloud & Platform Architecture',
      // "a fifth of the UK's freight bookings" (blurb) and "Experience in logistics"
      // (a nice-to-have about industry familiarity) — a domain, not a competency.
      'Supply Chain & Logistics',
    ],
    mustHave: ['Systems Architecture', 'Software Engineering'],
  },
  {
    id: 'sw-05-ios-engineer',
    domain: 'software',
    title: 'iOS Engineer',
    band: 'established',
    note: 'Mobile role; the API belongs to backend and Figma is in the benefits.',
    jd: `iOS Engineer

Who we are
Rambler is a walking app with 2 million monthly users and a very opinionated
community. We have been going six years and we are still independent.

Key responsibilities
▪ Ship features in Swift and SwiftUI to an app people use on a hillside with one bar of signal.
▪ Own releases through App Store review, including staged rollouts you cannot take back.
▪ Reduce cold-start time and battery impact — both are on our dashboard and both have targets.
▪ Write unit and snapshot tests for what you ship.
▪ Our backend team owns the GraphQL API; you consume it and tell them when it is wrong.

Requirements
▪ Strong Swift experience and a shipped app you can talk about in detail.
▪ Proven experience with offline-first behaviour and sync conflicts.

Bonus points
▪ You have dealt with an App Store rejection and can tell the story without wincing.

Benefits
▪ 30 days holiday and a Friday afternoon nobody books meetings in.
▪ A Figma seat if you want to prototype your own ideas, and an annual gear budget.

Rambler welcomes applicants from every background. If you need any adjustment to
take part in our process, tell us and we will sort it.`,
    expect: ['Mobile Engineering', 'Testing & Quality Engineering'],
    forbid: [
      // "Our backend team owns the GraphQL API".
      'API & Service Design',
      // "A Figma seat if you want to prototype your own ideas" is a perk.
      'Product & Interaction Design',
      // "both are on our dashboard and both have targets" — where a number is
      // displayed, not a BI role.
      'Analytics & Insight',
    ],
    mustHave: ['Mobile Engineering'],
  },
  {
    id: 'sw-06-delivery-manager',
    domain: 'software',
    title: 'Technical Delivery Manager',
    band: 'established',
    note: 'A delivery role inside engineering that explicitly is not the product owner and does not code.',
    jd: `Technical Delivery Manager

About the role
You will run delivery for two scrum teams building our claims platform.

What you'll do
- Run sprint planning, keep the RAID log honest and chase dependencies before
  they become escalations.
- Own the risk register and escalate early rather than heroically.
- Report progress to senior stakeholders weekly, including the weeks it is bad news.
- Manage competing deadlines across two release trains.

What this role is not
- You are not the product owner. Our product manager owns the backlog and
  decides what gets built.
- You will not be writing code, though you will need to follow an architecture
  conversation without needing it translated.

Requirements
- Proven agile delivery experience in a software environment.
- Strong track record of delivering against fixed dates with moving requirements.

Nice to have
- Scrum Master certification.
- Insurance or another regulated domain.

What we offer
- Hybrid working, 27 days holiday, and an annual conference budget.

We are an equal opportunity employer and value diversity at our company.`,
    expect: ['Project & Delivery Management', 'Stakeholder & Influence', 'Prioritisation & Judgement'],
    forbid: [
      // "You are not the product owner. Our product manager owns the backlog."
      'Product Management',
      // "You will not be writing code" / "follow an architecture conversation".
      'Software Engineering',
      'Systems Architecture',
    ],
    mustHave: ['Project & Delivery Management'],
  },
];
