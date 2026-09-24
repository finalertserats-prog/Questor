import type { JdGoldCase } from '../types.js';

/**
 * Healthcare, life sciences and research adverts.
 *
 * ls-01 is the other half of the GCP pair: here the three letters mean Good
 * Clinical Practice, and an extractor that reads the abbreviation instead of
 * the sentence will put Google Cloud on a clinical monitoring role.
 *
 * hc-01 carries the two most deceptive words in this whole gold set —
 * "reconciliation", which in a hospital means medicines and not a ledger, and
 * "rota", which belongs to the ward manager and to hospitality software.
 */
export const HEALTH_SCIENCE_CASES: readonly JdGoldCase[] = [
  {
    id: 'hc-01-registered-nurse',
    domain: 'healthcare',
    title: 'Registered Nurse (Surgical Ward)',
    band: 'established',
    note: 'Medicines reconciliation is not accounting; the rota belongs to the ward manager.',
    jd: `Registered Nurse — Band 5, Surgical Ward

About us
Ashcombe is a 340-bed district general hospital. This post sits on our 28-bed
elective and emergency surgical ward. We have been running with agency cover for
too long and we would like a permanent team again.

What you'll do
• Deliver direct patient care across a 28-bed surgical ward.
• Assess, plan, deliver and evaluate care plans, and escalate deterioration
  early rather than politely.
• Administer medicines safely, and work closely with the pharmacy team on
  medicines reconciliation for every admission.
• Mentor student nurses on placement and support healthcare assistants.
• Maintain accurate records and follow our safeguarding procedures.

Who you'll work with
• Our ward manager owns the rota and the staffing establishment.
• Our quality team runs the ward audits and the accreditation programme.
• Physiotherapy, occupational therapy and discharge coordination all sit
  alongside you on this ward.

Requirements
• Current NMC registration is essential.
• Proven ward experience in surgery or acute medicine.
• Ability to work a rotating shift pattern including nights and weekends.

What we offer
• NHS pension, 27 days annual leave rising with service, and funded CPD.
• Subsidised on-site nursery and free parking on nights.

We are committed to equality of opportunity and we welcome applications from all
sections of the community. This post is subject to an enhanced DBS check.`,
    expect: ['Clinical & Patient Care', 'Mentoring & Coaching'],
    forbid: [
      // "medicines reconciliation" — the word means something entirely different here.
      'Accounting & Controls',
      // "Our ward manager owns the rota and the staffing establishment."
      'Hospitality & Event Operations',
      // "Our quality team runs the ward audits and the accreditation programme."
      'Quality Management',
      // "Physiotherapy, occupational therapy and discharge coordination all sit
      // alongside you" — neighbours, not this role.
      'Operations Management',
    ],
    mustHave: ['Clinical & Patient Care'],
  },
  {
    id: 'ls-01-clinical-research-associate',
    domain: 'life_sciences',
    title: 'Clinical Research Associate',
    band: 'developing',
    note: 'GCP means Good Clinical Practice here — the same three letters as the cloud case.',
    jd: `Clinical Research Associate

About Merrow Clinical
We are a mid-sized CRO running phase II and phase III oncology studies across
Europe. This role is home-based with travel to sites around 60% of the time.

What you'll do
- Monitor investigator sites for our phase II oncology studies, including site
  initiation, routine monitoring and close-out visits.
- Verify source data against the case report forms, and raise queries where the
  two disagree.
- Ensure studies run to protocol and to GCP, and escalate a deviation the day you
  find it rather than the week after.
- Prepare regulatory submissions and amendments for the MHRA.
- Build the kind of relationship with site staff that means they ring you first.

Who does what
- Our data management team runs the clinical database and writes the SQL queries
  behind the listings you review.
- Our biostatistics team owns the statistical analysis plan.

Requirements
- Working knowledge of ICH Good Clinical Practice (GCP) is essential.
- A life sciences degree or a nursing qualification.
- A full driving licence and a genuine willingness to travel.

Nice to have
- Oncology experience, or any therapeutic area with complex eligibility criteria.

Benefits
- Car allowance, 25 days holiday, private medical, and a home office setup.

Merrow Clinical is an equal opportunities employer and we are committed to
making our recruitment process accessible to everyone.`,
    expect: ['Scientific Research & Experimentation', 'Regulatory Compliance'],
    forbid: [
      // GCP here is Good Clinical Practice. Nothing in this advert is about cloud.
      'Cloud & Platform Architecture',
      // "Our data management team runs the clinical database and writes the SQL queries".
      'SQL & Data Warehousing',
      // "Our biostatistics team owns the statistical analysis plan."
      'Analytics & Insight',
      // "Good Clinical Practice" is a standard, and "a nursing qualification" is an
      // entry credential. A CRA monitors sites; they do not nurse anybody.
      'Clinical & Patient Care',
    ],
    mustHave: ['Scientific Research & Experimentation'],
  },
  {
    id: 'sci-01-research-scientist',
    domain: 'science',
    title: 'Senior Research Scientist',
    band: 'senior',
    note: 'A real research role that line manages; the ML work belongs to the data science group.',
    jd: `Senior Research Scientist — Catalysis

About the group
We are a 40-person industrial research group working on catalyst durability for
heavy transport. We publish, and we also have to make things that survive a
truck.

What you'll do
▪ Design and run experiments on catalyst degradation under realistic duty cycles,
  including the controls that make a negative result worth having.
▪ Publish in peer-reviewed journals and present at two conferences a year.
▪ Write grant applications and manage the reporting on the ones that land.
▪ Line manage two postdocs and mentor a PhD student.

Who you'll work with
▪ Our data science group runs the machine learning models on our spectra.
▪ Our facilities team maintains and calibrates the instruments.

Requirements
▪ A PhD in materials chemistry, chemical engineering or similar is required.
▪ A strong publication record in catalysis or a closely related field.
▪ Hands-on experience with in-situ characterisation techniques.

Preferred
▪ Industrial experience alongside academic research.

What we offer
▪ 30 days holiday, a defined benefit pension, and protected time for your own
  research line.

We are an equal opportunity employer and hold an Athena Swan Silver award.`,
    expect: ['Scientific Research & Experimentation', 'People Leadership', 'Mentoring & Coaching'],
    forbid: [
      // "Our data science group runs the machine learning models on our spectra."
      'Machine Learning Engineering',
      // "Our facilities team maintains and calibrates the instruments."
      'Field Service & Maintenance',
      'Quality Management',
    ],
    mustHave: ['Scientific Research & Experimentation'],
  },
];
