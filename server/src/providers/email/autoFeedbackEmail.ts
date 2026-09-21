import { escapeHtml, headerSafe } from './branding.js';
import type { EmailMessage } from './index.js';
import { firstName } from '../../engines/openingModel.js';
import { MARKER_LABEL, MARKER_SEGMENTS, type CoverageMarker, type FeedbackCompetency, type FeedbackContent } from '../../services/feedbackContentModel.js';

/**
 * The feedback email a candidate receives after their interview, in the layout
 * the owner approved: a header band, an at-a-glance row per competency with a
 * four-segment bar, a SWOT, what the role asks against what we heard, three
 * next steps, what happens next, and an offer to speak to a person.
 *
 * Tables and inline styles only, and the bars are table cells rather than
 * images or SVG, because that is what Gmail, Outlook and Apple Mail all
 * render. The plain-text body carries the same sections in the same order:
 * some clients show only that, and it is what the console provider logs and
 * what is stored as the record of what was sent.
 *
 * Nothing here decides anything. The bar is drawn from a word — Clear
 * strength, Partly shown, Not covered — never from a level or a score
 * (services/feedbackContentModel.ts holds that rule).
 */

/** Where the working link was, in the stored copy of what was sent. */
export const TALK_LINK_PLACEHOLDER = '[link to ask to speak to someone — not stored]';

export type FeedbackSignOff = 'questor' | 'company';

export interface AutoFeedbackEmailInput {
  readonly to: string;
  readonly candidateName: string;
  readonly roleTitle: string;
  readonly companyName: string;
  readonly content: FeedbackContent;
  /** The single-purpose "speak to a person" link, when one could be issued. */
  readonly talkUrl: string | null;
  readonly interviewedAt: Date | null;
  /** The zone the date is written in: the booking's, else the organisation's (IST when it has none). */
  readonly timeZone: string;
  readonly durationMinutes: number;
  /** Who the letter is signed by. Questor unless the organisation asked to sign it. */
  readonly signOff: FeedbackSignOff;
}

export interface RenderedAutoFeedbackEmail {
  readonly message: EmailMessage;
  /**
   * The plain-text body as it was sent, with the talk link replaced. The link
   * is a live credential and only its hash is stored (candidateLinkToken.ts);
   * a copy of it in this record would undo that.
   */
  readonly storedText: string;
}

/** The day of the interview as the candidate's clock read it, with the zone named (as the invitation does). */
function interviewDate(at: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone }).format(at);
  return `${day} (${timeZone})`;
}

// The palette of the approved design.
const INK = '#1a1a22';
const MUTED = '#6f6f86';
const BODY = '#4a4a5e';
const BRAND = '#2f2f7a';
const EMPTY_SEGMENT = '#e4e4ec';
const MARKER_COLOUR: Readonly<Record<CoverageMarker, string>> = {
  strength: '#2e9e6b',
  partly: '#c98a2e',
  'not-covered': EMPTY_SEGMENT,
};
const MARKER_TEXT_COLOUR: Readonly<Record<CoverageMarker, string>> = {
  strength: '#1f6f4c',
  partly: '#8a5c14',
  'not-covered': MUTED,
};
const MARKER_BORDER: Readonly<Record<CoverageMarker, string>> = {
  strength: '#bfe3d0',
  partly: '#ecd9b4',
  'not-covered': '#dcdce6',
};

const SECTION_LABEL = `font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${MUTED};margin-bottom:12px`;

const SWOT_QUARTERS = [
  { key: 'strengths', heading: 'Strengths', background: '#f4fbf7', border: '#cfe9dc', colour: '#1f6f4c' },
  { key: 'weaknesses', heading: 'Weaknesses', background: '#fdf8f2', border: '#f0dfc4', colour: '#8a5c14' },
  { key: 'opportunities', heading: 'Opportunities', background: '#f4f6fd', border: '#d3d9f2', colour: '#3f3a97' },
  { key: 'watchOuts', heading: 'Watch-outs', background: '#fbf5f6', border: '#eed3d7', colour: '#93384a' },
] as const;

