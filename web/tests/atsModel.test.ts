import { describe, expect, it } from 'vitest';
import {
  atsErrorMessage,
  atsFormProblem,
  connectionStatus,
  formFromConnection,
  isAtsId,
  savePayload,
  type AtsConnectionView,
} from '../src/components/atsModel';

/**
 * The ATS settings panel, the ATS import on New Role and the candidate link
 * are thin over these rules: what the form sends, when it may be sent, what
 * the status says, and what a refusal tells the person looking at it.
 */

function connection(over: Partial<AtsConnectionView> = {}): AtsConnectionView {
  return {
    connected: true, provider: 'generic', baseUrl: 'https://ats.example.com/api', accountId: '',
    hasApiKey: true, source: 'tenant', status: 'ok', lastTestedAt: null, updatedAt: '2026-09-17T10:00:00Z',
    ...over,
  };
}

const form = (over: Partial<ReturnType<typeof formFromConnection>> = {}) => ({
  provider: 'generic' as const, baseUrl: 'https://ats.example.com/api', accountId: '', apiKey: 'k', ...over,
});

describe('formFromConnection', () => {
  it('never pre-fills the key, which the server never sends', () => {
    expect(formFromConnection(connection()).apiKey).toBe('');
  });

  it('starts an empty form when there is no connection', () => {
    expect(formFromConnection(null)).toEqual({ provider: 'generic', baseUrl: '', accountId: '', apiKey: '' });
  });

  it('carries the saved address into the form', () => {
    expect(formFromConnection(connection()).baseUrl).toBe('https://ats.example.com/api');
  });
});

describe('savePayload', () => {
  it('leaves the key out when the field is blank, so the stored key is kept', () => {
    expect('apiKey' in savePayload(form({ apiKey: '   ' }))).toBe(false);
  });

  it('sends a key that was typed', () => {
    expect(savePayload(form({ apiKey: ' new-key ' })).apiKey).toBe('new-key');
  });

  it('trims the address and account', () => {
    expect(savePayload(form({ baseUrl: ' https://ats.example.com/api ', accountId: ' acme ' })))
      .toMatchObject({ baseUrl: 'https://ats.example.com/api', accountId: 'acme' });
  });
});

describe('atsFormProblem', () => {
  it('asks for an address', () => {
    expect(atsFormProblem(form({ baseUrl: '' }), null)).toMatch(/address/i);
  });

  it('refuses an address that is not https', () => {
    expect(atsFormProblem(form({ baseUrl: 'http://ats.example.com' }), null)).toMatch(/https/);
  });

  it('refuses something that is not a URL', () => {
    expect(atsFormProblem(form({ baseUrl: 'ats.example.com' }), null)).toMatch(/https/);
  });

  it('asks for a key on a first connection', () => {
    expect(atsFormProblem(form({ apiKey: '' }), null)).toMatch(/key/i);
  });

  it('does not ask again for a key that is already stored', () => {
    expect(atsFormProblem(form({ apiKey: '' }), connection())).toBeNull();
  });

  it('asks for a key when taking over a server-configured connection', () => {
    expect(atsFormProblem(form({ apiKey: '' }), connection({ source: 'env' }))).toMatch(/key/i);
  });

  it('accepts a complete form', () => {
    expect(atsFormProblem(form(), null)).toBeNull();
  });
});

describe('connectionStatus', () => {
  it('says so when nothing is connected', () => {
    expect(connectionStatus(null).label).toBe('Not connected');
  });

  it('shows a tested connection as connected', () => {
    expect(connectionStatus(connection()).kind).toBe('green');
  });

  it('shows an untested connection as not yet proven', () => {
    expect(connectionStatus(connection({ status: 'untested' })).kind).toBe('amber');
  });

  it('shows a failed test in red', () => {
    expect(connectionStatus(connection({ status: 'failed' })).label).toBe('Last test failed');
  });

  it('shows a disconnected connection as disconnected', () => {
    expect(connectionStatus(connection({ connected: false, status: 'disconnected' })).label).toBe('Disconnected');
  });

  it('flags a connection that exists but cannot be used', () => {
    expect(connectionStatus(connection({ connected: false, status: 'ok' })).kind).toBe('red');
  });
});

describe('atsErrorMessage', () => {
  const notConnected = { status: 409, code: 'ATS_NOT_CONNECTED', message: 'server words' };

  it('points an admin at Settings when no ATS is connected', () => {
    expect(atsErrorMessage(notConnected, true)).toMatch(/Settings/);
  });

  it('tells anyone else to ask an administrator', () => {
    expect(atsErrorMessage(notConnected, false)).toMatch(/ask an administrator/i);
  });

  it('tells an admin to enter an unreadable key again', () => {
    expect(atsErrorMessage({ status: 409, code: 'ATS_KEY_UNREADABLE', message: 'x' }, true)).toMatch(/key/i);
  });

  it('explains a missing candidate link', () => {
    expect(atsErrorMessage({ status: 409, code: 'ATS_LINK_MISSING', message: 'x' }, false)).toMatch(/not linked/i);
  });

  it("passes any other refusal through in the server's words", () => {
    expect(atsErrorMessage({ status: 422, message: 'No requisition with that id exists in your ATS.' }, true))
      .toBe('No requisition with that id exists in your ATS.');
  });
});

describe('isAtsId', () => {
  it('accepts an ordinary vendor id', () => {
    expect(isAtsId('REQ-1042_b')).toBe(true);
  });

  it('refuses anything shaped like a path', () => {
    expect(isAtsId('../admin')).toBe(false);
  });

  it('refuses an empty id', () => {
    expect(isAtsId('')).toBe(false);
  });
});
