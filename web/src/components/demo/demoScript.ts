/**
 * The guided demo's beats: one hiring story told over the real application.
 *
 * This file is the single source of the narration. The caption shown on the
 * player IS the line as recorded (docs/demo/demo-script.md), and the audio
 * files under /demo/narration are generated from these strings, so the two
 * cannot drift. Change a word here and the beat needs re-recording.
 *
 * A beat names the screen it plays over (a route with the sandbox's own ids
 * filled in from GET /demo/status), the element it spotlights (a `data-tour`
 * anchor, the same mechanism as the product tour), and how long it runs when
 * no audio is present.
 */

export type DemoCard = 'welcome' | 'explore' | 'interview';

export interface DemoBeat {
  readonly id: string;
  readonly title: string;
  /** Route template; {roleId}, {candidateId}, {sessionId}, {assessmentId}, {orgSlug} come from the status. */
  readonly route: string;
  /** The `data-tour` anchor spotlit. Absent: a centred card carries the beat. */
  readonly anchor?: string;
  readonly card?: DemoCard;
  /** Spoken and shown, verbatim. */
  readonly caption: string;
  /** Speech at ~150 wpm; the beat runs this long when the audio file is absent. */
  readonly seconds: number;
  /** Needs the seeded story's records (Priya's role, candidate, interview, assessment). */
  readonly needsStory?: boolean;
  /** Only when at least one way of sitting the interview is on offer. */
  readonly needsInterviewMode?: boolean;
}

