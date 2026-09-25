/**
 * The guided demo's beats: one hiring story told over the real application,
 * one card at a time. The visitor reads each and presses Next.
 *
 * A beat names the screen it is shown over (a route with the sandbox's own
 * ids filled in from GET /demo/status), the element it spotlights (a
 * `data-tour` anchor — the same mechanism as the product tour, and a web test
 * fails when one leaves the markup), and what the card says about it. The
 * lines are written to be read, not heard: what a thing is and why Questor
 * is built that way, in a sentence or two.
 */

export interface DemoBeat {
  readonly id: string;
  readonly title: string;
  /** Route template; {roleId}, {candidateId}, {sessionId}, {assessmentId}, {orgSlug} come from the status. */
  readonly route: string;
  /** The `data-tour` anchor spotlit. Absent: a centred card carries the beat. */
  readonly anchor?: string;
  readonly body: string;
  /** Needs the seeded story's records (Priya's role, candidate, interview, assessment). */
  readonly needsStory?: boolean;
  /** Only when at least one way of sitting the interview is on offer. */
  readonly needsInterviewMode?: boolean;
  /** One of the two closing cards, whose buttons come from what the sandbox offers. */
  readonly closing?: 'explore' | 'interview';
}

/**
 * Ids are the beats' names, not their positions, so they do not close up when
 * one is cut — B02 and B17 are gone and the rest keep the labels the anchors,
 * the e2e walk and the script document already call them by.
 *
 * Those two were the only beats that left the product: the organisation's
 * sign-in page at step 2, and the account-request page at step 17. Both told
 * the truth about how Questor is entered, and both did it by throwing a
 * visitor who is already inside back out to a public page — the second of them
 * straight after watching a hire decided. A demo arrives by link and never
 * needs either door explained.
 */
export const DEMO_BEATS: readonly DemoBeat[] = [
  {
    id: 'B01', title: 'Welcome to Questor', route: '/',
    body: 'In the next few minutes you’ll follow one hire from beginning to end — a role, a candidate, an interview, the evidence, and a decision — over the real product, so what you see is what your team would see. Use Next and Back, or the arrow keys; Escape skips.',
  },
  {
    id: 'B03', title: 'Home', route: '/?tab=home', anchor: 'home-needs-you',
    body: 'A hiring manager’s day starts here: what needs you, most urgent first; then what’s coming up; then what’s done. Near the top right now — an interview waiting for a person to review it.',
  },
  {
    id: 'B04', title: 'The Dashboard tab', route: '/?tab=dashboard', anchor: 'landing-tab-dashboard',
    body: 'Beside Home sits the Dashboard: the same work, as numbers.',
  },
  {
    id: 'B05', title: 'Key metrics', route: '/?tab=dashboard', anchor: 'kpis',
    body: 'Open roles, candidates, who’s in the pipeline, what’s scheduled this week, what’s waiting for review. Every tile is a link to the list behind it — a number you can’t open is a number you can’t check.',
  },
  {
    id: 'B06', title: 'The four steps', route: '/?tab=dashboard', anchor: 'workflow',
    body: 'The whole of Questor is four steps: a role, a candidate, an interview, an assessment. The tour takes them in order.',
  },
  {
    id: 'B07', title: 'The role', route: '/roles/{roleId}', anchor: 'role-scorecard-status', needsStory: true,
    body: 'A role begins with its job description. Paste it in — this one is a Senior Data Engineer, in Bengaluru — and Questor drafts the scorecard: the competencies every interview for this role is measured against.',
  },
  {
    id: 'B08', title: 'The scorecard', route: '/roles/{roleId}', anchor: 'role-competencies', needsStory: true,
    body: 'Each competency carries a weight and a required level. A person approves the scorecard before anyone is interviewed, so every candidate is judged by the same instrument.',
  },
  {
    id: 'B09', title: 'The candidate', route: '/candidates/{candidateId}?tab=profile', anchor: 'candidate-fit', needsStory: true,
    body: 'Priya Sharma has applied. Her CV is read against the scorecard, line by line: where it points at a competency, and where it’s silent. That is what the CV says; what Priya can do comes from the interview.',
  },
  {
    id: 'B10', title: 'The path', route: '/candidates/{candidateId}?tab=journey', anchor: 'candidate-pipeline', needsStory: true,
    body: 'Every candidate walks the same path: Participation; Bronze, the profile review; Silver, the AI interview; Gold, the human rounds, where the AI only listens and transcribes; Diamond, decided. Questor moves her forward on its own. The call that matters, it leaves to a person.',
  },
  {
    id: 'B11', title: 'Setting up the interview', route: '/candidates/{candidateId}?tab=journey', anchor: 'candidate-setup-interview', needsStory: true,
    body: 'How long, what gets asked, and which of Questor’s five interviewers — Avery, Maya, Adrian, Elena or Theo — runs it; they differ in name and voice, nothing else. The candidate gets a link and a plain statement that they’ll be talking to an AI, and nothing begins until they’ve agreed.',
  },
  {
    id: 'B12', title: 'The interview', route: '/interviews/{sessionId}', anchor: 'interview-transcript', needsStory: true,
    body: 'Priya’s interview with Maya, as it happened: Maya asked, Priya answered, and where an answer was thin, Maya asked again. Every turn is kept with its time, because in Questor a claim without a quote is not evidence.',
  },
  {
    id: 'B13', title: 'What the AI found', route: '/assessments/{assessmentId}', anchor: 'assessment-ai', needsStory: true,
    body: 'For each competency: the level the AI found, and the quote from the transcript, with its timestamp, that supports it. Where there wasn’t enough evidence it says so rather than guessing. Strengths, concerns and the questions it couldn’t settle are listed just as plainly.',
  },
  {
    id: 'B14', title: 'What the reviewer decides', route: '/assessments/{assessmentId}', anchor: 'assessment-review', needsStory: true,
    body: 'A person reads the transcript — Questor checks that they have — and records their own verdict: proceed, consider, or do not progress. Where an organisation reviews blind, the AI’s recommendation stays out of sight until the reviewer has written theirs. The machine assesses. A person judges.',
  },
  {
    id: 'B15', title: 'Where they differ', route: '/assessments/{assessmentId}', anchor: 'assessment-differences', needsStory: true,
    body: 'Where the two differ, both readings sit side by side, with no commentary from either. Over a season of hiring, that’s how a team learns where the machine can be trusted — and where it can’t.',
  },
  {
    id: 'B16', title: 'The decision', route: '/assessments/{assessmentId}', anchor: 'assessment-verdict', needsStory: true,
    body: 'A verdict moves Priya on: to the human rounds, or to a decision with a feedback letter drafted for her — because a candidate who gave you half an hour deserves more than silence.',
  },
  {
    id: 'B18', title: 'Yours to explore', route: '/?tab=home', closing: 'explore',
    body: 'That’s the story. Now Questor is yours: open anything, or paste a job description of your own under New role and watch Questor draft its scorecard.',
  },
  {
    id: 'B19', title: 'The interview itself', route: '/?tab=home', closing: 'interview', needsInterviewMode: true,
    body: 'Sit in on an interview with one of our interviewers, about the role you’ve just seen. It’s a demo, so it’s short — about fifteen minutes — and it ends the way a real first round ends. Choose when you’re ready.',
  },
];
