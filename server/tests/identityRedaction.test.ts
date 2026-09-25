import { describe, it, expect } from 'vitest';
import { redactIdentity, NAME_PLACEHOLDER, EMAIL_PLACEHOLDER, PHONE_PLACEHOLDER, LINK_PLACEHOLDER } from '../src/services/identityRedaction.js';

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
