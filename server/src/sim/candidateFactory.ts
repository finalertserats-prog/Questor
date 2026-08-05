/**
 * Candidate generator — the agent that invents who turns up to the interview.
 *
 * A candidate is two things: a resume (what the engine plans against) and a
 * persona brief (how the peer AI playing them answers). Keeping those separate
 * is the point. Real weak candidates rarely have weak resumes — they have decent
 * resumes and thin answers, and that gap is exactly what a first-round interview
 * exists to find. So strength lives mostly in the brief, not the CV.
 */
import { nanoid } from 'nanoid';
import { bandById, type BandId } from '../engines/experienceBands.js';
import { callPeerJson, type PeerId } from './peers.js';
import type { RoleSpec } from './roleFactory.js';

export const CANDIDATE_STRENGTHS = ['strong', 'borderline', 'weak'] as const;
export type CandidateStrength = (typeof CANDIDATE_STRENGTHS)[number];

export interface CandidateSpec {
  id: string;
  fullName: string;
  email: string;
  band: BandId;
  strength: CandidateStrength;
  totalYears: number;
  resumeText: string;
  /** Instructions to the peer AI playing this candidate. */
  personaBrief: string;
  generatedBy: PeerId | 'template';
}

/** Years placed inside a band. The open-ended top band needs a concrete figure. */
export function midBandYears(band: BandId): number {
  const { min, max } = bandById(band).yearsPrior;
  if (!Number.isFinite(max)) return min + 4;
  return Math.floor((min + max) / 2);
}

// Invented names, deliberately varied and deliberately not mapped to band or
// strength — a fixture set where the senior candidates all share a name shape
// would quietly teach the harness something we do not want it to learn.
const NAMES = [
  'Avery Lin', 'Rowan Patel', 'Jordan Okafor', 'Sam Ferreira',
  'Riley Nakamura', 'Casey Alvarez', 'Devon Kaur', 'Emerson Bello',
  'Harper Singh', 'Quinn Adeyemi', 'Sasha Moreau', 'Toby Iyer',
];

function stableIndex(seed: string, modulo: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % modulo;
}

