import type { CanonicalCompetencyDef } from './types.js';

/**
 * Competencies that belong to no one domain.
 *
 * The first four are marked `baseline`: the platform proposes them on every
 * role whatever the advert says, because an interview that cannot ask how
 * somebody thinks, explains or works with others is not an interview. They
 * carry no JD span — they do not come from the JD — and the product says so
 * on screen rather than passing them off as extracted. That honesty is what
 * lets the rule "no span, no competency" apply without exception to everything
 * that IS claimed to come from the advert.
 *
 * Definitions and indicators for those four are carried over word for word
 * from the set they replace, so approving a role changes no interview.
 *
 * The rest are ordinary extracted competencies. Note what separates
 * "Stakeholder & Influence" from a stakeholder *mention*: its cues are
 * ownership phrases ("stakeholder management", "manage senior stakeholders"),
 * never the bare noun. "Work with stakeholders to gather requirements" has its
 * object masked before cues are tried, so it evidences nothing here — which is
 * correct, because that sentence is about who you sit near, not what you are
 * accountable for.
 */
export const CROSS_CUTTING_COMPETENCIES: readonly CanonicalCompetencyDef[] = [
  {
    name: 'Communication',
    category: 'communication',
    definition: 'Explains complex ideas clearly, listens actively and adapts to the audience.',
    indicators: ['Structures answers logically', 'Checks for understanding', 'Adapts detail to audience'],
    aliases: ['Verbal Communication', 'Communication Skills', 'Clear Communication'],
    cues: [
      /\b(communicat(e|ing|ion) (clearly|effectively|complex)|explain(ing)? (complex|technical) (ideas|concepts) to)\b/i,
      /\b(written and verbal communication|excellent communication|presentation skills|technical writing)\b/i,
    ],
    domains: [],
    baseline: true,
  },
  {
    name: 'Problem Solving',
    category: 'behavioral',
    definition: 'Breaks down ambiguous problems, reasons about trade-offs and validates solutions.',
    indicators: ['Decomposes the problem', 'Considers alternatives and trade-offs', 'Validates the outcome'],
    aliases: ['Analytical Thinking', 'Critical Thinking', 'Troubleshooting'],
    cues: [
      /\b(problem[- ]solving|analytical (thinking|skills|mindset)|critical thinking|structured thinking|first principles)\b/i,
      /\b(troubleshoot(ing)?|diagnos(e|ing) (complex|difficult)|root cause)\b/i,
    ],
    domains: [],
    baseline: true,
  },
  {
    name: 'Collaboration',
    category: 'behavioral',
    definition: 'Works effectively across teams, handles disagreement and shares ownership.',
    indicators: ['Describes cross-functional work', 'Handles conflict constructively', 'Credits the team'],
    aliases: ['Teamwork', 'Cross-functional Working', 'Partnering'],
    cues: [
      /\b(collaborat(e|ion|ive)|team ?work|cross[- ]functional|work(s|ing)? well (with|in) (others|a team))\b/i,
    ],
    domains: [],
    baseline: true,
  },
  {
    name: 'Ownership & Impact',
    category: 'behavioral',
    definition: 'Takes end-to-end ownership and drives measurable outcomes.',
    indicators: ['Owns outcomes not just tasks', 'Quantifies impact', 'Follows through under pressure'],
    aliases: ['Accountability', 'Drive', 'Results Orientation', 'Bias for Action'],
    cues: [
      /\b(end[- ]to[- ]end ownership|take(s|n)? ownership|accountab(le|ility) for|bias (for|to) action|self[- ]starter|autonom(y|ous(ly)?))\b/i,
      /\b(drive (results|outcomes|impact)|deliver(s|ing)? measurable)\b/i,
    ],
    domains: [],
    baseline: true,
  },
  {
    name: 'People Leadership',
    category: 'behavioral',
    definition: 'Leads a team: sets direction, develops people and handles the hard conversations.',
    indicators: ['Describes a difficult conversation they had', 'Explains how they grew someone', 'Names a decision they made that the team disliked'],
    aliases: ['Line Management', 'Team Leadership', 'People Management'],
    cues: [
      // "Lead and grow a team of six product managers" — one conjoined verb
      // was enough to hide a people-leadership requirement completely.
      // "line manager" as a NOUN is usually somebody else. An HR business
      // partner who mentors line managers is not one, and matching the noun
      // made them one. The verb forms are the duty; the noun is the audience.
      /\b(line manage(ment|s|d)?|people (management|leadership)|(manag|lead|grow|build)\w*(\s+and\s+\w+)?\s+(a|the|your)\s+team\b|team of \d+ (direct )?reports?)\b/i,
      /\b(direct reports?|hiring and developing|performance (managing|conversations)|build(ing)? (and scaling )?(a|the) team)\b/i,
    ],
    domains: [],
  },
  {
    name: 'Mentoring & Coaching',
    category: 'behavioral',
    definition: 'Raises the standard of people who do not report to them.',
    indicators: ['Describes something a mentee taught them', 'Explains feedback that landed badly and what they changed', 'Names someone whose work improved'],
    aliases: ['Mentorship', 'Coaching', 'Technical Leadership', 'Knowledge Sharing'],
    cues: [
      /\b(mentor(ing|ship)?|coach(ing)? (junior|other|team)|develop(ing)? (junior|other) (engineers|colleagues|members))\b/i,
      /\b(technical leadership|raise the bar|knowledge sharing|pair(ing)? with (junior|others))\b/i,
    ],
    domains: [],
  },
  {
    name: 'Stakeholder & Influence',
    category: 'behavioral',
    definition: 'Gets agreement from people who do not have to agree, on the merits.',
    indicators: ['Describes changing a senior person\'s mind', 'Explains a case they lost and why', 'Reasons about the other side\'s incentives'],
    aliases: ['Stakeholder Management', 'Influencing', 'Executive Communication', 'Relationship Building'],
    cues: [
      // Ownership phrases only. A bare stakeholder mention is masked upstream,
      // because "work with stakeholders" names who you sit near, not what you
      // are accountable for.
      /\bstakeholder (management|engagement)\b/i,
      /\bmanag(e|ing) (senior |executive |multiple |competing )?stakeholders?\b/i,
      /\binfluenc(e|ing) (without authority|senior|at all levels|decision[- ]makers)\b/i,
      /\b(executive (communication|presence|reporting)|board[- ]level|c[- ]suite (engagement|reporting))\b/i,
      // "Present recommendations to client executives", "Report to the
      // programme board and to the regional mayor's office" — the audience is
      // rarely the word straight after "to".
      /\b(present|report|communicat)(ing|ed|s)? (\w+ ){0,3}to (the |our |a )?(\w+ ){0,2}(senior|executive|leadership|board|c[- ]suite|minister|mayor|regulator|partner)/i,
      /\bto (senior|executive|client) (stakeholders?|executives?|sponsors?)\b/i,
    ],
    domains: [],
  },
  {
    name: 'Negotiation',
    category: 'behavioral',
    definition: 'Reaches an agreement both sides will actually honour.',
    indicators: ['Describes a walk-away they held', 'Explains what the other side needed', 'Names a concession that bought something'],
    aliases: ['Commercial Negotiation', 'Deal Negotiation'],
    cues: [
      /\bnegotiat(e|ing|ion|ions)\b/i,
      /\b(commercial terms|deal structur|pricing discussions|conflict resolution)\b/i,
    ],
    domains: ['sales', 'legal', 'supply_chain', 'strategy', 'bfsi'],
  },
  {
    name: 'Commercial Acumen',
    category: 'behavioral',
    definition: 'Understands how the business makes money and lets that shape the work.',
    indicators: ['Connects their work to a number the business cares about', 'Explains a cost they chose to incur', 'Reasons about customers, not features'],
    aliases: ['Business Acumen', 'Commercial Awareness'],
    cues: [
      /\b(commercial (acumen|awareness|judgement)|business acumen|revenue (impact|growth)|\bp&l\b (responsibility|ownership)|cost consciousness)\b/i,
      /\b(understand(ing)? (the|our) business model|margin|roi\b|budget (ownership|responsibility) of)\b/i,
    ],
    domains: [],
  },
  {
    name: 'Working Under Ambiguity',
    category: 'situational',
    definition: 'Makes progress before the problem is fully defined, and says what is still unknown.',
    indicators: ['Describes starting without a spec', 'Explains a decision they revisited', 'Names what they deliberately left undecided'],
    aliases: ['Ambiguity', 'Adaptability', 'Dealing with Uncertainty', 'Comfort with Ambiguity'],
    cues: [
      /\b(ambiguity|ambiguous|undefined (problems|requirements)|fast[- ]paced|rapidly changing|evolving (priorities|requirements))\b/i,
      /\b(comfortable with (uncertainty|ambiguity)|adapt(able|ability) to change|wear(ing)? many hats|start[- ]?up environment)\b/i,
    ],
    domains: [],
  },
  {
    name: 'Prioritisation & Judgement',
    category: 'situational',
    definition: 'Chooses what not to do, under real constraints, and can defend the choice.',
    indicators: ['Names something important they dropped', 'Explains the constraint that forced the call', 'Describes a priority they got wrong'],
    aliases: ['Prioritization', 'Time Management', 'Workload Management'],
    cues: [
      // "Manage competing workstream deadlines" — one inserted noun defeated
      // a cue that demanded the pair be adjacent.
      /\b(prioritis(e|ing|ation)|prioritiz(e|ing|ation)|competing\s+(\w+\s+){0,2}(priorities|demands|deadlines|workstreams?)|manag(e|ing) multiple)\b/i,
      /\b(tight deadlines|time management|workload management|triag(e|ing) (requests|work))\b/i,
    ],
    domains: [],
  },
  {
    name: 'Crisis & Incident Handling',
    category: 'situational',
    definition: 'Keeps a clear head when something is actively going wrong.',
    indicators: ['Walks through an incident minute by minute', 'Explains what they stopped doing', 'Describes what they told people and when'],
    aliases: ['Crisis Management', 'Incident Handling', 'Emergency Response'],
    cues: [
      /\b(crisis management|emergency response|business continuity|major incident|escalation management|out[- ]of[- ]hours)\b/i,
      /\b(work(ing)? under pressure|high[- ]pressure (environment|situations))\b/i,
    ],
    domains: [],
  },
];
