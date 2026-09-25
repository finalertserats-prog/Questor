/**
 * The written interview a visitor watches in "Watch one happen".
 *
 * WHY THIS IS WRITTEN AND NOT GENERATED (owner, 2026-09-24).
 *
 * An observer is not answering anything, so there is nothing for a model to
 * react to: every word on both sides would be generated, at our cost, to show
 * a prospect a conversation nobody was having. Written, it costs nothing, it
 * is the same every time — so a fault in it is a fault we can fix rather than
 * one that appears for one prospect in ten — and it can simply be BETTER,
 * because it was edited rather than sampled.
 *
 * It is still a real interview in every way that a viewer can check: the turns
 * are real Turn rows on a real InterviewSession in the demo tenant, played at
 * the pace they would arrive live, and the assessment at the end is produced
 * by the product's own evaluator reading this transcript. Nothing about the
 * scoring is written here. That is the point of the thin answer below: if the
 * evidence for one competency is weak, the assessment has to say so, and a
 * prospect can check that it did.
 *
 * THE RAW MATERIAL is the simulation harness's persona set (`strong`, with the
 * interruption behaviour of `drop-rejoin` and the specificity both are written
 * for). It has been hand-finished: the wording, the pacing and the one thin
 * answer are chosen, not sampled.
 *
 * THE CANDIDATE IS FICTIONAL AND IS SAID TO BE. Nothing here is taken from a
 * real interview, a real person or a real customer.
 */

export const DEMO_SCRIPT_ID = 'observer-senior-data-engineer-v1';

/** The fictional candidate the script plays. Named as simulated, everywhere. */
export const DEMO_SCRIPT_CANDIDATE = {
  fullName: 'Ravi Menon (simulated candidate)',
  /** An address on a domain that cannot receive mail, so nothing can be sent to it. */
  email: 'simulated-candidate@demo.questor.invalid',
} as const;

/**
 * Who the persona is, in the harness's own terms, so the script can be read
 * against the personas it came from.
 */
export const DEMO_SCRIPT_PERSONA = {
  id: 'demo-strong-with-one-gap',
  label: 'Strong senior data engineer with one genuinely thin area',
  band: 'senior',
  family: 'data_engineering',
  strength: 'strong',
  /**
   * Deliberately not uniformly strong. A demo of an assessment tool in which
   * the candidate is excellent at everything shows the scoring nothing to do:
   * every competency comes back the same and a prospect learns only that we
   * can say yes. One thin area — here, cost ownership, which this candidate
   * has genuinely never held — gives the evidence extractor something to find
   * nothing of, and gives the assessment something honest to report.
   */
  thinCompetency: 'cost and platform ownership',
} as const;

/**
 * Where the sandbox's own interviewer name goes.
 *
 * The script cannot name the interviewer: each demo sandbox is given one at
 * random from the catalogue, so a hard-coded name meant the rail said "Avery"
 * while the opening line said "Maya" — the first thing a prospect would
 * notice, and the kind of seam that makes a written interview look written.
 */
export const INTERVIEWER_PLACEHOLDER = '{interviewer}';

/** Fill the script's placeholders from the session this sitting actually has. */
export function scriptLineText(line: DemoScriptLine, interviewer: string): string {
  return line.text.split(INTERVIEWER_PLACEHOLDER).join(interviewer);
}

export type ScriptSpeaker = 'agent' | 'candidate';

export interface DemoScriptLine {
  readonly speaker: ScriptSpeaker;
  /** What is said. */
  readonly text: string;
  /**
   * Which competency this turn is evidence for, as the evaluator reads it.
   * Empty for greeting, warm-up and close.
   */
  readonly competencyId?: string;
  /** The utterance kind, for the room's captions and the transcript. */
  readonly kind?: string;
  /**
   * How long the watcher waits before this line appears, in milliseconds.
   *
   * These are the point of the mode. A transcript that arrives all at once is
   * a document; a transcript that arrives with a four-second pause before a
   * hard question and eleven seconds while someone thinks is an interview.
   * The candidate's pauses are longer than the interviewer's on purpose, and
   * the longest pause in the script is before the thin answer.
   */
  readonly afterMs: number;
}

