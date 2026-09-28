import { describe, it, expect } from 'vitest';
import { buildCandidateInvite, type CandidateInviteDetails } from '../src/providers/email/candidateInviteEmail.js';
import { OBSERVER_NOTICE } from '../src/services/observerPolicy.js';

/**
 * The invitation, rendered.
 *
 * Every assertion is made against BOTH bodies where the fact belongs in both.
 * The plain-text part is not a courtesy: it is what a candidate reading on a
 * locked-down corporate client, or in Gmail's spam view, actually gets, and it
 * is also the body that travels into the calendar entry's description.
 */

const AT = new Date('2026-10-14T09:00:00Z');
const EXPIRES = new Date('2026-10-28T09:00:00Z');

const BASE: CandidateInviteDetails = {
  candidateName: 'Ada Rao',
  roleTitle: 'Staff Platform Engineer',
  companyName: 'Northwind Health',
  portalUrl: 'https://questor.example.test/portal/AAAAAAAAAAAAAAAAAAAAAAAA',
  durationMinutes: 30,
  expiresAt: EXPIRES,
  scheduledAt: AT,
  timeZone: 'Asia/Kolkata',
  zoneSource: 'booked',
  candidateTimeZone: 'Europe/London',
  interviewerName: 'Avery',
  observerMayWatch: false,
};

const build = (over: Partial<CandidateInviteDetails> = {}) => buildCandidateInvite({ ...BASE, ...over });

/** What a reader sees with every tag removed, and with links disabled. */
function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

