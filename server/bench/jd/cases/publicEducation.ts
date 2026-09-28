import type { JdGoldCase } from '../types.js';

/**
 * Education, HR and public sector adverts.
 *
 * edu-01 carries the trap that safeguarding is a school word as much as a
 * clinical one, and that the attainment dashboards belong to the data manager.
 * hr-01 has payroll sitting with finance and employment law with counsel, both
 * of which an advert names precisely because they are NOT the HRBP's job.
 */
export const PUBLIC_EDUCATION_CASES: readonly JdGoldCase[] = [
  {
    id: 'edu-01-secondary-teacher',
    domain: 'education',
    title: 'Teacher of Mathematics',
    band: 'developing',
    note: 'Safeguarding referrals belong to the safeguarding lead; attainment dashboards to the data manager.',
    jd: `Teacher of Mathematics — September start

About the school
Greenhill Academy is an 11-18 comprehensive of 1,240 students in south Bristol.
We were judged Good in 2023 and our maths results are the best they have been.
We are hiring because a colleague is retiring after 31 years.

What you'll do
- Teach mathematics across KS3 and KS4, with A-level for the right candidate.
- Plan lessons and set assessment that tells you what students actually
  understood, rather than what they could copy.
- Mark, report and meet parents, including the parents who are difficult to reach.
- Act as a form tutor and contribute to the wider life of the school.

Who you'll work with
- Our safeguarding lead handles child protection referrals; you report concerns
  to them the same day.
- Our data manager produces the attainment dashboards you will use at data drops.

What we're looking for
- QTS is essential, or you are completing it this year.
- A degree in mathematics or a closely related subject.
- High expectations of every student, including the ones who have decided they
  are bad at maths.

What we offer
- A strong CPD programme and a genuine early career framework for ECTs.
- Teachers' pension, a two-week October half term, and free parking.

Greenhill Academy is committed to safeguarding and promoting the welfare of
children. All appointments are subject to an enhanced DBS check and online
searches. We are an equal opportunities employer.`,
    expect: ['Teaching & Facilitation'],
    forbid: [
      // "Our safeguarding lead handles child protection referrals" — and the same
      // word again in the unheaded legal paragraph at the end.
      'Clinical & Patient Care',
      // "Our data manager produces the attainment dashboards".
      'Analytics & Insight',
    ],
    mustHave: ['Teaching & Facilitation'],
  },
  {
    id: 'hr-01-hr-business-partner',
    domain: 'hr',
    title: 'HR Business Partner',
    band: 'senior',
    note: 'Payroll sits with finance and escalated employment law with counsel.',
    jd: `HR Business Partner

About us
Calderbank is a 1,900-person facilities business operating across 40 sites. The
people team is eleven, and this role partners two operational directors.

What you'll do
* Partner two directors on workforce planning and succession for around 600 people.
* Handle complex employee relations cases end to end, including disciplinaries,
  grievances and the occasional tribunal.
* Mentor and coach line managers through the conversations they would rather
  avoid having.
* Influence senior stakeholders without authority, including when the answer they
  want is not available.
* Own the engagement action plan for your sites and make it mean something.

Who does what
* Our payroll team processes payroll and benefits administration.
* Our legal counsel advises on the employment law questions that escalate.

Requirements
* CIPD Level 7, or equivalent experience that you can evidence.
* Proven experience as an HRBP in a multi-site operational business.
* Strong employee relations casework, including at least one case that went wrong.

Benefits
* Car allowance, 27 days holiday, healthcare cash plan.
* Hybrid, though this role needs you on site more than most.

Calderbank is an equal opportunity employer. We are committed to creating an
inclusive environment for all employees and applicants.`,
    expect: ['Talent & People Management', 'Mentoring & Coaching', 'Stakeholder & Influence'],
    forbid: [
      // "Our payroll team processes payroll and benefits administration."
      'Accounting & Controls',
      // "Our legal counsel advises on the employment law questions that escalate."
      'Legal & Contracting',
    ],
    mustHave: ['Talent & People Management'],
  },
  {
    id: 'pub-01-programme-director',
    domain: 'public_sector',
    title: 'Programme Director',
    band: 'principal',
    note: 'Public programme leadership; tendering belongs to procurement and the budget profile to finance.',
    jd: `Programme Director — Regional Skills

About the programme
This is a £30m programme running across five local authorities to improve adult
skills outcomes in the region. It was announced eighteen months ago, it has
spent very little of its money, and it now needs someone to run it properly. We
are being candid about that in the advert because you will find out in week one.

What you'll do
1. Lead the programme across five local authorities, each of which has its own
   view about what the money is for.
2. Own the delivery plan, the risk register and the dependencies between
   workstreams that do not report to you.
3. Run stakeholder consultation with providers, employers and learner
   representatives, and let it change the design where it should.
4. Commission impact evaluation and act on what it finds, including if it finds
   the programme is not working.
5. Report to the programme board and to the regional mayor's office.
6. Line manage four workstream leads.

Who does what
- Our procurement team runs the tendering for delivery partners.
- Our finance business partner owns the budget profile and variance reporting.

Requirements
- Proven experience leading a programme of this scale in or with government.
- Evidence of delivering through partners you do not control.
- The judgement to escalate a programme that is failing before it is obvious.

What we offer
- Local government pension scheme, 32 days annual leave, flexible working.

We are proud to be a Disability Confident Leader and we guarantee an interview
to disabled candidates who meet the essential criteria. We welcome applications
from candidates who are currently under-represented in our senior roles.`,
    expect: [
      'Public Policy & Programme Delivery',
      'Project & Delivery Management',
      'Stakeholder & Influence',
      'People Leadership',
    ],
    forbid: [
      // "Our procurement team runs the tendering for delivery partners."
      'Procurement & Vendor Management',
      // "Our finance business partner owns the budget profile and variance reporting."
      'Financial Analysis & Planning',
    ],
    mustHave: ['Public Policy & Programme Delivery', 'Project & Delivery Management'],
  },
];
