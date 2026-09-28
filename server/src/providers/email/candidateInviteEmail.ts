import { companyEmail, detailsTable, emailButton, escapeHtml, headerSafe, noticeBlock, textSafe } from './branding.js';
import { firstName } from '../../engines/openingModel.js';
import { inviteIntro } from '../../domain/interviewerModel.js';
import { OBSERVER_NOTICE } from '../../services/observerPolicy.js';
import { formatScheduledTime, secondClockLine, type StatedZoneSource } from '../../services/zonedTime.js';
import type { EmailMessage } from './index.js';

/**
 * The invitation a candidate receives, rendered.
 *
 * It reads as a note from the company that is hiring — their name at the top,
 * their hiring team at the bottom, no product mark — because that is who the
 * candidate applied to. What it carries is everything a person needs to decide
 * to turn up: which role, at which organisation, who is interviewing them,
 * when and on whose clock, how long it takes, what happens in the room, and
 * one address, written twice.
 *
 * THE DISCLOSURE MOVED FORWARD. This letter used to say nothing about the
 * interviewer being an AI — the argument was that the page behind the link
 * explains it before consent is asked, which it does. The owner asked for the
 * interviewer to be named (2026-09-28), and naming them means saying what they
 * are. It is also the better order: a candidate decides whether to click
 * knowing who is on the other side, rather than finding out after they have
 * committed an evening to it. The words are the product's own
 * (domain/interviewerModel.ts, services/observerPolicy.ts) so that this letter
 * and the consent screen cannot drift into promising different things.
 *
 * BOTH BODIES CARRY EVERY FACT. Not as a courtesy: Gmail disables links in
 * anything it files as spam, corporate gateways strip HTML outright, and the
 * plain-text body is also what travels into the calendar entry's description.
 * Anything true only in the HTML is a fact some candidates never receive.
 */

export interface CandidateInviteDetails {
  readonly candidateName: string;
  readonly roleTitle: string;
  readonly companyName: string;
  readonly portalUrl: string;
  readonly durationMinutes: number;
  readonly expiresAt: Date | null;
  /** The booked time, when one is set and still ahead. */
  readonly scheduledAt: Date | null;
  /** The zone every date in this letter is written in. */
  readonly timeZone: string;
  /** Where that zone came from, so the letter can say so rather than imply it is the reader's. */
  readonly zoneSource: StatedZoneSource;
  /** The candidate's own zone, as at the booking, when HR recorded one. */
  readonly candidateTimeZone: string | null;
  /** The AI interviewer this session recorded; null for a session from before the catalogue. */
  readonly interviewerName: string | null;
  /** The disclosure this candidate consents to says a member of the hiring team may watch. */
  readonly observerMayWatch: boolean;
}

/** What helps, said before the day rather than on it. Nothing here is a promise the product does not keep. */
const TIPS: readonly string[] = [
  'Find a quiet spot. A laptop or a phone both work.',
  'Speak or type your answers, whichever you prefer.',
  'If you need any adjustments, you can ask for them when you open the link.',
];

function inviteDate(at: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone }).format(at);
  return `${day} (${timeZone})`;
}

/** The interviewer as the details block names them: never blank, never invented. */
function interviewerRow(name: string | null): string {
  return name?.trim() ? `${textSafe(name)} (AI interviewer)` : 'An AI interviewer';
}

/**
 * What the candidate is told before they click Join, in the product's own
 * words. The observer sentence is `OBSERVER_NOTICE` verbatim, because it is
 * the sentence they will be shown again on the consent screen and hear again
 * in the opening — three places, one wording, or the third one sounds new.
 */
function disclosure(d: CandidateInviteDetails): readonly string[] {
  return [
    inviteIntro(d.interviewerName ? textSafe(d.interviewerName) : null),
    ...(d.observerMayWatch ? [OBSERVER_NOTICE] : []),
    'You will be asked to agree to all of this before the interview starts.',
  ];
}

