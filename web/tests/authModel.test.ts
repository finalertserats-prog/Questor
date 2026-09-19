import { describe, it, expect } from 'vitest';
import { ApiError } from '../src/api/client';
import { endsSession, sessionLoadMessage } from '../src/authModel';

describe('endsSession', () => {
  it('ends the session when the server refuses the credential', () => {
    expect(endsSession(new ApiError(401, 'Unauthorized'))).toBe(true);
  });

  it('ends the session when the server forbids the account', () => {
    expect(endsSession(new ApiError(403, 'Forbidden'))).toBe(true);
  });

  // The defect this function exists for: a 500 from the API, or a proxy
  // returning 502 while the server restarts, used to sign the person out.
  it('keeps the session through a server error', () => {
    expect(endsSession(new ApiError(500, 'Internal Server Error'))).toBe(false);
  });

  it('keeps the session through a bad gateway', () => {
    expect(endsSession(new ApiError(502, 'Bad Gateway'))).toBe(false);
  });

  it('keeps the session when the request never reached the server', () => {
    expect(endsSession(new ApiError(0, 'The server took too long to answer.'))).toBe(false);
  });

  it('keeps the session for an error that is not an API error at all', () => {
    expect(endsSession(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('keeps the session for a thrown value that is not an error', () => {
    expect(endsSession('something went wrong')).toBe(false);
  });
});

describe('sessionLoadMessage', () => {
  it('reports what the server said, so a retry is an informed one', () => {
    expect(sessionLoadMessage(new ApiError(503, 'Service unavailable'))).toBe('Service unavailable');
  });

  it('falls back to plain wording when the failure carries no message', () => {
    expect(sessionLoadMessage(new ApiError(500, ''))).toBe('We could not check your sign-in.');
  });

  it('falls back to plain wording for a thrown value that is not an error', () => {
    expect(sessionLoadMessage(null)).toBe('We could not check your sign-in.');
  });
});