function emailFor(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`;
}

/**
 * Resume bullets per band.
 *
 * Written to band back to their own band through `inferBand`, which means each
 * set must stay inside its own abstraction: nothing at craft level may claim a
 * system, nothing at system level may claim the organisation. The round-trip
 * test enforces it, because a fixture that mis-bands makes every later
 * measurement ambiguous.
 */
const RESUME_BULLETS: Record<BandId, string[]> = {
  emerging: [
    'Implemented well-specified features against agreed acceptance criteria.',
    'Wrote unit tests and fixed defects raised in review.',
    'Picked up the team\'s tooling and conventions during first months in role.',
  ],
  developing: [
    'Delivered a customer-facing feature end to end, from unclear requirements to production.',
    'Diagnosed a recurring production problem and shipped the fix.',
    'Reviewed peers\' work and coordinated with the neighbouring group on shared interfaces.',
  ],
  established: [
    'Owned the reporting pipeline, including its failure modes, alerting and recovery.',
    'Designed the data contracts that downstream consumers build against.',
    'Carried on-call for the service and drove the follow-up fixes after incidents.',
  ],
  senior: [
    'Architected the ingestion platform now used by several neighbouring groups.',
    'Mentored 4 engineers and set the technical direction for the area.',
    'Made the migration call that traded short-term delivery for long-term maintainability.',
  ],
  principal: [
    'Set architecture across four teams and the standards they build against.',
    'Owned the platform budget of 2M and the build-versus-buy decisions within it.',
    'Ran a multi-team replatforming programme spanning eighteen months.',
  ],
  executive: [
    'Owned the P&L and headcount for a group of eighty people.',
    'Presented the technology strategy and its risks to the board.',
    'Allocated the portfolio budget across competing long-horizon bets.',
  ],
};

/** Achievement line, varied by strength but never by claimed scope. */
const ACHIEVEMENT: Record<CandidateStrength, string> = {
  strong: 'Measured outcome: cut processing time from 90 minutes to 8 and cost by 35%.',
  borderline: 'Outcome: things ran more smoothly afterwards, though the numbers were not tracked closely.',
  weak: 'Contributed to a number of initiatives during this period.',
};

const PERSONA_BRIEF: Record<CandidateStrength, string> = {
  strong: [
    'You answer like someone who genuinely did the work. Give a specific situation, say exactly what YOU did as',
    'distinct from the team, name the trade-off you weighed, and give a real number for the outcome. Volunteer the',
    'thing that went wrong and what you changed afterwards. Stay strictly inside the scope your resume claims —',
    'never invent seniority you do not have. Answer in 4-8 sentences, in natural spoken English.',
  ].join(' '),
  borderline: [
    'You did the work but explain it unevenly. Start general, and only get specific when pushed — the detail is there',
    'if the interviewer digs for it. Sometimes describe what "we" did rather than what you did, and be vague about',
    'measurement unless asked directly. You are neither hiding anything nor volunteering much. Answer in 3-6',
    'sentences, in natural spoken English.',
  ].join(' '),
  weak: [
    'Your resume is better than your recall. Answer in generalities, describe how things are normally done rather',
    'than what you specifically did, and rarely produce a number or a named example even when pushed. Do not lie or',
    'invent detail — deflect to process instead ("it depends on the requirements", "the team handled that").',
    'Never become hostile or ask to end the interview. Answer in 2-5 sentences, in natural spoken English.',
  ].join(' '),
};

/** Deterministic candidate. The fixture the harness can be tested against. */
export function templateCandidate(opts: {
  role: RoleSpec;
  band: BandId;
  strength: CandidateStrength;
}): CandidateSpec {
  const { role, band, strength } = opts;
  const bandDef = bandById(band);
  const totalYears = midBandYears(band);
  const fullName = NAMES[stableIndex(`${role.title}:${band}:${strength}`, NAMES.length)];
  const startYear = 2026 - totalYears;

  const resumeText = [
    fullName,
    `${role.title.replace(/^(Junior|Senior|Lead|Principal|Director of) ?/, '')} | Remote`,
    emailFor(fullName),
    '',
    'Experience:',
    `${role.title}, Previous Employer (${startYear} - Present)`,
    ...RESUME_BULLETS[band].map((b) => `- ${b}`),
    `- ${ACHIEVEMENT[strength]}`,
    '',
    'Education:',
    `B.Sc. relevant discipline (${startYear})`,
    '',
    `Skills: ${role.jdText.match(/Must have:\n- ([^\n]+)/)?.[1] ?? 'role-relevant tooling'}`,
  ].join('\n');

  const personaBrief = [
    `You are ${fullName}, interviewing for ${role.title} at ${role.organisation}.`,
    `You have about ${totalYears} years of experience — ${bandDef.label}, working at the ${bandDef.abstraction} level.`,
    PERSONA_BRIEF[strength],
    'Never break character, never mention that you are an AI, and never comment on the interview itself.',
  ].join(' ');

  return {
    id: nanoid(8),
    fullName,
    email: emailFor(fullName),
    band,
    strength,
    totalYears,
    resumeText,
    personaBrief,
    generatedBy: 'template',
  };
}

/** Shape check for a peer-generated candidate. */
export function validateCandidateSpec(raw: unknown): {
  fullName: string;
  resumeText: string;
  personaBrief: string;
  totalYears: number;
} {
  const r = raw as { fullName?: unknown; resumeText?: unknown; personaBrief?: unknown; totalYears?: unknown };
  if (typeof r?.fullName !== 'string' || r.fullName.trim().length < 2) throw new Error('fullName missing');
  if (typeof r?.resumeText !== 'string' || r.resumeText.trim().length < 150) throw new Error('resumeText missing or too short');
  if (typeof r?.personaBrief !== 'string' || r.personaBrief.trim().length < 80) throw new Error('personaBrief missing or too short');
  const years = Number(r?.totalYears);
  if (!Number.isFinite(years) || years < 0 || years > 50) throw new Error('totalYears missing or implausible');
  return {
    fullName: r.fullName.trim().slice(0, 80),
    resumeText: r.resumeText.trim().slice(0, 8000),
    personaBrief: r.personaBrief.trim().slice(0, 3000),
    totalYears: Math.round(years),
  };
}

/** Ask a peer to invent a candidate for a role, at a target band and strength. */
export async function generateCandidate(opts: {
  role: RoleSpec;
  band: BandId;
  strength: CandidateStrength;
  peer: PeerId;
}): Promise<CandidateSpec> {
  const { role, band, strength, peer } = opts;
  const bandDef = bandById(band);
  const years = midBandYears(band);

  const strengthGuidance: Record<CandidateStrength, string> = {
    strong: 'This candidate genuinely did the work and can evidence it with specifics and numbers.',
    borderline: 'This candidate did the work but explains it unevenly — the detail only emerges when pushed.',
    weak: 'This candidate\'s resume overstates their recall. They answer in generalities and rarely produce specifics. They must never lie outright, and must never become hostile or ask to end the interview.',
  };

  const prompt = [
    'You are generating a synthetic candidate for an interview simulation. The candidate is fictional; use an invented name and an @example.com address.',
    '',
    `Role applied for: ${role.title} at ${role.organisation}`,
    `Job description:\n${role.jdText.slice(0, 2500)}`,
    '',
    `Target experience level: ${bandDef.label} — roughly ${years} years, working at the ${bandDef.abstraction} level.`,
    `Answering strength: ${strength}. ${strengthGuidance[strength]}`,
    '',
    'The resume must:',
    `- claim scope appropriate to ${bandDef.label} and NOT beyond it`,
    `- avoid claiming any of: ${bandDef.avoid.join('; ')}`,
    '- read like a real CV: employer, dates, 3-5 bullets per role, education, skills',
    '- contain no protected-characteristic information (no age, marital status, religion, nationality or photo)',
    '',
    'The personaBrief is a second-person instruction to whoever plays this candidate in the interview. It must describe HOW they answer (specificity, length, what they volunteer, what they deflect) and instruct them to stay in character and never end the interview early.',
    '',
    'Return: {"fullName": "...", "totalYears": <number>, "resumeText": "...", "personaBrief": "..."}',
  ].join('\n');

  const out = await callPeerJson(peer, prompt, {
    validate: validateCandidateSpec,
    label: `generateCandidate(${role.title}/${band}/${strength})`,
  });

  return {
    id: nanoid(8),
    fullName: out.fullName,
    email: emailFor(out.fullName),
    band,
    strength,
    totalYears: out.totalYears,
    resumeText: out.resumeText,
    personaBrief: out.personaBrief,
    generatedBy: peer,
  };
}
