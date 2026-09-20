/**
 * Scripted sessions — the real engine, a scripted candidate.
 *
 * Lanes A and B let a peer AI play the candidate, which is what gives a sweep
 * its variety and also what makes it useless for pinning a regression: the
 * peer never says "Stop", "Oh" or "Welcome back". These scripts replay, turn by
 * turn, the two production interviews that made the owner write "I literally
 * typed stop and still it did not work":
 *
 *  A — a candidate asked three times to do the interview later, typed "Stop",
 *      and was handed a work sample.
 *  B — a Project Manager (survey delivery) whose "Oh", "No", "Pause",
 *      "Nothing" and "Welcome back" were followed up as answers, who was asked
 *      build-versus-buy about five times, whose correction was ignored and
 *      whose closing question got a generic sign-off.
 *
 * `auditScriptedTranscript` is the deterministic judge for them: the things
 * that went wrong in production, checked mechanically.
 */
import { prisma } from '../src/db.js';
import type { RoleSuccessProfile } from '../src/domain/types.js';
import { buildInterviewPlan } from '../src/engines/interviewPlanner.js';
import type { BandId } from '../src/engines/experienceBands.js';
import { detectCandidateIntent } from '../src/engines/candidateIntent.js';
import { topicsOf } from '../src/engines/conversationModel.js';
import {
  endReasonFor, startInterview, submitCandidateTurn, withdrawInterview, type AgentTurnOut,
} from '../src/realtime/interviewEngine.js';
import { ensureSimTenant } from './session.js';

/** The scorecard of the Session B role, as production had it. */
export const PM_SURVEY_PROFILE: RoleSuccessProfile = {
  roleContext: 'Deliver online survey projects for research teams, on time and to specification.',
  outcomes: ['Survey projects delivered on schedule with clean data'],
  responsibilities: [
    'Manage end-to-end delivery of online survey projects',
    'Coordinate timelines with research managers and clients',
    'Oversee questionnaire programming and QA in Decipher and Qualtrics',
  ],
  competencies: [
    { id: 'c_pm', name: 'Project Management', definition: 'Plans and delivers survey projects on time with research managers and clients.', category: 'behavioral', classification: 'essential', weight: 0.4, requiredLevel: 3, targetLevel: 4, indicators: [], evidenceModes: [] },
    { id: 'c_prog', name: 'Survey Programming', definition: 'Scripts questionnaires, routing logic and quotas.', category: 'technical', classification: 'essential', weight: 0.3, requiredLevel: 3, targetLevel: 4, indicators: [], evidenceModes: [] },
    { id: 'c_tools', name: 'Technical Proficiency in Survey Tools', definition: 'Decipher, Qualtrics and similar platforms.', category: 'technical', classification: 'essential', weight: 0.3, requiredLevel: 3, targetLevel: 4, indicators: [], evidenceModes: [] },
  ],
  scoringRules: { mustPassCompetencyIds: [], notEnoughEvidencePolicy: 'exclude', passThreshold: 60 },
  policyRules: { prohibitedTopics: [], requiredDisclosures: [], accommodationsEnabled: true, jurisdiction: 'IN' },
  redFlags: [],
  seniority: 'Manager',
};

export const PM_SURVEY_TITLE = 'Project Manager - Survey Delivery';

/** Session A, in the candidate's own words. The first line should already end it. */
export const SESSION_A: readonly string[] = [
  'Now can we have this interview later',
  "I don't want",
  "I don't want to take the interview right now can you cancel it we can have it sometime later",
  'Stop',
];

/** Session A's last line on its own, after one real answer: typed "Stop" must end it on that turn. */
export const SESSION_A_STOP: readonly string[] = [
  'I manage survey delivery for three research teams and script most trackers myself.',
  'Stop',
];

/**
 * The same request in the words candidates more often use. Until these were
 * added to the patterns they were caught only by a model reading — and the
 * production account has no credits, so nothing caught them at all.
 */
export const SESSION_A_COME_BACK: readonly string[] = [
  'I manage survey delivery for three research teams and script most trackers myself.',
  'I can come back after exams',
];

/** A real answer, used where the script only needs the interview to move on. */
export const FILLER_ANSWER =
  'On that project I planned the timeline with the research manager, had the questionnaire scripted in Decipher, ran QA with two testers, and delivered two days early.';

/** Session B, turn by turn. Filler answers carry it to the close, then the closing question. */
export const SESSION_B: readonly string[] = [
  "I'm a project manager for survey delivery. I coordinate with research managers, and my team scripts the surveys in Decipher and Qualtrics.",
  'Oh',
  'No',
  'Pause',
  'ready',
  'I planned a 12-market tracker: I set the timeline with the research manager, got the questionnaire scripted in Decipher, and ran QA with two testers before launch.',
  'Nothing',
  'Welcome back',
  "I think you got it wrong, I didn't say that. The research manager decides on custom solutions, I just deliver them.",
  'For survey tools I mostly use Decipher for complex routing and Qualtrics for quick pulse surveys, and I pick based on the quota and routing needs.',
];

export const SESSION_B_CLOSING_QUESTION =
  "what exact role are you looking for, because a few questions asked about taking decisions on custom solutions, this is usually the research manager's call";

export interface ScriptedLine {
  speaker: 'interviewer' | 'candidate';
  text: string;
  kind?: string;
}

export interface ScriptedRun {
  sessionId: string;
  lines: ScriptedLine[];
  last: AgentTurnOut;
  state: string;
}

