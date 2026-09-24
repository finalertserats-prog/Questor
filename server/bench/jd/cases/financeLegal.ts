import type { JdGoldCase } from '../types.js';

/**
 * Finance, legal, risk and strategy adverts.
 *
 * Finance splits cleanly into two competencies that adverts describe in almost
 * the same words — the analyst forecasts and the accountant closes — so each of
 * these two cases names the other function explicitly as somebody else's. The
 * legal and compliance pair does the same thing in the opposite direction.
 */
export const FINANCE_LEGAL_CASES: readonly JdGoldCase[] = [
  {
    id: 'fin-01-financial-analyst',
    domain: 'finance',
    title: 'Financial Analyst',
    band: 'developing',
    note: 'FP&A role; the close belongs to the accounting team and the dashboards to BI.',
    jd: `Financial Analyst

About the role
You will join a four-person FP&A team supporting a £180m turnover distribution
business.

What you'll do
- Build and maintain the monthly forecast model, and know which assumption in it
  is carrying the weight.
- Run variance analysis against budget and explain the movements to the budget
  holders who caused them.
- Support the annual budgeting cycle and the quarterly reforecast.
- Present the monthly pack to senior stakeholders, including the months it is ugly.

Who does what
- Our accounting team owns month-end close and the statutory accounts.
- Our BI team owns Power BI and the reporting suite.

Requirements
- Strong Excel modelling — you will be tested on this.
- Part-qualified (ACA, ACCA or CIMA) or actively studying.
- Comfortable being the person who says a number is wrong.

What we offer
- Full study support including exam leave, 25 days holiday, hybrid working.

We are an equal opportunity employer and value the difference a diverse team
makes to the quality of our decisions.`,
    expect: ['Financial Analysis & Planning', 'Stakeholder & Influence'],
    forbid: [
      // "Our accounting team owns month-end close and the statutory accounts."
      'Accounting & Controls',
      // "Our BI team owns Power BI and the reporting suite."
      'Analytics & Insight',
    ],
    mustHave: ['Financial Analysis & Planning'],
  },
  {
    id: 'fin-02-management-accountant',
    domain: 'finance',
    title: 'Management Accountant',
    band: 'established',
    note: 'The mirror of fin-01: the forecast belongs to FP&A, the purchase orders to procurement.',
    jd: `Management Accountant

About us
Hartwell Group owns four manufacturing businesses in the Midlands. Finance sits
centrally in Rugby.

Key responsibilities
* Own month-end close for two entities: journals, accruals, prepayments and
  balance sheet reconciliations.
* Prepare statutory accounts under IFRS and manage the external audit through to
  sign-off.
* Maintain and test the internal controls, and document the ones that only exist
  in somebody's head.
* Produce the monthly management accounts with commentary that someone
  non-financial can use.

Boundaries
* Our FP&A team owns the forecast and the budget model.
* Our procurement team raises purchase orders and manages the supplier list.

Requirements
* Qualified ACA or ACCA — essential.
* Strong IFRS knowledge and recent experience of a statutory audit.

Preferred
* Manufacturing or inventory-heavy businesses.

Benefits
* 27 days holiday, car allowance, pension at 8%, on-site parking.

Hartwell Group is an equal opportunities employer.`,
    expect: ['Accounting & Controls'],
    forbid: [
      // "Our FP&A team owns the forecast and the budget model."
      'Financial Analysis & Planning',
      // "Our procurement team raises purchase orders and manages the supplier list."
      'Procurement & Vendor Management',
    ],
    mustHave: ['Accounting & Controls'],
  },
  {
    id: 'leg-01-legal-counsel',
    domain: 'legal',
    title: 'Legal Counsel',
    band: 'senior',
    note: 'In-house commercial lawyer; FCA reporting is compliance\'s and GDPR is the DPO\'s.',
    jd: `Legal Counsel (Commercial)

About us
Drayton is a wealth management platform with £14bn under administration. The
legal team is three people and we would like it to be four.

What you'll do
- Draft and negotiate customer MSAs, data processing agreements and NDAs, at a
  volume that means you cannot treat each one as a novel.
- Advise the commercial team on liability caps, indemnities and the clauses they
  keep trying to give away.
- Own our template library and the contract playbook, so that the easy 70% never
  reaches you.
- Support procurement on inbound supplier terms.

Who owns what
- Our compliance team owns FCA reporting and the compliance monitoring programme.
- Our DPO owns GDPR; you advise on the data protection clauses in the contract.

Requirements
- Qualified solicitor in England and Wales with 5+ years PQE.
- Deep experience negotiating SaaS or platform contracts is required.
- The judgement to know which risks are worth escalating and which are noise.

What we offer
- Hybrid working, 30 days holiday, bonus, and a genuine 5pm for most of the year.

Drayton is an equal opportunity employer. We are a Level 2 Disability Confident
employer and we will make adjustments at any stage of the recruitment process.`,
    expect: ['Legal & Contracting', 'Negotiation'],
    forbid: [
      // "Our compliance team owns FCA reporting and the compliance monitoring programme."
      'Regulatory Compliance',
      // "Our DPO owns GDPR".
      'Privacy & Data Protection',
      // "Support procurement on inbound supplier terms" — supporting them, not doing it.
      'Procurement & Vendor Management',
    ],
    mustHave: ['Legal & Contracting', 'Negotiation'],
  },
  {
    id: 'bfsi-01-compliance-officer',
    domain: 'bfsi',
    title: 'Compliance Officer',
    band: 'established',
    note: 'Financial crime and regulatory compliance; contracts belong to legal, dashboards to data.',
    jd: `Compliance Officer — Financial Crime

About Ashby Bank
We are a challenger bank with 400,000 customers and a banking licence we would
like to keep.

What you'll do
- Run our AML and KYC programme, including sanctions screening and the
  enhanced due diligence cases that come out of it.
- Own the compliance monitoring plan and the evidence pack for FCA inspections.
- File SARs, and manage regulatory reporting deadlines so none of them arrive as
  a surprise.
- Deliver financial crime training across the first line.

Who you'll work with
- Our legal counsel drafts the customer contracts and the regulator correspondence.
- Our data team builds the transaction monitoring dashboards you will use.

Requirements
- Proven experience in a regulated firm, with strong working knowledge of the
  FCA handbook.
- Experience preparing for and surviving a regulatory inspection.

Nice to have
- ICA or ACAMS qualification.

Benefits
- 28 days holiday, private medical, and study support.

Ashby Bank is an equal opportunity employer and all appointments are subject to
a satisfactory DBS and credit check.`,
    // Relabelled, and the reason is recorded because relabelling to flatter a
    // number would destroy the point of this file.
    //
    // This case was written when the vocabulary had no home for financial
    // crime, so its author labelled it Risk & Credit Management and said in
    // their report that the name "will read oddly on the scorecard the product
    // shows a compliance hiring manager". They were right, and asked for the
    // competency. It now exists, so the correct label is the correct one: the
    // advert is headed "Compliance Officer — Financial Crime" and its first
    // duty is running an AML and KYC programme. There is no credit, market or
    // liquidity risk anywhere in it, which is why Risk & Credit Management has
    // moved from expected to forbidden rather than merely being dropped.
    expect: ['Regulatory Compliance', 'Financial Crime & AML'],
    forbid: [
      // Nothing in this advert is about credit, market or liquidity risk.
      'Risk & Credit Management',
      // "Our legal counsel drafts the customer contracts".
      'Legal & Contracting',
      // "Our data team builds the transaction monitoring dashboards".
      'Analytics & Insight',
      // "Deliver financial crime training across the first line" is a task inside
      // compliance, not a teaching role.
      'Teaching & Facilitation',
      // "enhanced due diligence cases" — due diligence in AML is not the M&A kind.
      'Strategy & Commercial Analysis',
    ],
    mustHave: ['Regulatory Compliance', 'Financial Crime & AML'],
  },
  {
    id: 'str-01-management-consultant',
    domain: 'strategy',
    title: 'Management Consultant',
    band: 'established',
    note: 'Strategy work; the modelling belongs to the data science practice and PRINCE2 is a perk.',
    jd: `Management Consultant

About Corrigan Partners
We are a 90-person consultancy working mainly with mid-market industrials. We
were founded by three people who left a larger firm because they wanted to stay
on engagements long enough to see whether the advice worked.

What you'll do
- Structure and run client engagements on market entry and operating model design.
- Build the business case, and be honest about the assumption it rests on.
- Present recommendations to client executives who have heard a lot of
  recommendations.
- Manage competing workstream deadlines across two engagements at once.

How we work
- Our data science practice runs the modelling and machine learning work; you
  frame the question and interpret the answer.
- Two to three days a week on client site is normal.

Requirements
- Proven experience in a top-tier consultancy or an in-house strategy team.
- The ability to structure a problem in front of a client, on a whiteboard, badly
  lit, without notes.

What we offer
- Bonus, 30 days holiday, and we fund a PRINCE2 or PMP qualification if you want one.
- Six weeks of unpaid sabbatical available after three years.

Corrigan Partners is an equal opportunity employer and we are a signatory to the
Race at Work Charter.`,
    expect: ['Strategy & Commercial Analysis', 'Stakeholder & Influence', 'Prioritisation & Judgement'],
    forbid: [
      // "Our data science practice runs the modelling and machine learning work".
      'Machine Learning Engineering',
      // "we fund a PRINCE2 or PMP qualification if you want one" — a benefit.
      'Project & Delivery Management',
    ],
    mustHave: ['Strategy & Commercial Analysis'],
  },
];