export const DEMO_BEATS: readonly DemoBeat[] = [
  {
    id: 'B01', title: 'Welcome', route: '/', card: 'welcome', seconds: 18,
    caption: 'Welcome to Questor. In the next five minutes you’ll follow one hire from beginning to end: a role, a candidate, an interview, the evidence, and a decision. The real product moves behind these words, so what you see is what your team would see.',
  },
  {
    id: 'B02', title: 'The door', route: '/o/{orgSlug}?tour=door', anchor: 'org-signin', seconds: 15,
    caption: 'First, where you are. Every organisation on Questor has its own sign-in page at its own address — this one is your sandbox’s. Your demo link brought you past it; your team would come in through it each morning.',
  },
  {
    id: 'B03', title: 'Home', route: '/?tab=home', anchor: 'home-needs-you', seconds: 14,
    caption: 'Home is where a hiring manager’s day starts: what needs you, most urgent first; then what’s coming up; then what’s done. Near the top right now — an interview waiting for a person to review it.',
  },
  {
    id: 'B04', title: 'The Dashboard tab', route: '/?tab=dashboard', anchor: 'landing-tab-dashboard', seconds: 4,
    caption: 'Beside Home sits the Dashboard: the same work, as numbers.',
  },
  {
    id: 'B05', title: 'Key metrics', route: '/?tab=dashboard', anchor: 'kpis', seconds: 14,
    caption: 'Open roles, candidates, who’s in the pipeline, what’s scheduled this week, what’s waiting for review. Every tile is a link to the list behind it — a number you can’t open is a number you can’t check.',
  },
  {
    id: 'B06', title: 'The four steps', route: '/?tab=dashboard', anchor: 'workflow', seconds: 8,
    caption: 'And the whole of Questor is four steps: a role, a candidate, an interview, an assessment. Let’s take them in order.',
  },
  {
    id: 'B07', title: 'The role', route: '/roles/{roleId}', anchor: 'role-scorecard-status', seconds: 14, needsStory: true,
    caption: 'A role begins with its job description. Paste it in — this one is a Senior Data Engineer, in Bengaluru — and Questor drafts the scorecard: the competencies every interview for this role will be measured against.',
  },
  {
    id: 'B08', title: 'The scorecard', route: '/roles/{roleId}', anchor: 'role-competencies', seconds: 19, needsStory: true,
    caption: 'For this role: SQL and data warehousing, pipelines, cloud architecture, data modelling, reliability — and the human ones: communication, problem solving, collaboration, ownership. Each carries a weight and a required level. A person approves the scorecard before anyone is interviewed, so every candidate is judged by the same instrument.',
  },
  {
    id: 'B09', title: 'The candidate', route: '/candidates/{candidateId}?tab=profile', anchor: 'candidate-fit', seconds: 16, needsStory: true,
    caption: 'Priya Sharma has applied. Her CV is read against the scorecard, line by line: where it points at a competency, and where it’s silent. This is what the CV says. It says nothing yet about Priya — that comes from the interview.',
  },
  {
    id: 'B10', title: 'The path', route: '/candidates/{candidateId}?tab=journey', anchor: 'candidate-pipeline', seconds: 19, needsStory: true,
    caption: 'Her journey tab shows the path every candidate walks: Participation; Bronze, the profile review; Silver, the AI interview; Gold, the human rounds, where the AI only listens and transcribes; and Diamond, decided. Questor moves her forward on its own. The call that matters, it leaves to a person.',
  },
  {
    id: 'B11', title: 'Setting up the interview', route: '/candidates/{candidateId}?tab=journey', anchor: 'candidate-setup-interview', seconds: 22, needsStory: true,
    caption: 'Here an interview is set up: how long, what gets asked, and which of Questor’s five interviewers — Avery, Maya, Adrian, Elena or Theo — runs it. They differ in name and voice, nothing else. The candidate gets a link, a plain statement that they’ll be talking to an AI, and nothing begins until they’ve agreed.',
  },
  {
    id: 'B12', title: 'The interview', route: '/interviews/{sessionId}', anchor: 'interview-transcript', seconds: 16, needsStory: true,
    caption: 'This is Priya’s interview with Maya, as it happened. Maya asked; Priya answered; where an answer was thin, Maya asked again. Every turn is kept with its time, because in Questor a claim without a quote is not evidence.',
  },
  {
    id: 'B13', title: 'What the AI found', route: '/assessments/{assessmentId}', anchor: 'assessment-ai', seconds: 19, needsStory: true,
    caption: 'After the interview, the assessment. For each competency: the level the AI found, and the quote from the transcript, with its timestamp, that supports it. Where there wasn’t enough evidence it says so, rather than guessing. Strengths, concerns, and the questions it couldn’t settle are listed just as plainly.',
  },
  {
    id: 'B14', title: 'What the reviewer decides', route: '/assessments/{assessmentId}', anchor: 'assessment-review', seconds: 22, needsStory: true,
    caption: 'Then the part that makes Questor what it is. A person reads the transcript — Questor checks that they have — and records their own verdict: proceed, consider, or do not progress. Where an organisation reviews blind, the AI’s recommendation stays out of sight until the reviewer has written theirs. The machine assesses. A person judges.',
  },
  {
    id: 'B15', title: 'Where they differ', route: '/assessments/{assessmentId}', anchor: 'assessment-differences', seconds: 14, needsStory: true,
    caption: 'And where the two differ, both readings sit side by side, with no commentary from either. Over a season of hiring, that’s how a team learns where the machine can be trusted — and where it can’t.',
  },
  {
    id: 'B16', title: 'The decision', route: '/assessments/{assessmentId}', anchor: 'assessment-verdict', seconds: 16, needsStory: true,
    caption: 'This is where the decision is recorded. A verdict moves Priya on: to the human rounds, or to a decision with a feedback letter drafted for her — because a candidate who gave you half an hour deserves more than silence.',
  },
  {
    id: 'B17', title: 'Asking to be let in', route: '/signup', anchor: 'signup-modes', seconds: 18,
    caption: 'When you want in for real — nobody opens an account by themselves. A new organisation starts here; a person asks to join theirs here. Each request goes to a human, who opens the door, or doesn’t. Slower than a sign-up button. That’s the point.',
  },
  {
    id: 'B18', title: 'Yours to explore', route: '/?tab=home', card: 'explore', seconds: 17,
    caption: 'That’s the story. Now Questor is yours. Open anything — or better, paste a job description of your own and watch Questor draft its scorecard. Everything here is sample data in a sandbox that’s deleted afterwards; nothing you do can reach a real customer.',
  },
  {
    id: 'B19', title: 'The interview itself', route: '/?tab=home', card: 'interview', seconds: 18, needsInterviewMode: true,
    caption: 'And the best part: the interview itself. Sit in on one, with one of our interviewers, about the role you’ve just seen. It’s a demo, so it’s short — about fifteen minutes — and it ends the way a real first round ends. Choose when you’re ready.',
  },
];

/** Where the pre-recorded narration lives; a beat with no file runs on its caption. */
export const NARRATION_MANIFEST_URL = '/demo/narration/manifest.json';
export const narrationUrl = (beatId: string) => `/demo/narration/${beatId}.mp3`;
