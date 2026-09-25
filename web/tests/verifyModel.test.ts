import { describe, it, expect } from 'vitest';
import {
  VERIFY_COPY, certificateDownloadPath, certificateFallbackFilename, verifyPhaseFor,
} from '../src/components/verifyModel';

/**
 * The verification page's copy and its states, kept free of React so the words
 * themselves can be held to something.
 *
 * This is the one Questor page an employer reads, and the only one a candidate
 * reaches without being invited to anything. What it says when a link does not
 * resolve matters more than what it says when one does: a candidate can be
 * erased, and their awards are deleted outright when they are, so a token
 * stops resolving. The page must not let anyone tell that from a link that was
 * never real.
 */

describe('which state an answer puts the page in', () => {
  it('treats a link the server does not know as unknown', () => {
    expect(verifyPhaseFor(404)).toBe('unknown');
  });

  it('treats a record still being brought up to date as one to come back to', () => {
    expect(verifyPhaseFor(503)).toBe('notReady');
  });

  it('treats a fault at our end as a fault at our end', () => {
    expect([verifyPhaseFor(500), verifyPhaseFor(0), verifyPhaseFor(429)]).toEqual(['failed', 'failed', 'failed']);
  });
});

describe('what it says about a link that does not resolve', () => {
  /**
   * An erased candidate's awards are deleted, so their token lands here. "This
   * certificate has been withdrawn" or "no longer valid" would tell an
   * employer that the person was assessed here after all — the exact fact the
   * erasure existed to remove.
   */
  it('never implies the record once existed', () => {
    const words = `${VERIFY_COPY.unknown.title} ${VERIFY_COPY.unknown.body}`.toLowerCase();

    expect(words).not.toMatch(/withdrawn|revoked|expired|no longer|deleted|removed|cancelled/);
  });

  it('points at the likeliest innocent cause instead', () => {
    expect(VERIFY_COPY.unknown.body.toLowerCase()).toContain('certificate');
  });

  /** A record on its way to being migrated is temporary, and the page says so rather than "unknown". */
  it('tells someone whose record is not ready yet to come back', () => {
    expect(VERIFY_COPY.notReady.body.toLowerCase()).toMatch(/again|shortly|moment/);
  });
});

describe('the download, built from the address the reader is already on', () => {
  it('asks the public route, not the one behind a login', () => {
    expect(certificateDownloadPath('abc123')).toBe('/v/abc123/certificate.pdf');
  });

  /**
   * Only a fallback: the server sends a Content-Disposition naming the file by
   * its reference, and `api.download` prefers that. This is what a proxy that
   * strips the header leaves behind, so it must not name the person either.
   */
  it('falls back to a filename that does not name the candidate', () => {
    expect(certificateFallbackFilename('silver')).toBe('questor-silver-certificate.pdf');
  });
});
