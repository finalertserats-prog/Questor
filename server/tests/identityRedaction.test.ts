import { describe, it, expect } from 'vitest';
import { redactIdentity, redactUniqueHandles, NAME_PLACEHOLDER, EMAIL_PLACEHOLDER, PHONE_PLACEHOLDER, LINK_PLACEHOLDER } from '../src/services/identityRedaction.js';

/**
 * Removing the identifiers Questor actually holds from free text.
 *
 * This is the half of anonymisation that can be done reliably: the candidate's
 * name, address, phone and LinkedIn URL are known exactly, so they can be found
 * wherever they were said. The half that cannot — a former employer, a
 * manager's name, a town small enough to be a fingerprint — is not this
 * function's job and is stated as residual risk rather than pretended away.
 *
 * Every case below is a form these strings really take in a transcript: the
 * name spoken in full, spoken as a first name, written after an honorific,
 * typed in lower case by a speech-to-text engine, or spelled into a phone
 * number with spaces in it.
 */

const KAJAL = {
  fullName: 'Kajal Vishwakarma',
  email: 'Kajal.Vishwakarma@example.com',
  emailNormalized: 'kajal.vishwakarma@example.com',
  phone: '+91 98765 43210',
  linkedinUrl: 'https://www.linkedin.com/in/kajal-vishwakarma-8821',
};

describe('redacting the identifiers we hold', () => {
  it('removes the full name', () => {
    expect(redactIdentity('My name is Kajal Vishwakarma.', KAJAL)).toBe(`My name is ${NAME_PLACEHOLDER}.`);
  });

  it('removes a first name used on its own', () => {
    expect(redactIdentity('Thanks Kajal, that was helpful.', KAJAL)).toBe(`Thanks ${NAME_PLACEHOLDER}, that was helpful.`);
  });

  it('removes a surname used after an honorific, leaving the honorific, which identifies nobody', () => {
    expect(redactIdentity('Ms Vishwakarma led the migration.', KAJAL)).toBe(`Ms ${NAME_PLACEHOLDER} led the migration.`);
  });

  it('removes the name however it was capitalised, because a transcription engine decides that, not the speaker', () => {
    expect(redactIdentity('so kajal vishwakarma said', KAJAL)).toBe(`so ${NAME_PLACEHOLDER} said`);
  });

  it('collapses the full name to one placeholder rather than one per word', () => {
    const redacted = redactIdentity('Kajal Vishwakarma', KAJAL);
    expect(redacted).toBe(NAME_PLACEHOLDER);
  });

  it('leaves a longer word that merely starts with the name alone', () => {
    // Over-redaction is the safe direction, but not at the cost of turning
    // every transcript into holes: "Kajalesque" is not the candidate.
    expect(redactIdentity('Kajalesque', KAJAL)).toBe('Kajalesque');
  });

  it('removes the address as stored and as typed in a different case', () => {
    expect(redactIdentity('Write to KAJAL.VISHWAKARMA@EXAMPLE.COM today.', KAJAL))
      .toBe(`Write to ${EMAIL_PLACEHOLDER} today.`);
  });

  it('removes the phone number however it was spaced, because nobody writes it back the way we stored it', () => {
    expect(redactIdentity('Call 9876543210 or +91-98765-43210.', KAJAL))
      .toBe(`Call ${PHONE_PLACEHOLDER} or ${PHONE_PLACEHOLDER}.`);
  });

  it('removes the LinkedIn URL', () => {
    expect(redactIdentity(`See ${KAJAL.linkedinUrl} for more.`, KAJAL)).toBe(`See ${LINK_PLACEHOLDER} for more.`);
  });

  it.each([
    'http://linkedin.com/in/kajal-vishwakarma-8821',
    'https://www.linkedin.com/in/kajal-vishwakarma-8821/',
    'https://in.linkedin.com/in/kajal-vishwakarma-8821?utm_source=share',
    'linkedin.com/in/kajal-vishwakarma-8821',
  ])('removes the profile however the link was written: %j', (written) => {
    // Matching the stored string literally was the original mistake. A scheme,
    // a trailing slash or a tracking parameter and it stopped matching, and the
    // profile stayed in the transcript the owner keeps for ever.
    expect(redactIdentity(`Profile: ${written}`, KAJAL)).toBe(`Profile: ${LINK_PLACEHOLDER}`);
  });

  it('removes the profile slug said on its own, which is how people actually give it out', () => {
    expect(redactIdentity('my linkedin is kajal-vishwakarma-8821', KAJAL))
      .toBe(`my linkedin is ${LINK_PLACEHOLDER}`);
  });

  it('leaves a longer handle that merely contains the slug alone', () => {
    // Only the profile is known here, so this isolates the slug's own
    // boundaries from the name-part matching tested above — which would fire on
    // "kajal" and is a separate, deliberate behaviour.
    const profileOnly = { fullName: '', email: '', emailNormalized: '', phone: '', linkedinUrl: KAJAL.linkedinUrl };
    expect(redactIdentity('kajal-vishwakarma-8821-archive', profileOnly)).toBe('kajal-vishwakarma-8821-archive');
  });

  it('removes a name written with a non-ASCII letter, where a plain word boundary does not work', () => {
    const jose = { ...KAJAL, fullName: 'José Álvarez', email: '', emailNormalized: '', phone: '', linkedinUrl: '' };
    expect(redactIdentity('I asked José about it.', jose)).toBe(`I asked ${NAME_PLACEHOLDER} about it.`);
  });

  it('leaves a bare honorific alone, so a name field of "Ms Kajal" does not redact every "Ms" in the transcript', () => {
    const titled = { ...KAJAL, fullName: 'Ms Kajal Vishwakarma' };
    expect(redactIdentity('Ms Patel chaired the panel.', titled)).toBe('Ms Patel chaired the panel.');
  });

  it('leaves text with none of our identifiers in it exactly as it was, so a transcript keeps its learning value', () => {
    const answer = 'I cut p99 latency from 1200ms to 180ms by batching the writes and adding a covering index.';
    expect(redactIdentity(answer, KAJAL)).toBe(answer);
  });

  it('is idempotent, so a second sweep over already-redacted text changes nothing', () => {
    const once = redactIdentity('Kajal Vishwakarma, kajal.vishwakarma@example.com, 9876543210', KAJAL);
    expect(redactIdentity(once, KAJAL)).toBe(once);
  });

  it('ignores an empty identifier rather than matching everything', () => {
    const blank = { fullName: '', email: '', emailNormalized: '', phone: '', linkedinUrl: '' };
    expect(redactIdentity('Anything at all.', blank)).toBe('Anything at all.');
  });

  it('redacts inside JSON without breaking it, because most of what we scrub is a JSON column', () => {
    const json = JSON.stringify({ quote: 'Kajal said the index helped', reviewer: 'unchanged' });
    const parsed = JSON.parse(redactIdentity(json, KAJAL)) as { quote: string; reviewer: string };
    expect(parsed).toEqual({ quote: `${NAME_PLACEHOLDER} said the index helped`, reviewer: 'unchanged' });
  });
});

