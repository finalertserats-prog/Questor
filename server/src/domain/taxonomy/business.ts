import type { CanonicalCompetencyDef } from './types.js';

/**
 * Domain competencies — what a business function is actually hired to do.
 *
 * Read the Product Management cues first. They are the reason this file is
 * shaped the way it is: the bare word "product" is not a cue and never will
 * be, because "partner with product teams" on a data engineering advert is a
 * sentence about somebody else's job. Only an ownership phrase — "own the
 * roadmap", "product discovery", "write PRDs" — evidences that this role is
 * the product role.
 */
export const BUSINESS_COMPETENCIES: readonly CanonicalCompetencyDef[] = [
  {
    name: 'Product Management',
    category: 'domain',
    definition: 'Decides what to build and what not to, and is accountable for the outcome.',
    indicators: ['Describes something they chose not to build and why', 'Explains how they knew a bet had failed', 'Names the outcome the product moved'],
    aliases: ['Product Ownership', 'Product Strategy', 'Product Discovery'],
    cues: [
      /\b(product (roadmap|strategy|discovery|vision|backlog|requirements|management|lifecycle))\b/i,
      /\b(own(s|ing|ed)? the (product|roadmap|backlog)|roadmap ownership|product owner\b|product manager\b)\b/i,
      /\b(write (prds?|product requirements)|\bprd\b|user stories|acceptance criteria|prioritis(e|ing) the backlog|prioritiz(e|ing) the backlog)\b/i,
      /\b(go[- ]to[- ]market (plan|strategy) for the product|product[- ]market fit|define the product)\b/i,
    ],
    domains: ['product', 'software', 'frontier_ai', 'retail', 'bfsi'],
  },
  {
    name: 'User Research & Discovery',
    category: 'domain',
    definition: 'Finds out what people actually need rather than what they asked for.',
    indicators: ['Describes a finding that contradicted the plan', 'Explains how they avoided leading the question', 'Says what the research could not tell them'],
    aliases: ['UX Research', 'Customer Research', 'Design Research'],
    cues: [
      /\b(user research|ux research|usability testing|customer (interviews?|discovery)|contextual inquiry|design research)\b/i,
      /\b(personas?|journey map(ping)?|jobs[- ]to[- ]be[- ]done|\bjtbd\b)\b/i,
    ],
    domains: ['product', 'marketing', 'education', 'public_sector'],
  },
  {
    name: 'Product & Interaction Design',
    category: 'domain',
    definition: 'Designs how a product behaves, not only how it looks.',
    indicators: ['Explains a flow they simplified and what it cost', 'Describes designing for an edge case', 'Reasons about the system, not the screen'],
    aliases: ['UX Design', 'UI Design', 'Interaction Design', 'Product Design'],
    cues: [
      /\b(ux design|ui design|product design|interaction design|design system|wireframes?|prototyp(e|ing))\b/i,
      /\b(figma|sketch\b|adobe xd|information architecture|visual design)\b/i,
    ],
    domains: ['product', 'media', 'retail'],
  },
  {
    name: 'Sales Execution',
    category: 'domain',
    definition: 'Finds, qualifies and closes business, and is honest about a deal that will not land.',
    indicators: ['Walks through a deal they lost and why', 'Explains their qualification test', 'Describes a forecast they had to correct'],
    aliases: ['Sales', 'Business Development', 'New Business', 'Account Executive'],
    cues: [
      /\b(sales (quota|target|cycle|pipeline|process)|quota[- ]carrying|closing deals|new business|business development)\b/i,
      /\b(prospect(ing|s)?|lead generation|cold (call|outreach)|\bmeddic\b|\bbant\b|qualif(y|ication) (leads|opportunities))\b/i,
      // HubSpot is a marketing automation tool before it is a CRM, and naming
      // it here put Sales Execution on a marketing manager's scorecard.
      /\b(salesforce|\bcrm\b|outreach\.io|deal desk)\b/i,
      /\b(account (executive|management)|territory plan|renewals? (target|quota)|upsell|cross[- ]sell)\b/i,
    ],
    domains: ['sales', 'customer_success', 'retail', 'bfsi'],
  },
  {
    name: 'Solution & Pre-Sales Engineering',
    category: 'domain',
    definition: 'Translates a customer problem into something the product can actually do.',
    indicators: ['Describes a demo they had to rebuild', 'Explains a requirement they said no to', 'Reasons about the buyer and the user separately'],
    aliases: ['Pre-Sales', 'Sales Engineering', 'Solutions Consulting', 'Solutions Architecture'],
    cues: [
      /\b(pre[- ]?sales|sales engineer|solutions? (engineer|consultant|architect)|technical (demo|demonstration)|proof of concept|\bpoc\b)\b/i,
      /\b(\brfp\b|\brfi\b|request for proposal|bid (response|support)|technical discovery)\b/i,
    ],
    domains: ['sales', 'customer_success', 'strategy'],
  },
  {
    name: 'Customer Success & Retention',
    category: 'domain',
    definition: 'Keeps customers getting value, and sees churn coming.',
    indicators: ['Describes an account they saved and how', 'Explains an early warning signal they trust', 'Names a customer they let go and why'],
    aliases: ['Customer Success', 'Account Management', 'Client Services', 'Relationship Management'],
    cues: [
      /\b(customer success|account management|client (relationship|servicing)|retention|churn|renewals?)\b/i,
      /\b(onboarding customers|adoption (metrics|plan)|\bqbr\b|quarterly business review|health scores?|\bnps\b|\bcsat\b)\b/i,
    ],
    domains: ['customer_success', 'sales', 'customer_service'],
  },
  {
    name: 'Marketing & Demand Generation',
    category: 'domain',
    definition: 'Creates and measures demand, and can tell the difference between noise and a signal.',
    indicators: ['Describes a campaign that did not work and what they learned', 'Explains their attribution and its limits', 'Names the metric they optimised and why'],
    aliases: ['Marketing', 'Demand Generation', 'Growth Marketing', 'Digital Marketing'],
    cues: [
      /\b(demand gen(eration)?|growth marketing|performance marketing|digital marketing|campaign (management|strategy|planning))\b/i,
      /\b(\bseo\b|\bsem\b|\bppc\b|paid (media|social|search)|marketing automation|marketo|\bhubspot\b|email marketing)\b/i,
      /\b(lead nurtur|conversion rate|attribution model|marketing funnel|\bcac\b|\broas\b)\b/i,
    ],
    domains: ['marketing', 'retail', 'media'],
  },
  {
    name: 'Brand & Content',
    category: 'domain',
    definition: 'Says what the organisation stands for, consistently, to people who did not ask.',
    indicators: ['Explains a brand decision they defended', 'Describes editing their own work down', 'Reasons about audience before channel'],
    aliases: ['Brand Management', 'Content Marketing', 'Copywriting', 'Corporate Communications'],
    cues: [
      /\b(brand (strategy|management|positioning|guidelines)|content (strategy|marketing|calendar)|editorial|copywriting)\b/i,
      /\b(storytelling|tone of voice|social media strategy|public relations|\bpr\b campaigns?|thought leadership)\b/i,
    ],
    domains: ['marketing', 'media', 'public_sector', 'education'],
  },
  {
    name: 'Financial Analysis & Planning',
    category: 'domain',
    definition: 'Builds the numbers a decision rests on, and knows which assumption carries the weight.',
    indicators: ['Names the assumption that moved the model most', 'Describes a forecast they got wrong', 'Explains a variance honestly'],
    aliases: ['FP&A', 'Financial Planning', 'Financial Modelling', 'Finance', 'Finance & Analysis'],
    cues: [
      /\b(financial (analysis|model(l)?ing|planning|reporting)|\bfp&a\b|budgeting and forecasting|variance analysis)\b/i,
      // The management accounts and the balance sheet are the bookkeeper's
      // output, not the planner's, and they belong to Accounting & Controls.
      /\b(\bp&l\b|profit and loss|cash ?flow|cost centre|\bopex\b|\bcapex\b)\b/i,
      /\b(three[- ]statement model|\bdcf\b|scenario (analysis|planning)|unit economics)\b/i,
    ],
    // "P&L responsibility" belongs to Commercial Acumen: a product director
    // carrying a P&L is not being interviewed on variance analysis.
    notWhen: [/\bp&l (responsibility|ownership|accountability)\b/i],
    domains: ['finance', 'bfsi', 'strategy', 'retail'],
  },
  {
    name: 'Accounting & Controls',
    category: 'domain',
    definition: 'Keeps the books right and the controls working.',
    indicators: ['Describes a reconciliation that did not balance', 'Explains a control they designed', 'Reasons about materiality'],
    aliases: ['Accounting', 'Financial Control', 'Audit', 'Statutory Reporting'],
    cues: [
      // "Reconciliation" unqualified matched "medicines reconciliation" on a
      // nursing advert, so it has to name what is being reconciled.
      /\b(accounting|\bgaap\b|\bifrs\b|month[- ]end close|year[- ]end close|general ledger|journal entries|management accounts|balance sheet|(account|bank|ledger|invoice|payment|intercompany|balance sheet)\s+reconciliation)\b/i,
      /\b(internal controls?|\bsox\b|statutory (accounts|reporting)|external audit|tax compliance|\bvat\b|payroll processing)\b/i,
    ],
    domains: ['finance', 'bfsi', 'public_sector'],
  },
  {
    name: 'Risk & Credit Management',
    category: 'domain',
    definition: 'Quantifies what could go wrong and decides how much of it to accept.',
    indicators: ['Explains a limit and how it was set', 'Describes a risk that materialised', 'Reasons about tail events, not averages'],
    aliases: ['Risk Management', 'Credit Risk', 'Market Risk', 'Operational Risk'],
    cues: [
      /\b(risk (management|assessment|appetite|framework|model(l)?ing)|credit risk|market risk|operational risk|liquidity risk)\b/i,
      /\b(\bvar\b model|stress test(ing)?|basel\b|\bifrs ?9\b|credit scoring|underwriting|exposure limits?)\b/i,
      /\b(fraud (detection|prevention)|\baml\b|anti[- ]money laundering|\bkyc\b|sanctions screening)\b/i,
    ],
    domains: ['bfsi', 'finance', 'legal'],
  },
  {
    name: 'Legal & Contracting',
    category: 'domain',
    definition: 'Turns commercial intent into terms that hold, and flags the ones that do not.',
    indicators: ['Describes a clause they refused', 'Explains a negotiation they lost well', 'Reasons about risk allocation, not wording'],
    aliases: ['Legal Counsel', 'Contract Management', 'Commercial Law', 'Contract Negotiation'],
    cues: [
      /\b(contract (negotiation|drafting|management|review)|legal (advice|counsel|review)|\bmsa\b|\bnda\b|\bsow\b|terms of service)\b/i,
      // "Commercial terms" belongs to Negotiation: a salesperson negotiating
      // them is not practising law, and this made every account executive a
      // contracts lawyer.
      /\b(intellectual property|licensing agreements?|indemnit|liability cap|dispute resolution)\b/i,
    ],
    domains: ['legal', 'bfsi', 'strategy'],
  },
  {
    name: 'Regulatory Compliance',
    category: 'domain',
    definition: 'Keeps the organisation inside rules that change, and can show that it did.',
    indicators: ['Describes an inspection or audit they carried', 'Explains a rule they had to interpret', 'Reasons about evidence, not intent'],
    aliases: ['Compliance', 'Governance & Compliance', 'Regulatory Affairs'],
    cues: [
      /\b(regulatory (compliance|affairs|reporting|submission)|compliance (programme|program|framework|monitoring))\b/i,
      // ISO 9001 is the quality standard and belongs to Quality Management;
      // naming it here made every quality engineer a compliance officer too.
      /\b(\bfca\b|\bsec\b|\bfda\b|\bmhra\b|\bce mark|\biso ?(?!9001)\d{4,5}\b|\bsoc ?2\b|audit readiness|regulatory inspection)\b/i,
    ],
    domains: ['legal', 'bfsi', 'healthcare', 'life_sciences', 'public_sector', 'energy'],
  },
  {
    name: 'Strategy & Commercial Analysis',
    category: 'domain',
    definition: 'Frames a choice the business has to make, and argues it on evidence.',
    indicators: ['States the decision the work was for', 'Describes the option they rejected', 'Names what would change their mind'],
    aliases: ['Strategy', 'Corporate Strategy', 'Business Strategy', 'Management Consulting', 'Strategic Planning'],
    cues: [
      /\b(corporate strateg|business strateg|strategic (planning|analysis|initiative)|market (entry|sizing|analysis))\b/i,
      /\b(competitive (analysis|landscape|positioning)|business case|\bm&a\b|due diligence|value creation plan)\b/i,
      /\b(management consult|transformation (programme|program)|operating model design)\b/i,
    ],
    // In compliance, "enhanced" and "customer" due diligence are anti-money-
    // laundering checks on a person, not a transaction. Same two words,
    // entirely different job.
    notWhen: [/\b(enhanced|customer|client|ongoing) due diligence\b|\b(edd|cdd|kyc|aml)\b/i],
    domains: ['strategy', 'finance', 'bfsi', 'public_sector'],
  },
  {
    name: 'Operations Management',
    category: 'domain',
    definition: 'Runs a process at volume and makes it better without breaking it.',
    indicators: ['Names the bottleneck they removed', 'Describes a change that failed in practice', 'Reasons about variance, not averages'],
    aliases: ['Business Operations', 'Operational Excellence', 'Process Improvement', 'Service Delivery'],
    cues: [
      /\b(operations management|business operations|operational (excellence|efficiency)|process (improvement|optimis|optimiz|re[- ]?engineering|mapping))\b/i,
      /\b(lean\b|six sigma|kaizen|\bsop\b|standard operating procedure|throughput|cycle time|capacity planning)\b/i,
      /\b(service delivery|\bsla\b management|shared services|back[- ]office operations)\b/i,
    ],
    domains: ['customer_service', 'manufacturing', 'supply_chain', 'strategy', 'hospitality'],
  },
  {
    name: 'Supply Chain & Logistics',
    category: 'domain',
    definition: 'Moves goods and plans supply against demand that will not behave.',
    indicators: ['Describes a shortage they managed', 'Explains a safety-stock decision', 'Reasons about lead time and variability'],
    aliases: ['Supply Chain', 'Logistics', 'Demand Planning', 'Inventory Management'],
    cues: [
      /\b(supply chain|logistics|demand planning|inventory (management|optimis|optimiz)|\bs&op\b|sales and operations planning)\b/i,
      /\b(warehous(e|ing) (operations|management)|freight|distribution network|lead times?|safety stock|\bwms\b|\bmrp\b)\b/i,
    ],
    domains: ['supply_chain', 'manufacturing', 'retail', 'agriculture'],
  },
  {
    name: 'Procurement & Vendor Management',
    category: 'domain',
    definition: 'Buys well and holds suppliers to what they agreed.',
    indicators: ['Describes a supplier they exited', 'Explains a total-cost argument', 'Reasons about dependency, not price'],
    aliases: ['Procurement', 'Sourcing', 'Vendor Management', 'Supplier Management'],
    cues: [
      /\b(procurement|strategic sourcing|vendor management|supplier (management|selection|negotiation|performance))\b/i,
      /\b(\brfq\b|tender(ing)?|category management|total cost of ownership|\btco\b|contract renewals?|spend analysis)\b/i,
    ],
    domains: ['supply_chain', 'finance', 'public_sector', 'construction'],
  },
  {
    name: 'Manufacturing & Process Engineering',
    category: 'domain',
    definition: 'Makes a physical process produce consistently at the required quality.',
    indicators: ['Describes a yield problem they solved', 'Explains a control chart they acted on', 'Reasons about root cause, not symptom'],
    aliases: ['Manufacturing Engineering', 'Production Engineering', 'Process Engineering', 'Industrial Engineering'],
    cues: [
      /\b(manufacturing (process|engineering|operations)|production (line|process|planning)|process engineering|industrial engineering)\b/i,
      /\b(\bspc\b|statistical process control|yield improvement|\boee\b|root cause (analysis|corrective)|\bcapa\b|\bfmea\b)\b/i,
      /\b(industry 4\.0|smart factory|\bgmp\b|good manufacturing practice)\b/i,
    ],
    domains: ['manufacturing', 'semiconductor', 'automotive', 'life_sciences', 'aerospace'],
  },
  {
    name: 'Quality Management',
    category: 'domain',
    definition: 'Defines what good means here, and proves whether it was met.',
    indicators: ['Describes a non-conformance they handled', 'Explains a standard in their own words', 'Reasons about the customer, not the certificate'],
    aliases: ['Quality Control', 'QMS', 'Quality Systems'],
    cues: [
      /\b(quality (management|system|control|assurance|standards)|\bqms\b|\biso ?9001\b|non[- ]conformance|\bqa\/qc\b)\b/i,
      /\b(inspection (process|regime)|audit(ing)? (suppliers|processes)|calibration|validation protocol|\biq\/oq\/pq\b)\b/i,
    ],
    domains: ['manufacturing', 'life_sciences', 'healthcare', 'construction', 'aerospace'],
  },
  {
    name: 'Clinical & Patient Care',
    category: 'domain',
    definition: 'Cares for patients safely within scope, and escalates when it is beyond it.',
    indicators: ['Describes a deterioration they spotted', 'Explains an escalation decision', 'Reasons about consent and dignity'],
    aliases: ['Clinical Practice', 'Patient Care', 'Nursing', 'Clinical Operations'],
    cues: [
      /\b(patient (care|safety|outcomes|pathway)|clinical (practice|governance|operations|trials?|protocol)|bedside)\b/i,
      // "Safeguarding" now has its own competency; "triage" is IT's word too,
      // and both were putting patient care on adverts that had none.
      /\b(nursing|physician|diagnosis and treatment|care plan|\bnice\b guidelines|clinical triage)\b/i,
    ],
    // On a trials advert, "Good Clinical Practice" is a regulation and a
    // nursing qualification is an alternative way in — neither means this
    // person will be caring for a patient.
    notWhen: [/\bgood clinical practice\b|\blife sciences degree\b/i],
    domains: ['healthcare', 'life_sciences'],
  },
  {
    name: 'Scientific Research & Experimentation',
    category: 'domain',
    definition: 'Designs experiments that can be wrong, and reports what they found.',
    indicators: ['Describes a negative result they published or acted on', 'Explains a control and why it was needed', 'Reasons about replication'],
    aliases: ['Research', 'R&D', 'Applied Research', 'Laboratory Science'],
    cues: [
      /\b(research (design|methodology|programme|program)|experimental design|hypothes(is|es)|peer[- ]reviewed|publications?)\b/i,
      /\b(laborator(y|ies)|assay|in ?vitro|in ?vivo|clinical trial (design|protocol)|good clinical practice|good laboratory practice)\b/i,
      /\b(\bphd\b|postdoctoral|grant (funding|applications?)|principal investigator)\b/i,
    ],
    domains: ['science', 'life_sciences', 'healthcare', 'education', 'frontier_ai'],
  },
  {
    name: 'Energy & Sustainability Analysis',
    category: 'domain',
    definition: 'Measures environmental and energy performance and makes it decision-grade.',
    indicators: ['Explains a boundary choice in a footprint', 'Describes a claim they refused to make', 'Reasons about counterfactuals'],
    aliases: ['Sustainability', 'ESG', 'Carbon Accounting', 'Energy Management'],
    cues: [
      /\b(sustainability|\besg\b|carbon (accounting|footprint|reduction)|scope [123] emissions|net zero|decarbonis|decarboniz)/i,
      /\b(renewable(s| energy)|energy (efficiency|management|transition)|life ?cycle assessment|\blca\b|\bcsrd\b|\bghg\b protocol)\b/i,
    ],
    domains: ['sustainability', 'energy', 'manufacturing', 'construction'],
  },
  {
    name: 'Construction & Project Delivery',
    category: 'domain',
    definition: 'Delivers physical work to programme, cost and safety.',
    indicators: ['Describes a programme slip and its recovery', 'Explains a safety stop they called', 'Reasons about sequencing'],
    aliases: ['Construction Management', 'Site Management', 'Civil Engineering', 'Site Delivery'],
    cues: [
      /\b(construction (management|projects?|site)|site (management|supervision)|civil engineering|structural engineering)\b/i,
      /\b(\bbim\b|\bnec ?[34]\b|\bjct\b|snagging|programme of works|method statement|\bcdm\b regulations)\b/i,
      /\b(health and safety on site|\briba\b|quantity surveying|cost plan)\b/i,
    ],
    domains: ['construction', 'energy', 'trades', 'aerospace'],
  },
  {
    name: 'Talent & People Management',
    category: 'domain',
    definition: 'Hires, develops and — when it is right — moves people on, fairly.',
    indicators: ['Describes a hire that did not work out', 'Explains feedback they had to give', 'Reasons about the person, not the process'],
    aliases: ['HR', 'Human Resources', 'People Operations', 'Talent Acquisition', 'Recruitment'],
    cues: [
      /\b(talent (acquisition|management|development)|recruit(ing|ment)|people (operations|partner)|human resources|\bhr\b business partner)\b/i,
      /\b(performance (management|reviews?)|succession planning|employee (relations|engagement)|compensation and benefits|\bl&d\b|learning and development)\b/i,
      /\b(workforce planning|onboarding programme|\bhris\b|workday\b|employment law)\b/i,
    ],
    domains: ['hr', 'public_sector', 'education'],
  },
  {
    name: 'Teaching & Facilitation',
    category: 'domain',
    definition: 'Helps other people learn something difficult, and checks whether they did.',
    indicators: ['Describes an explanation that failed and the one that worked', 'Explains how they assess understanding', 'Reasons about the learner, not the material'],
    aliases: ['Training', 'Instruction', 'Learning Design', 'Curriculum Design'],
    cues: [
      /\b(teach(ing)?|training delivery|facilitat(e|ing|ion)|curriculum (design|development)|instructional design|learning design)\b/i,
      /\b(lesson planning|assessment (design|criteria)|pedagog|\bcpd\b|workshops?)\b/i,
    ],
    domains: ['education', 'hr', 'public_sector', 'healthcare'],
  },
  {
    name: 'Customer Service Delivery',
    category: 'domain',
    definition: 'Resolves a person\'s problem well, at volume, without losing the person.',
    indicators: ['Describes a complaint they turned around', 'Explains when they broke the script', 'Reasons about resolution, not handling time'],
    aliases: ['Customer Support', 'Contact Centre', 'Service Desk', 'Technical Support'],
    cues: [
      /\b(customer (service|support)|contact cent(re|er)|help ?desk|service desk|technical support|first[- ]line support)\b/i,
      /\b(ticket(ing)? (system|volume)|zendesk|servicenow|freshdesk|escalation (process|management)|complaint handling)\b/i,
      /\b(\bitil\b|incident tickets|first contact resolution|average handling time)\b/i,
    ],
    // "Many of our analysts came from a service desk background" says where
    // people arrived from, not what this job asks of them.
    notWhen: [/\b(background|came from|started (out )?(in|on)|if that is you)\b/i],
    domains: ['customer_service', 'customer_success', 'retail', 'hospitality'],
  },
  {
    name: 'Retail & Merchandising',
    category: 'domain',
    definition: 'Decides what to sell, at what price, in what quantity, where.',
    indicators: ['Describes a markdown decision', 'Explains a range they cut', 'Reasons about sell-through, not sales'],
    aliases: ['Merchandising', 'Buying', 'Category Management', 'Retail Operations'],
    cues: [
      /\b(merchandising|buying (team|plan)|category management|range planning|assortment|markdown|sell[- ]through)\b/i,
      /\b(retail operations|store operations|\bepos\b|planogram|visual merchandising|e[- ]?commerce trading)\b/i,
    ],
    // Procurement says "category management" about spend categories, which has
    // nothing to do with a retail range.
    notWhen: [/\b(indirect spend|procurement|supplier|sourcing|tender)\b/i],
    domains: ['retail', 'supply_chain', 'marketing'],
  },
  {
    name: 'Hospitality & Event Operations',
    category: 'domain',
    definition: 'Delivers an experience on the day, to standard, whatever happens.',
    indicators: ['Describes a service failure they recovered', 'Explains a staffing call under pressure', 'Reasons about the guest, not the plan'],
    aliases: ['Hospitality Operations', 'Event Management', 'Food Service Operations'],
    cues: [
      /\b(hospitality|guest experience|front of house|food (service|safety)|\bhaccp\b|banqueting|event (management|operations|delivery))\b/i,
      /\b(covers per|rota (planning|management)|revenue per available|\bpms\b|booking system)\b/i,
    ],
    domains: ['hospitality', 'customer_service', 'retail'],
  },
  {
    name: 'Public Policy & Programme Delivery',
    category: 'domain',
    definition: 'Designs and runs public programmes that have to work for everybody.',
    indicators: ['Describes a consultation that changed the design', 'Explains an equity consideration', 'Reasons about accountability'],
    aliases: ['Public Policy', 'Policy Development', 'Policy Delivery', 'International Development'],
    cues: [
      /\b(public (policy|sector|services?)|policy (development|analysis|advice)|programme delivery|government (programme|department))\b/i,
      /\b(stakeholder consultation|impact evaluation|\bmonitoring and evaluation\b|\bm&e\b|theory of change|grant management)\b/i,
    ],
    domains: ['public_sector', 'education', 'sustainability'],
  },
  {
    name: 'Field Service & Maintenance',
    category: 'domain',
    definition: 'Keeps physical assets working, on site, often alone.',
    indicators: ['Describes a fault they diagnosed without the manual', 'Explains a safety isolation', 'Reasons about wear and planned maintenance'],
    aliases: ['Maintenance', 'Field Service', 'Asset Management', 'Plant Maintenance'],
    cues: [
      /\b(field service|preventative maintenance|planned maintenance|asset (management|integrity)|plant maintenance|breakdown (repair|cover))\b/i,
      /\b(fault (finding|diagnosis)|\bcmms\b|\bloto\b|lock[- ]out tag[- ]out|permit to work|\bhvac\b|electrical installation)\b/i,
    ],
    domains: ['trades', 'manufacturing', 'energy', 'construction'],
  },
  {
    name: 'Health, Safety & Environment',
    category: 'domain',
    definition: 'Keeps people safe on a site or a shop floor, and stops work when it is not safe.',
    indicators: ['Describes a job they stopped and what it cost', 'Explains a control they put in place', 'Reasons about the near miss, not only the accident'],
    aliases: ['HSE', 'Health & Safety', 'EHS', 'Safety Management', 'Occupational Health and Safety'],
    cues: [
      /\b(health and safety|\bhse\b|\behs\b|safety (management|culture|case|critical)|occupational health)\b/i,
      /\b(risk assessments?|method statements?|\brams\b|permit to work|toolbox talks?|near miss|\bcoshh\b|\briddor\b)\b/i,
      /\b(nebosh|\biosh\b|smsts|sssts|cscs)\b/i,
      /\bstop the (job|work|line)\b/i,
    ],
    domains: ['construction', 'trades', 'manufacturing', 'energy', 'aerospace', 'automotive'],
  },
  {
    name: 'Safeguarding & Duty of Care',
    category: 'domain',
    definition: 'Recognises when someone is at risk and acts on it through the proper route.',
    indicators: ['Describes a concern they raised and what happened next', 'Explains the threshold they used', 'Reasons about the person, not the procedure'],
    aliases: ['Safeguarding', 'Child Protection', 'Duty of Care', 'Vulnerable Adults'],
    cues: [
      /\b(safeguarding|child protection|vulnerable (adults?|people|children)|duty of care|prevent duty)\b/i,
      /\b(\bdbs\b|disclosure and barring|designated safeguarding|mandatory reporting)\b/i,
    ],
    // Its own competency precisely so that "safeguarding" on a teacher's
    // advert stops resolving to Clinical & Patient Care, which is a nonsense
    // the gold set caught.
    domains: ['education', 'healthcare', 'public_sector'],
  },
  {
    name: 'Financial Crime & AML',
    category: 'domain',
    definition: 'Spots money moving for the wrong reasons, and can justify both acting and not acting.',
    indicators: ['Describes an alert they escalated and one they closed', 'Explains a typology in their own words', 'Reasons about the customer as well as the rule'],
    aliases: ['AML', 'Anti-Money Laundering', 'KYC', 'Financial Crime', 'Sanctions Compliance', 'Fraud Prevention'],
    cues: [
      /\b(anti[- ]money laundering|\baml\b|financial crime|\bkyc\b|know your customer|\bcdd\b|\bedd\b|customer due diligence)\b/i,
      /\b(sanctions screening|\bpep\b|politically exposed|suspicious activity|\bsar\b|transaction monitoring|typolog)\b/i,
      /\b(fraud (detection|prevention|investigation))\b/i,
    ],
    // Split out of Risk & Credit Management, which read absurdly on a
    // financial-crime advert with no credit or market risk anywhere in it.
    domains: ['bfsi', 'legal', 'finance'],
  },
  {
    name: 'Project & Delivery Management',
    category: 'domain',
    definition: 'Gets work finished across people who do not report to them.',
    indicators: ['Describes a dependency that nearly sank it', 'Explains a scope cut they made', 'Reasons about risk before it happens'],
    aliases: ['Project Management', 'Delivery Management', 'Programme Management', 'Scrum Master', 'Agile Delivery'],
    cues: [
      /\b(project management|delivery management|programme management|\bpmo\b|\bprince2\b|\bpmp\b|critical path)\b/i,
      /\b(scrum master|agile (delivery|coach|ceremonies)|sprint planning|kanban|backlog grooming|\bjira\b administration)\b/i,
      /\b(risk (register|log)|\braid\b log|dependency management|project plan|milestone tracking)\b/i,
    ],
    // In apparel buying the critical path is the sourcing calendar, not a
    // project plan.
    notWhen: [/\b(supplier|sourcing|buying|range|season|fabric)\b/i],
    domains: ['strategy', 'software', 'construction', 'public_sector', 'manufacturing'],
  },
];
