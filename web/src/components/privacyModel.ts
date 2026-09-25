/**
 * What Questor does with a candidate's data, in one place.
 *
 * The public privacy page reads this, and so does the About page's trust
 * section (trustModel.ts imports RECIPIENT lines from here), so the two cannot
 * drift apart. Before this existed they already had: the consent screen told
 * candidates their voice goes to Google's servers in Chrome and Edge, while
 * the About page and the published DPIA said only that transcripts go to the
 * configured model provider — two live surfaces describing the same processing
 * differently (legal review pack, §6 note 4).
 *
 * Every line here is checked against the code. Kept free of React so a test can
 * hold the page and the trust section to the same list
 * (web/tests/privacyModel.test.ts).
 *
 * NOT LEGAL ADVICE. This is a description of how the software behaves, written
 * by the people who built it.
 */

/** The interview retention window the deployment ships with (server: services/dataRights.ts). */
export const DEFAULT_RETENTION_DAYS = 180;

export interface DataRecipient {
  readonly key: string;
  /** Who they are, in the words a candidate would use. */
  readonly who: string;
  /** Exactly what reaches them. */
  readonly what: string;
  /** When it happens, including when it does not. */
  readonly when: string;
}

/**
 * Everyone outside Questor and the hiring organisation who can receive part of
 * a candidate's interview. Written so a candidate reading the consent screen
 * and a candidate reading the privacy page learn the same things.
 */
export const DATA_RECIPIENTS: readonly DataRecipient[] = [
  {
    key: 'model',
    who: 'The AI model provider the hiring organisation has configured',
    what: 'The text of what you said, quoted passages from it for scoring, and the wording of any feedback letter. Your name and contact details are not sent for scoring.',
    when: 'Whenever your interview is conducted and graded. Which provider it is depends on the deployment; ask the organisation that invited you.',
  },
  {
    key: 'speech',
    who: 'Your browser’s own speech recognition — in Chrome and Edge, that is Google',
    what: 'Your microphone audio, while you are speaking, so that it can be turned into text.',
    when: 'Only if you agree to voice and answer by speaking. Typing your answers instead means no audio leaves your device at all. This is your browser’s own behaviour, not a service Questor chose, and it is why the consent screen names it.',
  },
  {
    key: 'transcription',
    who: 'A server-side transcription provider, where the hiring organisation has configured one',
    what: 'Your microphone audio, as a fallback when your browser’s own recognition fails.',
    when: 'Only if you agree to voice, and only where that fallback is configured. The consent screen names the provider when it is.',
  },
  {
    key: 'email',
    who: 'The email service the hiring organisation uses',
    what: 'Your email address and the contents of the messages we send you — including, in a feedback letter, quotations of what you said.',
    when: 'Whenever we email you: the invitation, reminders, a one-time code, and feedback if you asked for it.',
  },
  {
    key: 'meeting',
    who: 'The meeting provider for later, human rounds (Teams, Zoom or Meet), where one is configured',
    what: 'The meeting title, its description and its time. No name, no email address, no transcript.',
    when: 'Only when a later round is booked through Questor.',
  },
  {
    key: 'ats',
    who: 'The hiring organisation’s own recruitment system, where it has connected one',
    what: 'Your name, email and phone on the way in; the assessment of your interview on the way out.',
    when: 'Only where that organisation has connected such a system.',
  },
];

/** One sentence naming every recipient, for somewhere a list will not fit. */
export const RECIPIENTS_IN_ONE_LINE = 'The text of the interview goes to the AI model provider the deployment configures, for scoring; '
  + 'your voice, while you speak, goes to your browser’s own speech recognition — in Chrome and Edge, Google’s servers — and to a server-side '
  + 'transcription provider where one is configured as a fallback; emails go through the configured email service.';

export interface PrivacySection {
  readonly key: string;
  readonly heading: string;
  /** Plain paragraphs. */
  readonly paragraphs: readonly string[];
  /** Bulleted points beneath them, where a list reads better than prose. */
  readonly points?: readonly string[];
}

/**
 * The privacy page, as content. Written for a candidate, in the second person,
 * and only about what the software actually does.
 */