/**
 * The interview, turn by turn.
 *
 * Total scripted time is a little under eleven minutes, which leaves room
 * inside the fifteen-minute box for the close and the assessment without the
 * time box ever having to intervene — an observer should see an interview that
 * ENDS, not one that runs out.
 */
export const DEMO_OBSERVER_SCRIPT: readonly DemoScriptLine[] = [
  {
    speaker: 'agent',
    kind: 'opening',
    afterMs: 1_500,
    text: "Hello Ravi — I'm {interviewer}, and I'll be running this first-round conversation for the Senior Data Engineer role. A member of the hiring team may observe this interview live. To start us off gently: tell me what you're responsible for day to day at the moment.",
  },
  {
    speaker: 'candidate',
    afterMs: 9_000,
    competencyId: '__warmup__',
    text: "Sure. I'm on the data platform team at a logistics company — about forty analysts and six product teams depend on us. I own the ingestion and modelling layer: roughly ninety Airflow DAGs feeding a Snowflake warehouse, with dbt on top for the marts. Day to day it's a mix of building new pipelines when a product team needs a dataset, and keeping the existing ones honest.",
  },
  {
    speaker: 'agent',
    kind: 'question',
    afterMs: 4_000,
    competencyId: 'pipeline_reliability',
    text: "Ninety DAGs is a lot to keep honest. Walk me through the last time one of those pipelines broke in a way that mattered — what happened, and what you did.",
  },
  {
    speaker: 'candidate',
    afterMs: 12_000,
    competencyId: 'pipeline_reliability',
    text: "In March our shipment-events pipeline silently dropped about four hours of records. The upstream service changed a field from an integer to a string, our loader coerced it, and the rows landed with a null shipment id — so nothing errored, the DAG went green, and the daily on-time-delivery number was wrong by about two per cent. An analyst caught it, which is the part I'm least happy about. I rolled the mart back to the previous snapshot, replayed the raw events from S3 through a fixed loader, and had it corrected in about three hours. Then I did the actual work, which was making that class of failure loud: we added schema contracts at the ingestion boundary with dbt tests on the raw layer, so a type change fails the load instead of coercing, and a freshness-plus-row-count check on every critical mart. We've caught two upstream changes that way since.",
  },
  {
    speaker: 'agent',
    kind: 'followup',
    afterMs: 4_500,
    competencyId: 'pipeline_reliability',
    text: "You said an analyst caught it rather than your monitoring. What made you choose schema contracts at the boundary over, say, alerting on the output number itself?",
  },
  {
    speaker: 'candidate',
    afterMs: 11_000,
    competencyId: 'pipeline_reliability',
    text: "We did both in the end, but I wanted the boundary check first because it tells you what broke rather than that something did. An alert on the delivery number would have fired the next morning and left me bisecting ninety DAGs. The trade-off is that contracts are strict — they fail loads for changes that are actually harmless, and we had a noisy fortnight where a team added a nullable column and the load stopped. So we narrowed it: we assert types and required fields, not the full shape. If I did it again I'd start narrow rather than starting strict and loosening under pressure.",
  },
  {
    speaker: 'agent',
    kind: 'question',
    afterMs: 4_000,
    competencyId: 'sql_and_modelling',
    text: "Let's move to the modelling side. Tell me about a schema you designed that you'd defend, and what you traded away to get it.",
  },
  {
    speaker: 'candidate',
    afterMs: 13_000,
    competencyId: 'sql_and_modelling',
    text: "The shipment fact table. The obvious design was one row per shipment with the milestone timestamps as columns — picked up, in transit, delivered. I made it one row per shipment milestone instead, a long fact with a milestone-type dimension. It's less convenient for the analysts: every simple question needs a pivot, and I had to build three wide views over it to stop people writing that pivot themselves and getting it subtly wrong. What I bought was that new milestone types stopped being schema migrations. We'd added two in the previous year and each one was a fortnight of coordination. Since the change we've added five and none of them touched the table. The other thing it bought was correctness on late-arriving events, because a late milestone is an insert rather than an update to a row that might already have been read.",
  },
  {
    speaker: 'agent',
    kind: 'followup',
    afterMs: 4_000,
    competencyId: 'sql_and_modelling',
    text: "Those three wide views sound like they could drift from the fact table. How did you keep them honest?",
  },
  {
    speaker: 'candidate',
    afterMs: 10_000,
    competencyId: 'sql_and_modelling',
    text: "They're generated, not written — a dbt macro takes the milestone list from a seed file and produces the views, so adding a milestone type regenerates all three. And there's a reconciliation test that sums the fact and each view and fails if they disagree by a single row. That test has fired once, when someone added a filter to one view by hand. We reverted it and moved the filter into the mart above.",
  },
  {
    speaker: 'agent',
    kind: 'question',
    afterMs: 4_500,
    competencyId: 'collaboration',
    text: "You mentioned the analysts finding the pivot inconvenient. Tell me about a time you and someone you work with disagreed about a technical decision, and how that went.",
  },
  {
    speaker: 'candidate',
    afterMs: 11_500,
    competencyId: 'collaboration',
    text: "Our lead analyst wanted the wide table, and she wasn't wrong about her team's experience of it. We went in circles for about a week in comments. What actually broke it was that I stopped arguing the design and asked her to show me the five queries her team ran most. Three of them were fine against the long fact, one was genuinely worse, and one was a query I hadn't known existed that would have been broken by either design. So we built the wide views for her three, I rewrote the bad one with her, and the fifth turned into a separate piece of work. She still thinks the wide table would have been simpler and she may be right. But we stopped disagreeing about the abstraction once we were both looking at the same five queries.",
  },
  {
    speaker: 'agent',
    kind: 'question',
    afterMs: 4_000,
    competencyId: 'cloud_platform',
    // The hard one. Everything before this has been strong and specific; this
    // is where the candidate has genuinely not done the work, and the script
    // lets them say so rather than inventing a story.
    text: "You own the warehouse. Talk me through how you've handled its cost and capacity as the volume has grown — what you changed, and what it saved.",
  },
  {
    speaker: 'candidate',
    // The longest pause in the script, because this is the question they
    // do not have an answer ready for.
    afterMs: 16_000,
    competencyId: 'cloud_platform',
    text: "Honestly, that's not been mine. We have a platform team that owns the Snowflake account, the warehouse sizing and the budget, and they come to us if something we run is expensive. I've responded to that a couple of times — I remember clustering a table because a dashboard was scanning all of it — but I didn't do the analysis that found it and I've never set a warehouse size or seen the bill. It's the part of the role I'd be picking up rather than bringing.",
  },
  {
    speaker: 'agent',
    kind: 'followup',
    afterMs: 4_000,
    competencyId: 'cloud_platform',
    text: "That's a fair answer. Take the clustering change you did make — what told you clustering was the right lever there?",
  },
  {
    speaker: 'candidate',
    afterMs: 9_500,
    competencyId: 'cloud_platform',
    text: "The platform team sent me the query profile and the pruning was almost nothing — it was reading nearly every micro-partition for a dashboard that only ever looks at the last thirty days. We clustered on the event date and the scan dropped a lot. I couldn't tell you what it saved in money, because I never saw that side of it. I know it went from a few minutes to a few seconds.",
  },
  {
    speaker: 'agent',
    kind: 'close',
    afterMs: 4_500,
    text: "That's everything I wanted to ask. Thank you, Ravi — that was a clear conversation, and I appreciate you being straight about the platform side. Before we finish: is there anything you'd like to ask me?",
  },
  {
    speaker: 'candidate',
    afterMs: 8_000,
    competencyId: '__candidate_questions__',
    text: "Just one — how much of this role is building new pipelines versus owning the platform? I'd want to know how much of that cost and capacity side would be mine from day one.",
  },
  {
    speaker: 'agent',
    kind: 'signoff',
    afterMs: 5_000,
    text: "A good question to end on, and one for the hiring team rather than me — I'll pass it on with your interview. Thank you for your time today. A member of the hiring team will review this conversation and be in touch.",
  },
];

/** How long the whole script takes to play, end to end. */
export function scriptDurationMs(script: readonly DemoScriptLine[] = DEMO_OBSERVER_SCRIPT): number {
  return script.reduce((total, line) => total + line.afterMs, 0);
}

/** Candidate turns only, which is what the evaluator reads as evidence. */
export function scriptedAnswers(script: readonly DemoScriptLine[] = DEMO_OBSERVER_SCRIPT): readonly DemoScriptLine[] {
  return script.filter((line) => line.speaker === 'candidate');
}
