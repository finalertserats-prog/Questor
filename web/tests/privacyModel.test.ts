import { describe, expect, it } from 'vitest';
import {
  DATA_RECIPIENTS, DEFAULT_RETENTION_DAYS, PRIVACY_SECTIONS, RECIPIENTS_IN_ONE_LINE,
  contactSentence, supportContact,
} from '../src/components/privacyModel';

/**
 * The privacy notice a candidate reads.
 *
 * Two things went wrong before it existed, and these tests are about both.
 * There was no privacy page at all, so a candidate agreed to an AI interview
 * with no document to read. And the surfaces that did describe the processing
 * described it differently: the consent screen told candidates their voice goes
 * to Google's servers in Chrome and Edge, while the About page and the
 * published DPIA said only that transcripts go to the configured model
 * provider. One list, read by both, is the fix.
 */

describe('who receives what', () => {
  const all = DATA_RECIPIENTS.map((r) => `${r.who} ${r.what} ${r.when}`).join(' ');

  it('names the browser speech recognition that receives the candidate’s voice', () => {
    expect(all).toMatch(/Google/);
  });

  it('names the model provider that receives the transcript', () => {
    expect(all).toMatch(/AI model provider/);
  });

  it('names the email service that receives the candidate’s address', () => {
    expect(all).toMatch(/email service/);
  });

  it('says plainly that typing means no audio leaves the device', () => {
    expect(all).toMatch(/no audio leaves your device/);
  });

  it('never claims a fixed model provider, because the deployment chooses it', () => {
    expect(all).not.toMatch(/\bOpenAI\b|\bAnthropic\b/);
  });

  it('gives every recipient all three of who, what and when', () => {
    for (const r of DATA_RECIPIENTS) {
      expect([r.who.length > 0, r.what.length > 0, r.when.length > 0], r.key).toEqual([true, true, true]);
    }
  });

  it('gives every recipient a distinct key', () => {
    const keys = DATA_RECIPIENTS.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('says the same things in the one-line version the About page uses', () => {
    expect(RECIPIENTS_IN_ONE_LINE).toMatch(/Google/);
    expect(RECIPIENTS_IN_ONE_LINE).toMatch(/model provider/);
  });
});

describe('what the page tells a candidate', () => {
  const text = PRIVACY_SECTIONS
    .flatMap((s) => [s.heading, ...s.paragraphs, ...(s.points ?? [])])
    .join(' ');

  it('covers what is collected, why, how long, who it is shared with, rights, and how to ask', () => {
    expect(PRIVACY_SECTIONS.map((s) => s.key))
      .toEqual(['who', 'collected', 'why', 'how-long', 'shared', 'security', 'rights', 'ask']);
  });

  it('states the retention window the product actually ships with', () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(180);
    expect(text).toContain('180 days');
  });

  it('says no audio is kept, which is what the consent screen says', () => {
    expect(text).toMatch(/no recording of your voice/i);
  });

  it('says there is no camera and no video', () => {
    expect(text).toMatch(/no video and no camera/i);
  });

  it('says a person makes the decision, not Questor', () => {
    expect(text).toMatch(/never rejects or hires anyone by itself/);
  });

  it('says a copy or an erasure is asked of the organisation that invited them', () => {
    expect(text).toMatch(/Ask the organisation that invited you/);
  });

  it('does not claim scheduled deletion always happens, because it is opt-in', () => {
    expect(text).toMatch(/only where the\s+organisation has switched the scheduled deletion on/);
  });

  it('says a legal hold can refuse an erasure, rather than leaving it unsaid', () => {
    expect(text).toMatch(/legal hold/);
  });

  it('admits there has been no independent security test', () => {
    expect(text).toMatch(/No independent penetration test/);
  });
});

/**
 * VITE_SUPPORT_EMAIL is unset on every deployment today, which is why the
 * About page named no address at all. Nothing may render as a broken offer.
 */
describe('the contact, configured or not', () => {
  it('uses a configured address', () => {
    expect(supportContact('privacy@example.com')).toBe('privacy@example.com');
  });

  it('ignores the surrounding whitespace a build variable picks up', () => {
    expect(supportContact('  privacy@example.com \n')).toBe('privacy@example.com');
  });

  it('treats an unset variable as no contact', () => {
    expect(supportContact(undefined)).toBeNull();
  });

  it('treats a blank variable as no contact', () => {
    expect(supportContact('   ')).toBeNull();
  });

  it('treats a value that is not an address as no contact, rather than a broken mailto', () => {
    expect(supportContact('set-me-later')).toBeNull();
  });

  it('offers the address when there is one', () => {
    expect(contactSentence('privacy@example.com')).toContain('privacy@example.com');
  });

  it('renders a usable sentence when there is none, not a dangling offer', () => {
    const sentence = contactSentence(null);
    expect(sentence).toMatch(/Replying to the email your invitation came in/);
    expect(sentence).not.toMatch(/write to\s*$|write to us at\s*$/);
  });

  it('never invents an address', () => {
    expect(contactSentence(null)).not.toMatch(/@/);
  });
});