function glanceNote(durationMinutes: number): string {
  return `Based on what the conversation covered in ${durationMinutes} minutes. ${NOT_COVERED_NOTE}`;
}

/**
 * The letter's own fixed wording, held to the same guardrails as the model's
 * (tests/autoFeedbackEmail.test.ts). A promise or a verdict is no better for
 * being hard-coded: "will be in touch about next steps" and "not a decision"
 * were exactly the phrases the checks reject when a model writes them.
 */
const INTRO = 'Thank you for your time. Here is an honest picture of how the conversation went, what the role asks for, and '
  + 'what would make the strongest difference next time. It describes the interview itself.';
const WHAT_NEXT = 'The hiring team is reviewing interviews now. This summary describes your '
  + 'interview only.';
const TALK_PROMPT = 'Would you like to talk this through with someone?';
const TALK_HELP = 'If the button does not work, copy this link:';
const SIGN_OFF = 'All the best,';
const NOT_COVERED_NOTE = '"Not covered" means the subject did not come up, not that anything was wrong.';

export const FIXED_COPY: readonly string[] = [
  INTRO, WHAT_NEXT, TALK_PROMPT, TALK_HELP, SIGN_OFF, NOT_COVERED_NOTE,
  'Interview feedback', 'At a glance', 'Your SWOT from this interview', 'What the role asks, and what we heard',
  'Your next three steps', 'What happens next.', 'The role asks for', 'What we heard', 'Your words', 'To go further',
  'Ask to speak to someone', 'Strengths', 'Weaknesses', 'Opportunities', 'Watch-outs',
];

function whoLine(companyName: string, signOff: FeedbackSignOff): string {
  if (signOff === 'company') return companyName ? `The ${companyName} hiring team` : 'The hiring team';
  return 'The Questor team';
}

