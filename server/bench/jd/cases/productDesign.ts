import type { JdGoldCase } from '../types.js';

/**
 * Product and design adverts.
 *
 * These are the mirror image of the engineering cases: here the product and
 * design competencies are the real ones, and the engineering mentions are the
 * trap. prod-03 carries a subtler one — a product director who "carries P&L
 * responsibility" is being asked for commercial ownership, not for FP&A.
 */
export const PRODUCT_CASES: readonly JdGoldCase[] = [
  {
    id: 'prod-01-product-manager',
    domain: 'product',
    title: 'Product Manager',
    band: 'established',
    note: 'A genuine product role; the engineers, the designers and the marketers are all somebody else.',
    jd: `Product Manager — Merchant Onboarding

About us
Keyhole helps small businesses open a business account in under an hour. We are
110 people in Edinburgh and Kraków.

What you'll do
- Own the roadmap for merchant onboarding, and be accountable for how many
  merchants get through it.
- Run discovery: customer interviews every fortnight, and the discipline to
  report what you learned that you did not expect.
- Write the requirements engineers can build from without a second meeting.
- Define success metrics up front, and read the A/B tests honestly when they say
  the thing you shipped did nothing.

Who you'll work with
- Engineers building in React and Go. You do not need to code, and we will not
  ask you to.
- Our design team owns the interface; you own the problem it is solving.
- Our marketing team owns the launch campaign.

Requirements
- Proven experience owning a product area end to end, including something you
  chose to kill.
- Strong analytical skills, and comfortable writing your own SQL rather than
  queuing for someone else's time.

Nice to have
- Financial services, KYC or onboarding experience.

Benefits
- 26 days holiday, hybrid working, share options, and a proper induction.

We are an equal opportunities employer. We are also a Living Wage employer and
publish our pay bands internally.`,
    expect: [
      'Product Management',
      'User Research & Discovery',
      'Analytics & Insight',
      'SQL & Data Warehousing',
    ],
    forbid: [
      // "Engineers building in React and Go. You do not need to code."
      'Frontend Engineering',
      'Software Engineering',
      // "Our marketing team owns the launch campaign."
      'Marketing & Demand Generation',
      // "Our design team owns the interface."
      'Product & Interaction Design',
      // "Financial services, KYC or onboarding experience" is a nice-to-have about
      // the industry, not a request for a credit risk manager.
      'Risk & Credit Management',
    ],
    mustHave: ['Product Management'],
  },
  {
    id: 'prod-02-ux-designer',
    domain: 'product',
    title: 'UX Designer',
    band: 'developing',
    note: 'Design role sitting next to front-end engineers and a product manager who owns the roadmap.',
    jd: `UX Designer

Who we are
Pelham builds software for veterinary practices. Our users are holding a cat
while they use it, which shapes most of our design decisions.

What you'll do
• Design flows end to end in Figma, from wireframe through to a prototype people
  can click.
• Run usability tests with six to eight users a round, and change the design when
  they tell you something you did not want to hear.
• Contribute to and maintain our design system.
• Sit with our front-end engineers, who build in React, while they implement your work.

Who you are
• Strong Figma skills are essential, including components and variants.
• A portfolio showing two or three flows you designed, and what changed after testing.
• You can explain a design decision without using the word "clean".

Nice to have
• Experience designing for people who are not at a desk.

What we offer
• 25 days holiday, hybrid, and a budget for whatever software you need.
• Our product manager owns the roadmap, so you will always know why something matters.

Pelham is an equal opportunity employer and we welcome applications from
everyone regardless of background.`,
    expect: ['Product & Interaction Design', 'User Research & Discovery'],
    forbid: [
      // "Sit with our front-end engineers, who build in React".
      'Frontend Engineering',
      // "Our product manager owns the roadmap" — and it is in the perks section.
      'Product Management',
    ],
    mustHave: ['Product & Interaction Design'],
  },
  {
    id: 'prod-03-director-of-product',
    domain: 'product',
    title: 'Director of Product',
    band: 'executive',
    note: 'P&L responsibility is commercial ownership, not financial planning; demand belongs to the CMO.',
    jd: `Director of Product

About Marchetti
We sell field service management software to companies with between 50 and 500
engineers on the road. £40m ARR, profitable since 2021, 340 people. We were
bootstrapped for our first six years and it still shows in how we argue about
spending money.

What you'll do
- Own the product strategy for the whole portfolio — three products that were
  bought separately and have never really been one thing.
- Lead and grow a team of six product managers, two of whom are ready for more
  than they currently have.
- Carry P&L responsibility for the portfolio.
- Make the prioritisation calls across competing portfolio demands, and be able
  to say out loud what you have decided not to do this year.
- Present to the board and the executive team monthly.

Who owns what
- Our CTO owns engineering and the technical roadmap.
- Our CMO owns demand generation and the campaign calendar.

Requirements
- Proven experience leading product managers, including someone you had to
  performance manage.
- Deep experience in B2B SaaS with a portfolio rather than a single product.
- Evidence you can make a commercial argument to a sceptical board.

What we offer
- Six-figure base, bonus, and meaningful equity.
- 30 days holiday, private medical, and no expectation of email at the weekend.

Marchetti is an equal opportunity employer. We do not discriminate on the basis
of any protected characteristic and we are happy to discuss flexible working for
every role including this one.`,
    expect: [
      'Product Management',
      'People Leadership',
      'Stakeholder & Influence',
      'Commercial Acumen',
      'Prioritisation & Judgement',
    ],
    forbid: [
      // "Carry P&L responsibility for the portfolio" is commercial ownership. Nobody
      // interviews a product director on variance analysis because of this line.
      'Financial Analysis & Planning',
      // "Our CMO owns demand generation and the campaign calendar."
      'Marketing & Demand Generation',
      // "We sell field service management software" — what the company sells.
      'Field Service & Maintenance',
    ],
    mustHave: ['Product Management', 'People Leadership'],
  },
];