describe('redacting only the unique handles, for text that is not one candidate’s to rewrite', () => {
  it('takes out the address and the profile', () => {
    const shared = `write to ${KAJAL.email}, profile ${KAJAL.linkedinUrl}`;
    expect(redactUniqueHandles(shared, KAJAL))
      .toBe(`write to ${EMAIL_PLACEHOLDER}, profile ${LINK_PLACEHOLDER}`);
  });

  it('leaves the phone, because a number is not always one person’s', () => {
    // This is the correction a review forced. The justification for touching an
    // unowned row at all is that a handle identifies exactly one person — true
    // of an address, not always true of a number. Households share one,
    // agencies put their switchboard on every candidate they submit. Rewriting
    // another candidate's "call 9876543210" damages their record to satisfy
    // this one's timer, which is the harm the rule exists to prevent.
    expect(redactUniqueHandles('call 9876543210 to arrange it', KAJAL))
      .toBe('call 9876543210 to arrange it');
  });

  it('leaves the name, because a row shared with other candidates is not this one’s to edit', () => {
    expect(redactUniqueHandles('Kajal Vishwakarma explained the trade-off well', KAJAL))
      .toBe('Kajal Vishwakarma explained the trade-off well');
  });

  it('still takes the phone out of the candidate’s OWN record, where over-redaction costs only them', () => {
    expect(redactIdentity('call 9876543210 to arrange it', KAJAL))
      .toBe(`call ${PHONE_PLACEHOLDER} to arrange it`);
  });
});

describe('spellings that mean the same thing', () => {
  it('matches a percent-encoded profile against the one a browser shows', () => {
    const encoded = { ...KAJAL, linkedinUrl: 'https://www.linkedin.com/in/kajal%2Dvishwakarma-8821' };
    expect(redactIdentity('see linkedin.com/in/kajal-vishwakarma-8821', encoded))
      .toBe(`see ${LINK_PLACEHOLDER}`);
  });

  it('matches the browser-visible profile against a percent-encoded transcript', () => {
    expect(redactIdentity('see linkedin.com/in/kajal%2Dvishwakarma-8821', KAJAL))
      .toBe(`see ${LINK_PLACEHOLDER}`);
  });

  it('matches a name whichever way Unicode encoded the accent', () => {
    // "José" is one code point or two depending on what produced the text, and
    // a regex built from one does not match the other. A speech-to-text engine
    // emits one, a copy-paste from a CV the other.
    const jose = { fullName: 'José Álvarez', email: '', emailNormalized: '', phone: '', linkedinUrl: '' };
    const decomposed = 'I asked José about it.';
    expect(redactIdentity(decomposed, jose)).toBe(`I asked ${NAME_PLACEHOLDER} about it.`);
  });

  it('matches the accent-stripped spelling an English transcript produces', () => {
    const jose = { fullName: 'José Álvarez', email: '', emailNormalized: '', phone: '', linkedinUrl: '' };
    expect(redactIdentity('I asked Jose about it.', jose)).toBe(`I asked ${NAME_PLACEHOLDER} about it.`);
  });
});