export const PRIVACY_SECTIONS: readonly PrivacySection[] = [
  {
    key: 'who',
    heading: 'Who this is about',
    paragraphs: [
      'Questor is interview software. An organisation hiring for a role invited you to a first-round '
      + 'interview conducted by an AI interviewer, and Questor runs that interview on their behalf.',
      'That organisation decides what happens to your data. Questor holds it for them and acts on their '
      + 'instructions. This page describes what the software does; their own privacy notice describes '
      + 'what they do with it afterwards.',
    ],
  },
  {
    key: 'collected',
    heading: 'What is collected',
    paragraphs: ['Everything below comes either from the organisation that invited you or from the interview itself.'],
    points: [
      'Your name, email address, and any phone number or LinkedIn address the organisation holds for you.',
      'The text of your CV, where one was uploaded. The file itself is read and discarded — it is never stored.',
      'The written transcript of your interview: one line per thing said, with timings.',
      'No audio. Your voice is turned into text as you speak and each clip is discarded once the text comes back. '
      + 'There is no recording of your voice at any point, and there is no video and no camera anywhere in Questor.',
      'What you were shown before you consented, and what you agreed to, kept as the record of your consent.',
      'Any accommodation or alternative you asked for.',
      'The competency ratings, evidence quoted from your transcript, and the advisory recommendation Questor produced.',
      'What the hiring team decided, who decided it, and why.',
      'Where the organisation switched it on and your consent covered it, whether you switched browser tab or pasted text during the interview. Nothing else about your device is recorded.',
    ],
  },
  {
    key: 'why',
    heading: 'Why',
    paragraphs: [
      'To run a structured first-round interview for the role you applied for, and to give the hiring team '
      + 'evidence to decide on.',
      'Questor never rejects or hires anyone by itself. Its score and recommendation are advisory: a person '
      + 'on the hiring team reads the transcript and records the decision. Questor’s scores have not been '
      + 'validated against human hiring judgement, and we say so publicly rather than treat a score as a measurement.',
    ],
  },
  {
    key: 'how-long',
    heading: 'How long it is kept',
    paragraphs: [
      `An interview and everything attached to it carries a retention window — ${DEFAULT_RETENTION_DAYS} days by default, `
      + 'counted from when the interview finished, though the organisation running the hiring may set a different one.',
      'Two honest qualifications. Automatic deletion at the end of that window happens only where the '
      + 'organisation has switched the scheduled deletion on. And where a legal hold has been placed on an '
      + 'interview — because it may be needed for a complaint or a claim — deletion waits until that hold is lifted, '
      + 'and a request to erase it is refused while it stands, with a reason given.',
      'The record that something was erased is itself kept, and holds no transcript text and no name — so a '
      + 'deletion can be evidenced afterwards without keeping what was deleted.',
    ],
  },
  {
    key: 'shared',
    heading: 'Who it is shared with',
    paragraphs: [
      'Inside the hiring organisation, only staff whose role and assignment give them access to you. '
      + 'No other organisation using Questor can see anything of yours.',
      'Outside it, these and no others:',
    ],
  },
  {
    key: 'security',
    heading: 'How it is protected',
    paragraphs: [
      'Your interview link is single-use and is stored only as a one-way hash plus a sealed copy. Sessions '
      + 'use signed, same-site cookies; passwords are stored as hashes; the interview endpoints are rate limited.',
      'Where the organisation has switched it on, the stored text of your CV, your transcript and your report '
      + 'are encrypted with a key held only by the running application, so a database backup does not carry them in clear.',
      'No independent penetration test or security certification has been done. We would rather say so than imply otherwise.',
    ],
  },
  {
    key: 'rights',
    heading: 'Your rights',
    paragraphs: [
      'Depending on where you live, you can ask for a copy of what is held about you, ask for it to be '
      + 'corrected, ask for it to be deleted, object to how it is used, or complain to your data protection regulator.',
      'You can also ask to speak to a person about your interview, ask for an accommodation, or ask to be '
      + 'interviewed by a person instead of by the AI — before the interview, on the consent screen, or afterwards '
      + 'by replying to any email we have sent you. None of those requests counts against your application.',
      'You do not have to use the AI interview at all, and you can stop it at any time while it is running. '
      + 'An interview you stop is not scored and does not count against you.',
    ],
  },
  {
    key: 'ask',
    heading: 'How to ask for a copy, or for erasure',
    paragraphs: [
      'Ask the organisation that invited you. They decide what happens to your data, and their administrators '
      + 'can produce or erase it in Questor. The quickest route is to reply to the email your interview invitation '
      + 'came in — it reaches them.',
      'If you cannot reach them, or your request is about Questor itself rather than about their hiring, write to us '
      + 'and we will help you reach them.',
    ],
  },
];

/**
 * The address to write to about Questor itself, or null where the deployment
 * has published none.
 *
 * Read at build time, exactly like the About page and the Contact page. Null is
 * the common case today and is why nothing must be worded as though an address
 * is always there: "write to us at " with nothing after it is worse than not
 * offering the route at all.
 */
export function supportContact(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  return value.includes('@') ? value : null;
}

/**
 * What to say about reaching Questor, given whatever contact exists. Always a
 * usable sentence: with no address, the honest answer is the organisation and
 * the invitation email, not an apology for a missing link.
 */
export function contactSentence(contact: string | null): string {
  return contact
    ? `For questions about Questor itself, write to ${contact}.`
    : 'Questor publishes no separate address for candidates on this deployment. '
      + 'Replying to the email your invitation came in reaches the organisation that invited you, '
      + 'and they can raise anything with us on your behalf.';
}