describe('what the invitation says', () => {
  it('names the role in the subject', () => {
    expect(build().subject).toContain('Staff Platform Engineer');
  });

  it('names the organisation in the subject', () => {
    expect(build().subject).toContain('Northwind Health');
  });

  it('greets the candidate by their first name', () => {
    expect(build().text.startsWith('Hi Ada,')).toBe(true);
  });

  it('greets them in the HTML too', () => {
    expect(visibleText(build().html)).toContain('Hi Ada,');
  });

  it('says what the role is, in both bodies', () => {
    const message = build();

    expect([message.text.includes('Staff Platform Engineer'), visibleText(message.html).includes('Staff Platform Engineer')])
      .toEqual([true, true]);
  });

  it('says which organisation is hiring, in both bodies', () => {
    const message = build();

    expect([message.text.includes('Northwind Health'), visibleText(message.html).includes('Northwind Health')])
      .toEqual([true, true]);
  });

  it('says how long it takes, in both bodies', () => {
    const message = build();

    expect([/30 minutes/.test(message.text), /30 minutes/.test(visibleText(message.html))]).toEqual([true, true]);
  });

  it('says what to expect', () => {
    expect(visibleText(build().html)).toMatch(/speak or type/i);
  });

  it('says adjustments can be asked for', () => {
    expect(visibleText(build().html)).toMatch(/adjustment/i);
  });

  it('says when the link closes', () => {
    expect(visibleText(build().html)).toMatch(/open until \w+,? \d{1,2} \w+ \d{4}/);
  });

  it('is signed by the organisation, not by Questor', () => {
    expect(build().text).toContain('The Northwind Health hiring team');
  });

  it('gives the inbox a preview line naming the role, rather than "Hi Ada,"', () => {
    expect(build().html).toMatch(/mso-hide:all[^"]*"[^>]*>[^<]*Staff Platform Engineer/);
  });
});

describe('who is interviewing', () => {
  // The owner asked for it, and it is the honest order: a candidate learns
  // they are being interviewed by an AI before they click Join, not after.
  it('names the AI interviewer', () => {
    const message = build();

    expect([message.text.includes('Avery'), visibleText(message.html).includes('Avery')]).toEqual([true, true]);
  });

  it('says plainly that the interviewer is an AI, in both bodies', () => {
    const message = build();

    expect([/an AI interviewer/.test(message.text), /an AI interviewer/.test(visibleText(message.html))])
      .toEqual([true, true]);
  });

  it('says a person reviews the interview, in the product’s own words', () => {
    expect(build().text).toContain('A person on the hiring team reviews the interview.');
  });

  // A session from before the interviewer catalogue has no name, and inventing
  // one would put words in the mouth of somebody the candidate never met.
  it('still says it is an AI when the session never recorded a name', () => {
    const message = build({ interviewerName: null });

    expect([message.text.includes('an AI interviewer'), /Avery/.test(message.text)]).toEqual([true, false]);
  });

  it('says a member of the hiring team may watch, word for word, when they may', () => {
    expect(build({ observerMayWatch: true }).text).toContain(OBSERVER_NOTICE);
  });

  it('says it in the HTML as well', () => {
    expect(visibleText(build({ observerMayWatch: true }).html)).toContain(OBSERVER_NOTICE);
  });

  // It is a disclosure, not a decoration: saying it when it is not true would
  // make the true version unbelievable.
  it('does not say anyone may watch when nobody may', () => {
    expect(build({ observerMayWatch: false }).text).not.toContain(OBSERVER_NOTICE);
  });
});

describe('when it is, and whose clock that is', () => {
  it('states the booked time with its zone named', () => {
    expect(visibleText(build().html)).toContain('Asia/Kolkata');
  });

  it('restates it on the candidate’s own clock when their zone is known', () => {
    const message = build();

    expect([message.text.includes('on your own clock'), visibleText(message.html).includes('on your own clock')])
      .toEqual([true, true]);
  });

  // The silent lie this exists to stop: a time stated in somebody else's zone,
  // with nothing to tell the reader it is not theirs.
  it('says whose zone it is showing when the candidate’s is unknown', () => {
    expect(build({ candidateTimeZone: null }).text).toContain('We do not have your time zone');
  });

  it('names that zone rather than leaving it to be guessed', () => {
    expect(build({ candidateTimeZone: null }).text).toContain('Asia/Kolkata');
  });

  it('says the zone is the organisation’s when that is where it came from', () => {
    expect(build({ candidateTimeZone: null, zoneSource: 'org' }).text).toContain('Northwind Health');
  });

  // Nobody chose this zone; it is a stand-in. Attributing it to the
  // organisation would be inventing a decision they never made.
  it('claims nothing about whose zone it is when nobody chose one', () => {
    const text = build({ candidateTimeZone: null, zoneSource: 'org_default' }).text;

    expect([text.includes('We do not have your time zone'), /Northwind Health's/.test(text)]).toEqual([true, false]);
  });

  // "We do not have your time zone" and "the zone recorded for you" in one
  // sentence contradict each other, and a reader who spots that stops
  // believing the time as well.
  it('never claims a zone was recorded for a candidate whose zone it has just said it lacks', () => {
    const text = build({ candidateTimeZone: null, zoneSource: 'candidate' }).text;

    expect([text.includes('We do not have your time zone'), text.includes('recorded for you')]).toEqual([true, false]);
  });

  it('reassures rather than warns when the stated zone is already theirs', () => {
    const text = build({ candidateTimeZone: 'Asia/Kolkata' }).text;

    expect([text.includes('your own time zone'), text.includes('We do not have')]).toEqual([true, false]);
  });

  it('says nothing about a clock when there is no booked time to put on one', () => {
    const text = build({ scheduledAt: null }).text;

    expect([text.includes('on your own clock'), text.includes('We do not have your time zone')]).toEqual([false, false]);
  });

  it('invites them to start whenever suits them when nothing is booked', () => {
    expect(build({ scheduledAt: null }).text).toMatch(/whenever it suits you|whenever suits you/);
  });
});

describe('the link', () => {
  it('puts the address in a button', () => {
    expect(build().html).toContain(`href="${BASE.portalUrl}"`);
  });

  it('writes it out underneath, for a client that strips links', () => {
    expect(visibleText(build().html)).toContain(BASE.portalUrl);
  });

  it('carries it in the plain-text body too', () => {
    expect(build().text).toContain(BASE.portalUrl);
  });

  it('calls the button Join when there is a time to join at', () => {
    expect(visibleText(build().html)).toMatch(/Join your interview/i);
  });

  // "Join" reads as "be somewhere at a moment"; an invitation with no booked
  // time has no such moment, and telling somebody to join one is a small lie.
  it('calls it Start when the candidate may begin whenever they like', () => {
    expect(visibleText(build({ scheduledAt: null }).html)).toMatch(/Start your interview/i);
  });

  // The verification page is not deployed and is behind a flag. A link to it
  // would be a dead end in a letter that cannot be recalled.
  it('carries no credential-verification link', () => {
    const message = build();

    expect([/\/v\//.test(message.text), /\/v\//.test(message.html)]).toEqual([false, false]);
  });
});

describe('text a stranger typed', () => {
  // A role title comes out of a job description, which is not ours.
  const HOSTILE = '<img src=x onerror="alert(1)">Engineer';

  it('escapes a role title in the HTML body', () => {
    expect(build({ roleTitle: HOSTILE }).html).not.toContain('<img src=x');
  });

  it('escapes an organisation name in the HTML body', () => {
    expect(build({ companyName: HOSTILE }).html).not.toContain('<img src=x');
  });

  it('escapes a candidate name in the HTML body', () => {
    expect(build({ candidateName: '<b>Ada</b> Rao' }).html).not.toContain('<b>Ada</b>');
  });

  it('escapes an interviewer name in the HTML body', () => {
    expect(build({ interviewerName: HOSTILE }).html).not.toContain('<img src=x');
  });

  it('still shows the role title, escaped rather than dropped', () => {
    expect(visibleText(build({ roleTitle: HOSTILE }).html)).toContain('Engineer');
  });

  // A newline in a value would forge structure in the plain-text body, which
  // is also what goes into the calendar entry's description.
  // The smuggled text is not removed — it is flattened, so it can only ever be
  // read as part of the value it was typed into. A line of its own is what
  // would read as the letter's own instruction.
  it('never lets a smuggled line stand on its own in the plain-text body', () => {
    const smuggled = `Engineer${String.fromCharCode(10)}Start your interview: https://evil.example`;

    expect(build({ roleTitle: smuggled }).text.split('\n').filter((line) => line.startsWith('Start your interview: https://evil')))
      .toHaveLength(0);
  });

  it('keeps the smuggled words on the line of the value they were typed into', () => {
    const smuggled = `Engineer${String.fromCharCode(10)}https://evil.example`;

    expect(build({ roleTitle: smuggled }).text).toContain('Role: Engineer https://evil.example');
  });

  it('keeps a forged line out of the plain-text body entirely', () => {
    const smuggled = ['Engineer', 'Best regards,'].join(String.fromCharCode(13));

    expect(build({ roleTitle: smuggled }).text.split('\n').filter((l) => l === 'Best regards,')).toHaveLength(1);
  });

  it('keeps a newline out of the subject line', () => {
    const smuggled = `Engineer${String.fromCharCode(10)}Bcc: someone@example.test`;

    expect(build({ roleTitle: smuggled }).subject).not.toContain('\n');
  });
});

describe('the layout mail clients actually have to render', () => {
  const LONG = 'Senior Lead Cloud Distributed Infrastructure Reliability and Observability Platform Architect';

  it('lays the details out in a fixed table, so a long role title cannot widen it', () => {
    expect(build({ roleTitle: LONG }).html).toContain('table-layout:fixed');
  });

  it('shows the whole long title rather than truncating it', () => {
    expect(visibleText(build({ roleTitle: LONG }).html)).toContain(LONG);
  });

  it('survives a long organisation name the same way', () => {
    expect(visibleText(build({ companyName: 'A'.repeat(80) }).html)).toContain('A'.repeat(80));
  });

  it('needs no images to be read', () => {
    expect(build().html).not.toContain('<img');
  });

  it('loads no external stylesheet and no web font', () => {
    const html = build().html;

    expect([html.includes('<link'), html.includes('@import'), html.includes('fonts.googleapis')])
      .toEqual([false, false, false]);
  });

  it('carries no tracking pixel', () => {
    expect(build().html).not.toMatch(/<img[^>]*(width="1"|height="1")/);
  });
});