export function buildCandidateInvite(d: CandidateInviteDetails): EmailMessage {
  const first = firstName(d.candidateName) || 'there';
  const role = textSafe(d.roleTitle);
  const company = textSafe(d.companyName);
  const booked = d.scheduledAt ? formatScheduledTime(d.scheduledAt, d.timeZone) : null;

  // The time is not repeated here: it is in the details block, once, where a
  // reader looks for it. Saying it twice invites the two to disagree.
  const intro = booked
    ? `Thank you for applying for the ${role} role at ${company}. We would like to invite you to the next step: a first-round interview you do online, at the time below. It takes about ${d.durationMinutes} minutes.`
    : `Thank you for applying for the ${role} role at ${company}. We would like to invite you to the next step: a first-round interview you can do online, whenever it suits you. It takes about ${d.durationMinutes} minutes.`;

  // Only where there is a booked time to put on a clock. An invitation the
  // candidate may open whenever suits them names no instant, so there is
  // nothing for a zone to be wrong about.
  const clock = d.scheduledAt
    ? secondClockLine({ at: d.scheduledAt, statedZone: d.timeZone, candidateZone: d.candidateTimeZone, source: d.zoneSource, companyName: company })
    : null;

  // The portal has no way to book a time, so an unbooked invite offers none.
  const whenToStart = booked ? 'Please open the link at that time.' : `You can start whenever suits you${d.expiresAt ? ' before then' : ''}.`;
  const until = d.expiresAt ? `The link is open until ${inviteDate(d.expiresAt, d.timeZone)}. ${whenToStart}` : whenToStart;

  const rows = [
    { label: 'Role', value: role },
    { label: 'Organisation', value: company },
    { label: 'Interviewer', value: interviewerRow(d.interviewerName) },
    { label: booked ? 'When' : 'Starts', value: booked ?? 'Whenever suits you' },
    { label: 'How long', value: `About ${d.durationMinutes} minutes` },
  ];
  const said = disclosure(d);
  const action = booked ? 'Join your interview' : 'Start your interview';

  // The disclosure comes BEFORE the button in both bodies. A candidate should
  // know who is interviewing them, and who else may be watching, while they
  // are deciding whether to click — not on the page they land on having
  // already decided.
  const text = [
    `Hi ${first},`,
    '',
    intro,
    '',
    ...rows.map((row) => `${row.label}: ${row.value}`),
    ...(clock ? ['', clock] : []),
    '',
    ...said,
    '',
    `${action}: ${d.portalUrl}`,
    '',
    'A few things that help:',
    ...TIPS.map((tip) => `- ${tip}`),
    '',
    until,
    '',
    'Best regards,',
    `The ${company} hiring team`,
  ].join('\n');

  const html = [
    `<p style="margin:0 0 14px">Hi ${escapeHtml(first)},</p>`,
    `<p style="margin:0 0 18px">${escapeHtml(intro)}</p>`,
    detailsTable(rows),
    ...(clock ? [`<p style="margin:-10px 0 18px;color:#5a5a6e;font-size:13px;line-height:1.5">${escapeHtml(clock)}</p>`] : []),
    noticeBlock(said),
    emailButton(d.portalUrl, action),
    '<p style="margin:4px 0 6px;font-weight:600">A few things that help</p>',
    `<ul style="margin:0 0 18px;padding-left:20px">${TIPS.map((tip) => `<li style="margin:0 0 6px">${escapeHtml(tip)}</li>`).join('')}</ul>`,
    `<p style="margin:0 0 18px;color:#5a5a6e;font-size:14px">${escapeHtml(until)}</p>`,
    `<p style="margin:0">Best regards,<br>The ${escapeHtml(company)} hiring team</p>`,
  ].join('\n');

  // The preview line a client shows beside the subject. Without one it takes
  // the first words of the body, so every invitation previewed as "Hi Ada,".
  const preview = booked
    ? `${role} at ${company} — ${booked}`
    : `${role} at ${company} — about ${d.durationMinutes} minutes, whenever suits you`;

  return companyEmail({
    to: '',
    subject: `Your interview for ${headerSafe(d.roleTitle)} at ${headerSafe(d.companyName)}`,
    text,
    html,
  }, company, preview);
}
