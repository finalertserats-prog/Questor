import { describe, it, expect } from 'vitest';
import { interpretResponse, TIMEOUT_MESSAGE, UNREADABLE_MESSAGE } from '../src/api/responseModel';

const ok = (text: string) => interpretResponse({ ok: true, status: 200, statusText: 'OK', text });

describe('interpretResponse on a successful response', () => {
  it('hands back the parsed JSON body', () => {
    expect(ok('{"user":{"id":"u1"}}')).toEqual({ kind: 'data', data: { user: { id: 'u1' } } });
  });

  it('treats an empty body as no data, which is what a 204 sends', () => {
    expect(interpretResponse({ ok: true, status: 204, statusText: 'No Content', text: '' }))
      .toEqual({ kind: 'data', data: null });
  });

  it('treats a whitespace-only body as no data too', () => {
    expect(ok('\n')).toEqual({ kind: 'data', data: null });
  });

  // The defect: a proxy error page arrived with status 200, was wrapped as
  // { raw } and cast to the page's type, so the page rendered blanks with no
  // error anywhere.
  it('refuses an HTML page served as a 200 rather than passing it off as data', () => {
    expect(ok('<html><body>502 Bad Gateway</body></html>'))
      .toEqual({ kind: 'error', status: 200, message: UNREADABLE_MESSAGE });
  });

  it('refuses a truncated JSON body', () => {
    expect(ok('{"user":')).toEqual({ kind: 'error', status: 200, message: UNREADABLE_MESSAGE });
  });

  it('keeps a JSON scalar, which is still readable data', () => {
    expect(ok('null')).toEqual({ kind: 'data', data: null });
  });
});

describe('interpretResponse on a failed response', () => {
  it('reports the error the API stated', () => {
    expect(interpretResponse({ ok: false, status: 400, statusText: 'Bad Request', text: '{"error":"Reason is required"}' }))
      .toEqual({ kind: 'error', status: 400, message: 'Reason is required' });
  });

  it('falls back to the status text when the body carries no error field', () => {
    expect(interpretResponse({ ok: false, status: 409, statusText: 'Conflict', text: '{}' }))
      .toEqual({ kind: 'error', status: 409, message: 'Conflict' });
  });

  // Worth more than "unreadable response": the status text says what happened.
  it('uses the status text when the failure body is a proxy HTML page', () => {
    expect(interpretResponse({ ok: false, status: 502, statusText: 'Bad Gateway', text: '<html>oops</html>' }))
      .toEqual({ kind: 'error', status: 502, message: 'Bad Gateway' });
  });

  it('falls back to plain wording when there is no status text either', () => {
    expect(interpretResponse({ ok: false, status: 500, statusText: '', text: '' }))
      .toEqual({ kind: 'error', status: 500, message: UNREADABLE_MESSAGE });
  });

  it('ignores a non-string error field rather than rendering an object', () => {
    expect(interpretResponse({ ok: false, status: 422, statusText: 'Unprocessable', text: '{"error":{"code":1}}' }))
      .toEqual({ kind: 'error', status: 422, message: 'Unprocessable' });
  });
});

describe('the timeout message', () => {
  it('says what happened in plain words, for the aborted-request case', () => {
    expect(TIMEOUT_MESSAGE).toBe('The server took too long to answer.');
  });
});

describe('interpretResponse keeps the refusal code', () => {
  it('carries a code the server attached, so a page can react to one refusal', () => {
    expect(interpretResponse({ ok: false, status: 409, statusText: 'Conflict', text: '{"error":"No ATS.","code":"ATS_NOT_CONNECTED"}' }))
      .toEqual({ kind: 'error', status: 409, message: 'No ATS.', code: 'ATS_NOT_CONNECTED' });
  });

  it('leaves the code out when the server sent none', () => {
    const out = interpretResponse({ ok: false, status: 400, statusText: 'Bad Request', text: '{"error":"Nope."}' });
    expect('code' in out).toBe(false);
  });
});

describe('interpretResponse keeps the application a duplicate refusal names', () => {
  it('carries the candidateId the server attached', () => {
    expect(interpretResponse({ ok: false, status: 409, statusText: 'Conflict', text: '{"error":"Already.","code":"candidate_exists","candidateId":"cand-1"}' }))
      .toEqual({ kind: 'error', status: 409, message: 'Already.', code: 'candidate_exists', candidateId: 'cand-1' });
  });

  it('leaves the candidateId out when the server sent none', () => {
    const out = interpretResponse({ ok: false, status: 409, statusText: 'Conflict', text: '{"error":"No ATS.","code":"ATS_NOT_CONNECTED"}' });
    expect('candidateId' in out).toBe(false);
  });
});
