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
import { detectInjection } from '../src/engines/policyEngine.js';
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
  /**
   * A request to speak to a person that was answered with another question.
   * The worst thing in the simulated-interview report, and the mechanical
   * audit called every one of those runs clean.
   */
  ignoredHumanRequests: string[];
  /**
   * A "say that again" whose reply neither put the question again nor stayed
   * on its subject — the topic was simply abandoned, and the plea was then
   * quoted to the reviewer as the candidate's evidence for the competency.
   */
  abandonedRepeats: string[];
  /**
   * One question template used twice in an interview with only the competency
   * name changed. `repeatedTopics` cannot see these: the two read as different
   * topics precisely because the swapped name is the only difference.
   */
  reusedTemplates: string[];
  /**
   * An acknowledgement that names something the INTERVIEWER introduced — the
   * role title, the company, a competency label — as though the candidate had
   * just told us about it.
   */
  echoedOurOwnWords: string[];
  /** A question the candidate asked at the close that the sign-off did not answer. */
  unansweredClosingQuestions: string[];
  /** A turn that tried to instruct the interviewer and was not flagged as one. */
  unflaggedInjections: string[];
}

/** Agent turns that put a new question to the candidate. */
const ASKING_KINDS: readonly string[] = ['question', 'followup', 'transition', 'work_sample'];

/**
 * A question's TEMPLATE: its wording with the variable parts removed.
 *
 * Competency names are what the bank substitutes in, and they are exactly what
 * makes two renderings of one template look like two questions. The run of
 * words immediately before "area" or "competency" is where the bank puts one,
 * so it collapses to <name> along with quoted fragments and digits, and
 * "Something in your SQL & Data Warehousing area worked yesterday…" and
 * "Something in your Data Engineering & Pipelines area worked yesterday…"
 * become the same sentence.
 *
 * "work" is deliberately NOT one of the keywords: a question can legitimately
 * say "the hardest production incident work you owned", and collapsing seven
 * words before it would make unrelated questions look like one template.
 */