/** Provision a real session for this scorecard: role, approved scorecard, candidate, plan, consent. */
export async function createScriptedSession(opts: {
  profile?: RoleSuccessProfile;
  title?: string;
  candidateName?: string;
  durationMinutes?: number;
  band?: BandId;
}): Promise<string> {
  const { tenantId, userId } = await ensureSimTenant();
  const profile = opts.profile ?? PM_SURVEY_PROFILE;
  const durationMinutes = opts.durationMinutes ?? 30;
  const role = await prisma.role.create({
    data: {
      tenantId, title: opts.title ?? PM_SURVEY_TITLE, level: profile.seniority, location: '', employmentType: 'full_time',
      sourceType: 'paste', sourceText: profile.responsibilities.join('\n'), status: 'approved', createdById: userId,
    },
  });
  const scorecard = await prisma.roleScorecardVersion.create({
    data: { roleId: role.id, version: 1, status: 'approved', profileJson: JSON.stringify(profile), approvedById: userId, approvedAt: new Date() },
  });
  const candidate = await prisma.candidate.create({
    data: { tenantId, roleId: role.id, fullName: opts.candidateName ?? 'K JAYESH RAHUL', email: `scripted-${role.id}@example.com`, phone: '' },
  });
  // Pitched where production pitched Session B: "Manager" resolves to the
  // principal band, whose topics included architecture and build-versus-buy.
  const plan = buildInterviewPlan({ role: profile, durationMinutes, language: 'en', modules: [], band: opts.band ?? 'principal' });
  const session = await prisma.interviewSession.create({
    data: {
      tenantId, candidateId: candidate.id, roleId: role.id, scorecardId: scorecard.id,
      state: 'ACCEPTED', provider: 'hosted', language: 'en', durationMinutes,
      personaJson: JSON.stringify({ interviewerId: 'maya', name: 'Maya', tone: 'warm' }),
      consentJson: JSON.stringify({
        disclosureText: '', recordingRequested: false, recording: false, humanReviewRequired: true,
        consentVersion: 'v1', consentedAt: new Date().toISOString(), channel: 'simulation',
      }),
      recordingConsent: false,
    },
  });
  await prisma.interviewPlanVersion.create({ data: { sessionId: session.id, version: 1, planJson: JSON.stringify(plan) } });
  return session.id;
}

/** Virtual pacing, as Lane A uses, so the director's clock advances as it would live. */
const MS_PER_TURN = 45_000;

/**
 * Play the script against the real engine. Stops when the interviewer ends the
 * interview; an interview the candidate ended is closed unscored exactly as the
 * portal closes it. `untilClose` keeps answering with FILLER_ANSWER after the
 * script runs out until the interviewer invites questions, then asks
 * `closingQuestion`.
 */
export async function runScript(sessionId: string, script: readonly string[], opts: { untilClose?: boolean; closingQuestion?: string } = {}): Promise<ScriptedRun> {
  const lines: ScriptedLine[] = [];
  let agent = await startInterview(sessionId);
  lines.push({ speaker: 'interviewer', text: agent.text, kind: agent.kind });
  const queue = [...script];
  let n = 0;
  while (!agent.done && n < 60) {
    let said = queue.shift();
    if (said === undefined) {
      if (!opts.untilClose) break;
      said = agent.kind === 'close' ? (opts.closingQuestion ?? 'No, thank you.') : FILLER_ANSWER;
    }
    n += 1;
    lines.push({ speaker: 'candidate', text: said });
    agent = await submitCandidateTurn(sessionId, said, { startMs: n * MS_PER_TURN, endMs: n * MS_PER_TURN + 30_000, confidence: 0.92 });
    lines.push({ speaker: 'interviewer', text: agent.text, kind: agent.kind });
  }
  if (agent.withdrawn) await withdrawInterview(sessionId, endReasonFor(agent.kind));
  const session = await prisma.interviewSession.findUnique({ where: { id: sessionId }, select: { state: true } });
  return { sessionId, lines, last: agent, state: session?.state ?? '' };
}

export function renderScripted(lines: readonly ScriptedLine[]): string {
  return lines.map((l) => `${l.speaker === 'interviewer' ? `AI${l.kind ? ` [${l.kind}]` : ''}` : 'CAND'}: ${l.text}`).join('\n');
}

export interface ScriptedAudit {
  /** A question asked after the candidate asked to stop or postpone. */
  askedAfterEnding: boolean;
  /** Tracked topics (build-versus-buy, long-term consequences, …) asked more than once. */
  repeatedTopics: string[];
  /** Candidate non-answers ("Oh", "No", "Nothing") that were followed up as if answered. */
  followedUpNonAnswers: string[];
}

/** The production failures, checked mechanically on a transcript. */
export function auditScriptedTranscript(lines: readonly ScriptedLine[]): ScriptedAudit {
  const seen = new Map<string, number>();
  const followedUpNonAnswers: string[] = [];
  let askedAfterEnding = false;
  let ended = false;
  lines.forEach((line, i) => {
    if (line.speaker === 'candidate') {
      const intent = detectCandidateIntent(line.text).intent;
      if (intent === 'stop' || intent === 'postpone') ended = true;
      const reply = lines[i + 1];
      if (intent === 'non_answer' && reply?.kind === 'followup') followedUpNonAnswers.push(line.text);
      return;
    }
    const asking = ['question', 'followup', 'transition', 'work_sample'].includes(line.kind ?? '');
    if (ended && asking) askedAfterEnding = true;
    // Only new questions: a re-ask of the same question is not a repeated topic.
    if (asking) for (const t of topicsOf(line.text)) seen.set(t, (seen.get(t) ?? 0) + 1);
  });
  return {
    askedAfterEnding,
    repeatedTopics: [...seen].filter(([, count]) => count > 1).map(([topic]) => topic),
    followedUpNonAnswers,
  };
}
