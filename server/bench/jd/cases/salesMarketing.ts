import type { JdGoldCase } from '../types.js';

/**
 * Commercial and customer-facing adverts.
 *
 * The four go-to-market functions sit close enough together that every one of
 * these adverts names the other three. Sales names marketing and customer
 * success; marketing names sales and the data team; customer success names
 * sales and support. None of those mentions is a requirement of the role being
 * advertised.
 */
export const COMMERCIAL_CASES: readonly JdGoldCase[] = [
  {
    id: 'sales-01-account-executive',
    domain: 'sales',
    title: 'Account Executive',
    band: 'established',
    note: 'Quota-carrying role; marketing sources the pipeline and CS owns renewals. "Procurement" is the buyer.',
    jd: `Account Executive — UK Mid-Market

About us
Solvent sells expense management software. We are 160 people, Series B, and we
have an unusually low churn rate that our AEs are not shy about mentioning.

What you'll do
- Carry a £900k new business quota against a defined mid-market territory.
- Run the full cycle from prospecting to close. We use MEDDPICC and we actually
  inspect it.
- Negotiate commercial terms with procurement teams who do this for a living.
- Keep Salesforce honest, and give a forecast you can defend in a room.

Where your pipeline comes from
- Our marketing team generates roughly half of it.
- Our customer success team owns renewals and expansion after the first year.

Requirements
- Proven track record of hitting quota in B2B SaaS. This one is not negotiable.
- Strong discovery skills — we would rather you disqualified early than nursed a
  deal that was never going to close.

Nice to have
- Finance or accounting buyers.

What we offer
- Uncapped commission, accelerators over plan, and a President's Club that is
  actually somewhere nice.
- 25 days holiday, private medical, share options.

Solvent is an equal opportunity employer and welcomes applicants from all
backgrounds.`,
    expect: ['Sales Execution', 'Negotiation'],
    forbid: [
      // "Our marketing team generates roughly half of it."
      'Marketing & Demand Generation',
      // "Our customer success team owns renewals and expansion after the first year."
      'Customer Success & Retention',
      // "Negotiate commercial terms with procurement teams" — procurement is the
      // person across the table, not this job.
      'Procurement & Vendor Management',
      // The same line again: an AE negotiating commercial terms is selling, not
      // practising law.
      'Legal & Contracting',
      // "Finance or accounting buyers" — who this role sells to.
      'Accounting & Controls',
    ],
    mustHave: ['Sales Execution'],
  },
  {
    id: 'mkt-01-marketing-manager',
    domain: 'marketing',
    title: 'Marketing Manager',
    band: 'established',
    note: 'Demand gen plus brand; the dashboards belong to the data team and outbound to sales.',
    jd: `Marketing Manager (Demand Generation)

About Yardstick
We make revision software for GCSE and A-level students. Three million young
people used it last year, and about half of them told us it was the only revision
they did, which we choose to find encouraging.

Key responsibilities
▪ Own demand generation for the UK: paid search, paid social and email.
▪ Plan and run campaigns end to end, and report on CAC and pipeline contribution
  rather than impressions.
▪ Own our tone of voice and the content calendar.
▪ Brief and manage our agency, and be the person who says a creative is not good enough.

How we work
▪ Our data team owns the dashboards in Looker; you will ask them for cuts, and
  you will be asked to explain what decision the cut is for.
▪ The sales team owns outbound prospecting into schools.

Requirements
▪ Strong hands-on experience with HubSpot and paid media buying.
▪ Proven experience running a campaign from brief to post-mortem.

Bonus points
▪ Education, or any market where the buyer and the user are different people.

Benefits
▪ 28 days holiday, term-time flexibility, and a four-day week in August.
▪ Learning budget, and we pay for your professional membership.

Yardstick is committed to safeguarding and promoting the welfare of young
people. All appointments are subject to a DBS check. We are an equal
opportunities employer.`,
    expect: ['Marketing & Demand Generation', 'Brand & Content'],
    forbid: [
      // "Our data team owns the dashboards in Looker".
      'Analytics & Insight',
      // "The sales team owns outbound prospecting into schools", and separately
      // "Strong hands-on experience with HubSpot" — HubSpot is a marketing
      // automation tool here, not a CRM this role sells out of.
      'Sales Execution',
      // "running a campaign from brief to post-mortem" — a marketing post-mortem is
      // not an engineering one.
      'Reliability & Operations',
      // "committed to safeguarding and promoting the welfare of young people" is
      // boilerplate in the unheaded legal paragraph, not clinical work.
      'Clinical & Patient Care',
    ],
    mustHave: ['Marketing & Demand Generation'],
  },
  {
    id: 'cs-01-customer-success-manager',
    domain: 'customer_success',
    title: 'Customer Success Manager',
    band: 'developing',
    note: 'Numbered list; expansion is handed to sales and tickets are handled by support.',
    jd: `Customer Success Manager

Millbrook is a 70-person company selling scheduling software to care homes. We
are hiring our fourth CSM.

What you'll do
1. Own a book of around 40 mid-market accounts and be accountable for their renewal.
2. Drive adoption — know which of your accounts are actually using the thing they bought.
3. Run quarterly business reviews that the customer would attend voluntarily.
4. Spot churn risk early using health scores, and act on it while it is still cheap.
5. Hand expansion opportunities to the sales team with enough context to be useful.

Our support team handles day-to-day tickets in Zendesk, so you are not the queue.

About you
- Two years in a customer-facing role at a software company.
- Comfortable telling a customer something they will not like.
- Organised enough to hold 40 relationships without dropping one.

What we offer
- 25 days holiday rising with service, pension, and hybrid working from our
  Nottingham office.

We are an inclusive employer and we welcome applications from everyone,
including people returning to work after a break.`,
    expect: ['Customer Success & Retention'],
    forbid: [
      // "Hand expansion opportunities to the sales team".
      'Sales Execution',
      // "Our support team handles day-to-day tickets in Zendesk, so you are not the queue."
      'Customer Service Delivery',
    ],
    mustHave: ['Customer Success & Retention'],
  },
  {
    id: 'cserv-01-customer-service-advisor',
    domain: 'customer_service',
    title: 'Customer Service Advisor',
    band: 'emerging',
    note: 'Thin, terse advert. Only one competency is genuinely supportable.',
    jd: `Customer Service Advisor — Norwich

We sell garden furniture. Our customers ring us when something arrives broken,
and we would rather they enjoyed the call.

What you'll do
▪ Answer calls and emails from customers.
▪ Resolve complaints and arrange replacements.
▪ Keep your notes tidy in our ticketing system.
▪ Our warehouse team arranges the deliveries; you keep the customer informed.

What we're looking for
▪ Patience, and a calm voice on a bad day.
▪ Any experience dealing with the public.

Benefits: 28 days holiday, staff discount, free parking, and we close between
Christmas and New Year.

We welcome applications from everyone and will make adjustments where needed.`,
    expect: ['Customer Service Delivery'],
    forbid: [
      // "Our warehouse team arranges the deliveries".
      'Supply Chain & Logistics',
    ],
    mustHave: [],
  },
];