export function questionTemplate(text: string): string {
  return (text || '')
    .toLowerCase()
    // Proper nouns and competency labels, including the "A & B" shape.
    .replace(/\b(?:[a-z][\w-]*|&)(?:\s+(?:[a-z][\w-]*|&)){0,6}(?=\s+(?:area|competency)\b)/g, '<name>')
    .replace(/["'][^"']{2,60}["']/g, '<quote>')
    .replace(/\d+/g, '<n>')
    .replace(/[^a-z<>\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words shared with the template, as a share of the shorter one. */
function templateOverlap(a: string, b: string): number {
  const wa = new Set(a.split(' ').filter((w) => w.length > 3));
  const wb = new Set(b.split(' ').filter((w) => w.length > 3));
  const [small, large] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  if (small.size < 5) return 0;
  let shared = 0;
  for (const w of small) if (large.has(w)) shared += 1;
  return shared / small.size;
}

/** Above this, two questions are the same form with the subject swapped. */
const SAME_TEMPLATE = 0.75;

/**
 * Above this, a reply is still about the question that was just asked.
 *
 * Deliberately high. A handful of shared function words ("when", "have",
 * "you") is what one interview question has in common with every other one,
 * and reading that as "stayed on topic" is how a transcript where the
 * clarification plea was answered by moving to the next competency reported
 * clean.
 */
const STAYED_ON_TOPIC = 0.5;

/** Acknowledgement openings the built-in writer uses, and the phrase each names. */
const ACK_NAMES = [
  /^thanks — that'?s useful context on (.+?)\./i,
  /^okay, that helps me picture (.+?)\./i,
  /^thanks for the detail on (.+?)\./i,
  /^got it — (.+?), understood\./i,
];

/**
 * The production failures, checked mechanically on a transcript.
 *
 * Everything here is deterministic and free. That is the point: the simulated
 * interviews that found these defects cost two shared model subscriptions and
 * two hours a run, and this function looks at the same transcripts in
 * milliseconds. It reported CLEAN on the run where five requests for a person
 * were talked over — which is what these checks are for.
 *
 * @param context names the interviewer introduced itself (role title, company,
 *   competency labels). An acknowledgement built on one of these is echoing us
 *   back to ourselves; without the list that check is simply skipped.
 */
export function auditScriptedTranscript(lines: readonly ScriptedLine[], context: readonly string[] = []): ScriptedAudit {
  const seen = new Map<string, number>();
  const followedUpNonAnswers: string[] = [];
  const ignoredHumanRequests: string[] = [];
  const abandonedRepeats: string[] = [];
  const reusedTemplates: string[] = [];
  const echoedOurOwnWords: string[] = [];
  const unansweredClosingQuestions: string[] = [];
  const unflaggedInjections: string[] = [];
  const templates: string[] = [];
  let askedAfterEnding = false;
  let ended = false;

  lines.forEach((line, i) => {
    if (line.speaker === 'candidate') {
      const intent = detectCandidateIntent(line.text).intent;
      if (intent === 'stop' || intent === 'postpone' || intent === 'human_request') ended = true;
      const reply = lines[i + 1];
      if (intent === 'non_answer' && reply?.kind === 'followup') followedUpNonAnswers.push(line.text);

      // 1. A request for a person, answered with another question. The reply
      //    must END the interview — anything that asks something is the failure.
      if (intent === 'human_request' && reply?.speaker === 'interviewer' && ASKING_KINDS.includes(reply.kind ?? '')) {
        ignoredHumanRequests.push(line.text);
      }

      // 2. A "say it again" whose reply neither re-asked nor stayed on topic.
      if (intent === 'repeat' && reply?.speaker === 'interviewer') {
        const putAgain = ['reask', 'rephrase', 'clarify'].includes(reply.kind ?? '');
        const question = [...lines.slice(0, i)].reverse().find((l) => l.speaker === 'interviewer' && ASKING_KINDS.includes(l.kind ?? ''));
        const onTopic = !!question && templateOverlap(questionTemplate(question.text), questionTemplate(reply.text)) >= STAYED_ON_TOPIC;
        if (!putAgain && !onTopic) abandonedRepeats.push(line.text);
      }

      // 3. Prompt injection that reached the record unflagged. The transcript
      //    carries no meta, so this reports what a flag SHOULD exist for.
      if (detectInjection(line.text).injection) unflaggedInjections.push(line.text.slice(0, 120));

      // 4. A question asked at the close and never answered.
      const closeBefore = [...lines.slice(0, i)].reverse().find((l) => l.speaker === 'interviewer');
      if (closeBefore?.kind === 'close' && line.text.includes('?') && reply?.kind === 'signoff') {
        const answered = reply.text.replace(/Thank you — that'?s everything from my side[\s\S]*$/i, '').trim();
        if (!answered) unansweredClosingQuestions.push(line.text);
      }
      return;
    }

    const asking = ASKING_KINDS.includes(line.kind ?? '');
    if (ended && asking) askedAfterEnding = true;
    // Only new questions: a re-ask of the same question is not a repeated topic.
    if (asking) {
      for (const t of topicsOf(line.text)) seen.set(t, (seen.get(t) ?? 0) + 1);
      // 5. One template, used twice with the subject swapped.
      const template = questionTemplate(line.text);
      if (templates.some((prior) => templateOverlap(prior, template) >= SAME_TEMPLATE)) reusedTemplates.push(line.text.slice(0, 120));
      templates.push(template);
    }

    // 6. An acknowledgement that names something we introduced.
    for (const re of ACK_NAMES) {
      const m = re.exec(line.text.trim());
      if (!m) continue;
      const named = m[1].trim().toLowerCase();
      if (context.some((c) => { const t = c.trim().toLowerCase(); return !!t && (t === named || t.includes(named) || named.includes(t)); })) {
        echoedOurOwnWords.push(m[1].trim());
      }
    }
  });

  return {
    askedAfterEnding,
    repeatedTopics: [...seen].filter(([, count]) => count > 1).map(([topic]) => topic),
    followedUpNonAnswers,
    ignoredHumanRequests,
    abandonedRepeats,
    reusedTemplates,
    echoedOurOwnWords,
    unansweredClosingQuestions,
    unflaggedInjections,
  };
}