function footerLine(companyName: string, signOff: FeedbackSignOff): string {
  const behalf = companyName ? `Sent on behalf of ${companyName}` : 'Sent on behalf of the hiring team';
  return signOff === 'company' ? behalf : `${behalf} · Questor`;
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

function textBody(input: AutoFeedbackEmailInput, first: string, talkLine: string | null): string {
  const c = input.content;
  const company = input.companyName.trim();
  const when = input.interviewedAt ? `interviewed ${interviewDate(input.interviewedAt, input.timeZone)} · ` : '';
  const lines: string[] = [
    'INTERVIEW FEEDBACK',
    company ? `${input.roleTitle} · ${company}` : input.roleTitle,
    `${first} · ${when}${input.durationMinutes} minutes`,
    '',
    `Hi ${first},`,
    '',
    INTRO,
    '',
    'AT A GLANCE',
    ...c.competencies.map((comp) => `- ${comp.name}: ${MARKER_LABEL[comp.marker]}`),
    glanceNote(input.durationMinutes),
    '',
    'YOUR SWOT FROM THIS INTERVIEW',
    ...SWOT_QUARTERS.flatMap((q) => [q.heading, ...c.swot[q.key].map((b) => `- ${b}`), '']),
    'WHAT THE ROLE ASKS, AND WHAT WE HEARD',
    ...c.competencies.flatMap((comp) => [
      '',
      `${comp.name} — ${MARKER_LABEL[comp.marker]}`,
      `  The role asks for: ${comp.roleAsks}`,
      `  What we heard: ${comp.whatWeHeard}`,
      ...(comp.quote ? [`  Your words: "${comp.quote}"`] : []),
      `  To go further: ${comp.toGoFurther}`,
    ]),
    '',
    'YOUR NEXT THREE STEPS',
    ...c.nextSteps.map((step, i) => `${i + 1}. ${step}`),
    '',
    'WHAT HAPPENS NEXT',
    WHAT_NEXT,
    ...(talkLine ? ['', TALK_PROMPT, talkLine] : []),
    '',
    SIGN_OFF,
    whoLine(company, input.signOff),
    '',
    footerLine(company, input.signOff),
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function bar(marker: CoverageMarker): string {
  const filled = MARKER_SEGMENTS[marker];
  const cells = [0, 1, 2, 3]
    .map((i) => `<td height="9" style="background:${i < filled ? MARKER_COLOUR[marker] : EMPTY_SEGMENT};border-radius:4px"></td>`)
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:3px 0"><tr>${cells}</tr></table>`;
}

function glanceRow(comp: FeedbackCompetency): string {
  return `<tr>
<td style="padding:0 10px 10px 0;color:${INK};font-weight:600">${escapeHtml(comp.name)}</td>
<td style="padding:0 10px 10px 0;width:46%">${bar(comp.marker)}</td>
<td style="padding:0 0 10px 0;color:${MARKER_TEXT_COLOUR[comp.marker]};font-size:12.5px;font-weight:600;white-space:nowrap">${MARKER_LABEL[comp.marker]}</td>
</tr>`;
}

function swotCell(quarter: (typeof SWOT_QUARTERS)[number], bullets: readonly string[]): string {
  return `<td width="50%" valign="top" style="background:${quarter.background};border:1px solid ${quarter.border};border-radius:10px;padding:14px 15px">
<div style="font-size:13px;font-weight:700;color:${quarter.colour};letter-spacing:.04em;text-transform:uppercase">${quarter.heading}</div>
<ul style="margin:9px 0 0;padding-left:17px;font-size:13.5px;line-height:1.6;color:#33334a">${
  bullets.map((b) => `<li style="margin-bottom:6px">${escapeHtml(b)}</li>`).join('')
}</ul></td>`;
}

function detailRow(label: string, value: string, italic = false): string {
  return `<tr><td width="130" valign="top" style="color:${MUTED};padding:3px 10px 3px 0">${label}</td>`
    + `<td style="padding:3px 0${italic ? `;font-style:italic;color:#5a5a6e` : ''}">${escapeHtml(value)}</td></tr>`;
}

function detailCard(comp: FeedbackCompetency): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6e6ee;border-radius:10px;border-collapse:separate;margin-bottom:12px">
<tr><td style="padding:14px 16px">
<div style="font-size:15px;font-weight:600;color:${INK};margin-bottom:8px">${escapeHtml(comp.name)} <span style="font-size:11.5px;font-weight:700;color:${MARKER_TEXT_COLOUR[comp.marker]};border:1px solid ${MARKER_BORDER[comp.marker]};border-radius:999px;padding:2px 9px;margin-left:6px">${MARKER_LABEL[comp.marker]}</span></div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13.5px;line-height:1.6;color:${BODY}">
${detailRow('The role asks for', comp.roleAsks)}
${detailRow('What we heard', comp.whatWeHeard)}
${comp.quote ? detailRow('Your words', `"${comp.quote}"`, true) : ''}
${detailRow('To go further', comp.toGoFurther)}
</table>
</td></tr></table>`;
}

function stepRow(step: string, index: number, last: boolean): string {
  const padding = last ? '0' : '0 0 12px';
  return `<tr>
<td width="34" valign="top" style="padding:${padding}"><div style="width:26px;height:26px;border-radius:50%;background:${BRAND};color:#fff;font-size:12.5px;font-weight:700;text-align:center;line-height:26px">${index + 1}</div></td>
<td style="padding:${last ? '0 0 0 8px' : '0 0 12px 8px'};color:${BODY}">${escapeHtml(step)}</td>
</tr>`;
}

function talkSection(talkUrl: string): string {
  const url = escapeHtml(talkUrl);
  return `<p style="margin:0 0 8px">${TALK_PROMPT}</p>
<p style="margin:0 0 8px"><a href="${url}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;font-size:14px">Ask to speak to someone</a></p>
<p style="margin:0 0 18px;font-size:12.5px;color:${MUTED}">${TALK_HELP}<br><span style="color:${INK};word-break:break-all">${url}</span></p>`;
}

function htmlBody(input: AutoFeedbackEmailInput, first: string): string {
  const c = input.content;
  const company = input.companyName.trim();
  const when = input.interviewedAt ? `interviewed ${interviewDate(input.interviewedAt, input.timeZone)} · ` : '';
  const title = company ? `${input.roleTitle} · ${company}` : input.roleTitle;

  return `<div style="background:#eef0f5;padding:28px 12px;font-family:Segoe UI,system-ui,-apple-system,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:660px;margin:0 auto;background:#ffffff;border:1px solid #e0e0e9;border-radius:14px;border-collapse:separate;overflow:hidden">

<tr><td style="padding:26px 32px 22px;background:${BRAND};color:#ffffff">
<div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;opacity:.75">Interview feedback</div>
<div style="font-size:23px;font-weight:600;margin-top:6px">${escapeHtml(title)}</div>
<div style="font-size:13px;opacity:.8;margin-top:6px">${escapeHtml(`${first} · ${when}${input.durationMinutes} minutes`)}</div>
</td></tr>

<tr><td style="padding:24px 32px 6px;font-size:15px;line-height:1.65;color:${INK}">
<p style="margin:0 0 6px">Hi ${escapeHtml(first)},</p>
<p style="margin:0 0 4px">${escapeHtml(INTRO)}</p>
</td></tr>

<tr><td style="padding:22px 32px 0">
<div style="${SECTION_LABEL}">At a glance</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">
${c.competencies.map(glanceRow).join('\n')}
</table>
<div style="font-size:12.5px;color:${MUTED};margin-top:8px">${escapeHtml(glanceNote(input.durationMinutes))}</div>
</td></tr>

<tr><td style="padding:26px 32px 0">
<div style="${SECTION_LABEL}">Your SWOT from this interview</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:10px">
<tr>${swotCell(SWOT_QUARTERS[0], c.swot.strengths)}${swotCell(SWOT_QUARTERS[1], c.swot.weaknesses)}</tr>
<tr>${swotCell(SWOT_QUARTERS[2], c.swot.opportunities)}${swotCell(SWOT_QUARTERS[3], c.swot.watchOuts)}</tr>
</table>
</td></tr>

<tr><td style="padding:26px 32px 0">
<div style="${SECTION_LABEL}">What the role asks, and what we heard</div>
${c.competencies.map(detailCard).join('\n')}
</td></tr>

<tr><td style="padding:26px 32px 0">
<div style="${SECTION_LABEL}">Your next three steps</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.6">
${c.nextSteps.map((step, i) => stepRow(step, i, i === c.nextSteps.length - 1)).join('\n')}
</table>
</td></tr>

<tr><td style="padding:24px 32px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6fa;border:1px solid #e6e6ee;border-radius:10px">
<tr><td style="padding:14px 16px;font-size:13.5px;line-height:1.6;color:${BODY}">
<b style="color:${INK}">What happens next.</b> ${escapeHtml(WHAT_NEXT)}
</td></tr></table>
</td></tr>

<tr><td style="padding:20px 32px 30px;font-size:14px;line-height:1.6;color:${INK}">
${input.talkUrl ? talkSection(input.talkUrl) : ''}
<p style="margin:0 0 2px">${SIGN_OFF}</p>
<p style="margin:0">${escapeHtml(whoLine(company, input.signOff))}</p>
</td></tr>

</table>
<p style="max-width:660px;margin:12px auto 0;font-size:12px;color:#8a8a9a;text-align:center">${escapeHtml(footerLine(company, input.signOff))}</p>
</div>`;
}

export function renderAutoFeedbackEmail(input: AutoFeedbackEmailInput): RenderedAutoFeedbackEmail {
  const first = firstName(input.candidateName) || 'there';
  const company = input.companyName.trim();
  const role = input.roleTitle.trim();
  const message: EmailMessage = {
    to: input.to,
    subject: `Your interview feedback — ${headerSafe(role)}${company ? ` at ${headerSafe(company)}` : ''}`,
    text: textBody(input, first, input.talkUrl),
    html: htmlBody(input, first),
  };
  return {
    message,
    storedText: input.talkUrl ? textBody(input, first, TALK_LINK_PLACEHOLDER) : message.text,
  };
}
