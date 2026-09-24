import type { JdGoldCase } from '../types.js';

/**
 * Industrial, supply chain, trades and retail adverts.
 *
 * Three of these turn on a standard or a tool that belongs to a neighbouring
 * function: ISO 9001 on a quality engineer is quality, not regulatory affairs;
 * a buyer negotiating with mills is merchandising, not procurement; a PLC on a
 * field service advert belongs to the controls engineers who program it.
 */
export const INDUSTRIAL_CASES: readonly JdGoldCase[] = [
  {
    id: 'mfg-01-quality-engineer',
    domain: 'manufacturing',
    title: 'Quality Engineer',
    band: 'established',
    note: 'ISO 9001 on a quality engineer is the QMS, not a regulatory affairs role.',
    jd: `Quality Engineer

About us
Vellacott makes precision components for the rail industry from a single site in
Coventry. We have been here since 1974 and about a third of our people have been
here more than ten years.

Key responsibilities
- Own the quality management system for the site and keep our ISO 9001
  certification through the annual audit.
- Lead root cause investigations and drive CAPA to genuine closure, not to a
  closed ticket.
- Run SPC on the line, and act on a chart before it becomes a customer complaint.
- Audit our processes, and audit suppliers on site when we have reason to.
- Own the non-conformance process and the concession route.

Boundaries
- Our procurement team owns supplier contracts, pricing and the approved vendor list.
- Our production planner owns the schedule.

Requirements
- Proven experience in a manufacturing quality role.
- Strong working knowledge of FMEA, PPAP and 8D problem solving.
- Confident reading an engineering drawing and a GD&T callout.

Nice to have
- Rail, automotive or aerospace.
- Internal auditor qualification.

Benefits
- 25 days holiday plus bank holidays, pension, life assurance, and a shutdown
  between Christmas and New Year.

Vellacott is an equal opportunities employer.`,
    expect: ['Quality Management', 'Manufacturing & Process Engineering'],
    forbid: [
      // "keep our ISO 9001 certification" — the standard is the QMS, and the audit is
      // an internal one, not a regulator's.
      'Regulatory Compliance',
      // "Our procurement team owns supplier contracts, pricing and the approved vendor list."
      'Procurement & Vendor Management',
      // "Our production planner owns the schedule."
      'Supply Chain & Logistics',
    ],
    mustHave: ['Quality Management', 'Manufacturing & Process Engineering'],
  },
  {
    id: 'sc-01-demand-planner',
    domain: 'supply_chain',
    title: 'Demand Planner',
    band: 'developing',
    note: 'Planning role; buying places the orders and finance owns the variance analysis.',
    jd: `Demand Planner

Who we are
Ollerton supplies own-label household goods to UK grocers. We are 220 people and
we plan about 1,400 active lines.

What you'll do
• Own the demand plan for three categories and run the monthly S&OP cycle.
• Set safety stock levels and manage lead time variability from our Far East suppliers.
• Maintain forecasts in our MRP system and explain a forecast error rather than
  quietly reforecasting past it.
• Flag availability risk to the commercial team early enough to be useful.

Who does what
• Our buying team places the purchase orders and manages supplier negotiations.
• Our finance team owns the budget and the variance analysis.

What we're looking for
• Strong Excel, and experience with an ERP or MRP system.
• Some exposure to forecasting or planning in a fast-moving business.
• Comfortable being wrong in public and saying so early.

Benefits
• 25 days holiday, on-site canteen, free parking, and a bonus scheme that has
  paid out four years running.

Ollerton is an equal opportunity employer and welcomes applications from all
backgrounds.`,
    expect: ['Supply Chain & Logistics'],
    forbid: [
      // "Our buying team places the purchase orders and manages supplier negotiations."
      'Procurement & Vendor Management',
      'Negotiation',
      // The same line again: "Our buying team" is a team name, not this role.
      'Retail & Merchandising',
      // "Our finance team owns the budget and the variance analysis."
      'Financial Analysis & Planning',
    ],
    mustHave: ['Supply Chain & Logistics'],
  },
  {
    id: 'sc-02-procurement-manager',
    domain: 'supply_chain',
    title: 'Procurement Manager',
    band: 'senior',
    note: 'The mirror of sc-01: here procurement is the role and logistics belongs elsewhere.',
    jd: `Procurement Manager (Indirect)

About the role
You will own indirect spend of around £40m across facilities, professional
services, IT and marketing.

Key responsibilities
- Build and own the category strategy for indirect spend, and run competitive
  tenders where the incumbent has got comfortable.
- Negotiate contracts and manage supplier performance against what was agreed,
  not against what was hoped.
- Build total cost of ownership cases that survive a challenge from the budget holder.
- Run our supplier review cycle and exit the suppliers that should be exited.

Who does what
- Our legal team drafts and signs the contracts you negotiate.
- Our logistics team manages freight and the distribution network.

Requirements
- Proven category management experience across indirect spend.
- Deep experience negotiating with strategic suppliers, including one you had to
  walk away from.
- Strong stakeholder management across functions that did not ask for your help.

Preferred
- CIPS qualified.

What we offer
- Car allowance, bonus, 28 days holiday, hybrid working.

We are an equal opportunity employer and we are committed to building a team
that reflects the communities we operate in.`,
    expect: ['Procurement & Vendor Management', 'Negotiation', 'Stakeholder & Influence'],
    forbid: [
      // "Our legal team drafts and signs the contracts you negotiate."
      'Legal & Contracting',
      // "Our logistics team manages freight and the distribution network."
      'Supply Chain & Logistics',
      // "Proven category management experience across indirect spend" — category
      // management in indirect procurement is not retail buying.
      'Retail & Merchandising',
    ],
    mustHave: ['Procurement & Vendor Management', 'Negotiation'],
  },
  {
    id: 'con-01-site-manager',
    domain: 'construction',
    title: 'Site Manager',
    band: 'senior',
    note: 'Residential site delivery; material orders and the training matrix belong to other functions.',
    jd: `Site Manager — Residential

About us
Kestrel Homes builds between 300 and 400 houses a year across the East Midlands.
We are family-owned and we still do our own groundworks.

What you'll do
▪ Run a £12m residential site day to day: programme, sequencing and subcontractor
  coordination.
▪ Own health and safety on site, and stop the job when it is not right, including
  the weeks when stopping it is expensive.
▪ Chair the weekly progress meeting and keep the programme of works honest.
▪ Manage quality and snagging through to handover.
▪ Line manage two assistant site managers and a site secretary.

Who does what
▪ Our procurement team places the material orders with suppliers.
▪ Our HR team owns the site induction records and learning and development.

Requirements
▪ SMSTS, CSCS black card and first aid at work — all essential.
▪ Proven experience delivering residential schemes of this size to programme.
▪ Experience running a site through a wet winter without losing the programme.

Benefits
▪ Car or allowance, bonus on site completion, 26 days holiday, pension.

Kestrel Homes is an equal opportunities employer and all offers are subject to
references and a right to work check.`,
    // Health, Safety & Environment added for the same reason as bfsi-01 and
    // hc-01. This case's author wrote that they "had to fold site H&S into
    // Construction & Project Delivery" and asked for the competency. The
    // advert says "Own health and safety on site, and stop the job when it is
    // not right", and lists SMSTS, CSCS and first aid as essential — that is
    // a competency in its own right, not a facet of delivery.
    expect: ['Construction & Project Delivery', 'People Leadership', 'Health, Safety & Environment'],
    forbid: [
      // "Our procurement team places the material orders with suppliers."
      'Procurement & Vendor Management',
      // "Our HR team owns the site induction records and learning and development."
      'Talent & People Management',
    ],
    mustHave: ['Construction & Project Delivery'],
  },
  {
    id: 'trd-01-field-service-technician',
    domain: 'trades',
    title: 'Field Service Technician',
    band: 'developing',
    note: 'The PLC belongs to the controls engineers and the quote belongs to sales.',
    jd: `Field Service Technician (HVAC) — South East

About us
Brantham Services maintains commercial refrigeration and air conditioning for
supermarkets and cold stores. Twelve engineers, one patch each, and a van you
take home.

What you'll do
* Carry out planned and reactive maintenance on commercial HVAC and refrigeration plant.
* Fault-find electrical and control faults on site, usually alone, usually in the rain.
* Complete permits to work and follow lock-out tag-out every time.
* Keep job records up to date in our CMMS on the day, not on Friday.

Who does what
* Our controls engineers program the BMS and the PLCs.
* Our sales team quotes for replacement units; you flag the opportunity and move on.

Requirements
* City & Guilds or NVQ Level 3 in refrigeration and air conditioning — essential.
* F-Gas Category 1 — essential.
* Full UK driving licence.

Nice to have
* Supermarket or cold store experience.

Benefits
* Van, fuel card, tools and PPE provided.
* Overtime at time and a half, standby allowance, 24 days holiday.

Brantham Services is an equal opportunity employer.`,
    expect: ['Field Service & Maintenance'],
    forbid: [
      // "Our controls engineers program the BMS and the PLCs."
      'Control & Robotics Engineering',
      // "Our sales team quotes for replacement units".
      'Sales Execution',
    ],
    mustHave: ['Field Service & Maintenance'],
  },
  {
    id: 'ret-01-retail-buyer',
    domain: 'retail',
    title: 'Buyer — Womenswear',
    band: 'established',
    note: 'Buying and negotiation; freight belongs to supply chain and the campaign to marketing.',
    jd: `Buyer — Womenswear

About Lyle & Fenn
We are a 60-store womenswear retailer with a growing online business. We buy
twice a season and we get it wrong often enough to stay humble. We publish a
sustainability report every year and we have committed to net zero by 2035.

What you'll do
- Own the range plan and assortment for womenswear, including the decision to
  cut a line that people in the building love.
- Negotiate cost prices and terms directly with our mills in Portugal and Turkey.
- Manage markdown and sell-through, and decide what to repeat and what to drop.
- Trade the range weekly with the e-commerce team.

Who does what
- Our supply chain team owns freight and the distribution network.
- Our marketing team owns the seasonal campaign planning and the shoots.

Requirements
- Proven buying experience in fashion, with strong commercial judgement.
- Comfortable with a critical path and a supplier who has missed it.

Nice to have
- Experience buying knitwear or outerwear.

Benefits
- Generous staff discount, 25 days holiday, hybrid with two days in our London
  office and a sample sale you will regret.

We are an equal opportunities employer and we welcome applications from
everyone.`,
    expect: ['Retail & Merchandising', 'Negotiation', 'Commercial Acumen'],
    forbid: [
      // "Our supply chain team owns freight and the distribution network."
      'Supply Chain & Logistics',
      // "Our marketing team owns the seasonal campaign planning and the shoots."
      'Marketing & Demand Generation',
      // "We publish a sustainability report every year and we have committed to net
      // zero by 2035" is the company blurb.
      'Energy & Sustainability Analysis',
      // "Comfortable with a critical path and a supplier who has missed it" — the
      // critical path in apparel buying is the sourcing calendar.
      'Project & Delivery Management',
    ],
    mustHave: ['Retail & Merchandising'],
  },
];
