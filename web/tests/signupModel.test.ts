import { describe, it, expect } from 'vitest';
import {
  PASSWORD_MIN_LENGTH,
  applicantIntent,
  applicantName,
  decisionPhaseForStatus,
  emailDomain,
  isValidOrgCode,
  joinEmailCaution,
  joinEmailOrigin,
  normaliseOrgCode,
  queuedSignups,
  signupFormProblem,
  signupRequestBody,
  withoutSignup,
  type SignupForm,
} from '../src/components/signupModel';

const form = (patch: Partial<SignupForm> = {}): SignupForm => ({
  name: 'Priya Sharma',
  email: 'priya@acme.com',
  password: 'a-long-enough-secret',
  mode: 'new-org',
  organisationName: 'Acme Corp',
  orgCode: '',
  ...patch,
});

describe('isValidOrgCode', () => {
  it('accepts lowercase letters, digits and hyphens', () => {
    expect(isValidOrgCode('acme-hiring-2')).toBe(true);
  });

  it('rejects an organisation code that starts with a hyphen', () => {
    expect(isValidOrgCode('-acme')).toBe(false);
  });

  it('rejects an organisation code that ends with a hyphen', () => {
    expect(isValidOrgCode('acme-')).toBe(false);
  });

  it('rejects uppercase letters, which no stored code contains', () => {
    expect(isValidOrgCode('Acme')).toBe(false);
  });

  it('rejects a code with a space in it', () => {
    expect(isValidOrgCode('acme hiring')).toBe(false);
  });

  it('accepts a single character code', () => {
    expect(isValidOrgCode('a')).toBe(true);
  });

  it('rejects an empty code', () => {
    expect(isValidOrgCode('')).toBe(false);
  });
});

describe('normaliseOrgCode', () => {
  it('lowercases and trims what was typed', () => {
    expect(normaliseOrgCode('  Acme-Hiring  ')).toBe('acme-hiring');
  });
});

describe('signupFormProblem', () => {
  it('passes a complete request to start a new organisation', () => {
    expect(signupFormProblem(form())).toBeNull();
  });

  it('passes a complete request to join an existing organisation', () => {
    expect(signupFormProblem(form({ mode: 'join', orgCode: 'acme-hiring' }))).toBeNull();
  });

  it('asks for a name when none was given', () => {
    expect(signupFormProblem(form({ name: '   ' }))).toBe('Please tell us your name.');
  });

  it('rejects an address with no domain', () => {
    expect(signupFormProblem(form({ email: 'priya@acme' }))).toMatch(/email address/);
  });

  it('states the minimum length rather than only refusing a short password', () => {
    expect(signupFormProblem(form({ password: 'short' }))).toContain(String(PASSWORD_MIN_LENGTH));
  });

  it('accepts a password of exactly the minimum length', () => {
    expect(signupFormProblem(form({ password: 'x'.repeat(PASSWORD_MIN_LENGTH) }))).toBeNull();
  });

  it('rejects a password one character under the minimum', () => {
    expect(signupFormProblem(form({ password: 'x'.repeat(PASSWORD_MIN_LENGTH - 1) }))).not.toBeNull();
  });

  it('asks for an organisation name when starting a new organisation', () => {
    expect(signupFormProblem(form({ organisationName: '' }))).toBe('Please give the organisation a name.');
  });

  it('ignores a missing organisation name when joining an existing organisation', () => {
    expect(signupFormProblem(form({ mode: 'join', organisationName: '', orgCode: 'acme-hiring' }))).toBeNull();
  });

  it('rejects a malformed organisation code when joining', () => {
    expect(signupFormProblem(form({ mode: 'join', orgCode: '-acme' }))).toMatch(/lowercase letters/);
  });

  it('accepts an organisation code that only needs tidying up', () => {
    expect(signupFormProblem(form({ mode: 'join', orgCode: ' ACME-hiring ' }))).toBeNull();
  });
});

describe('signupRequestBody', () => {
  it('sends the organisation name when starting a new organisation', () => {
    expect(signupRequestBody(form())).toEqual({
      name: 'Priya Sharma',
      email: 'priya@acme.com',
      password: 'a-long-enough-secret',
      mode: 'new-org',
      organisationName: 'Acme Corp',
    });
  });

  it('sends the tidied organisation code when joining one', () => {
    expect(signupRequestBody(form({ mode: 'join', orgCode: ' ACME-Hiring ' })).orgCode).toBe('acme-hiring');
  });

  it('leaves out the organisation code when starting a new organisation', () => {
    expect(signupRequestBody(form({ orgCode: 'acme-hiring' })).orgCode).toBeUndefined();
  });

  it('leaves out the organisation name when joining an existing organisation', () => {
    expect(signupRequestBody(form({ mode: 'join', orgCode: 'acme-hiring' })).organisationName).toBeUndefined();
  });

  it('trims the name and the address', () => {
    const body = signupRequestBody(form({ name: '  Priya  ', email: '  priya@acme.com ' }));
    expect([body.name, body.email]).toEqual(['Priya', 'priya@acme.com']);
  });

  it('leaves the password exactly as it was typed', () => {
    expect(signupRequestBody(form({ password: '  spaces  are  meaningful  ' })).password)
      .toBe('  spaces  are  meaningful  ');
  });
});

describe('applicantIntent', () => {
  it('names the organisation somebody wants to start', () => {
    expect(applicantIntent('new-org', 'Acme Corp')).toBe('Wants to start a new organisation called Acme Corp.');
  });

  it('names the organisation somebody wants to join', () => {
    expect(applicantIntent('join', 'Acme Corp')).toBe('Wants to join Acme Corp.');
  });

  it('still reads as a sentence when the organisation is not known', () => {
    expect(applicantIntent('join', '  ')).toBe('Wants to join an organisation.');
  });
});

describe('emailDomain', () => {
  it('returns the domain in lowercase', () => {
    expect(emailDomain('Priya@Acme.COM')).toBe('acme.com');
  });

  it('takes the last at-sign as the separator', () => {
    expect(emailDomain('odd"@"name@acme.com')).toBe('acme.com');
  });

  it('returns nothing for a string that is not an address', () => {
    expect(emailDomain('priya')).toBeNull();
  });

  it('returns nothing for a bare hostname with no dot', () => {
    expect(emailDomain('priya@localhost')).toBeNull();
  });
});

describe('joinEmailOrigin', () => {
  it('recognises an address on the organisation’s own domain', () => {
    expect(joinEmailOrigin('priya@acme.com', 'Acme Corp')).toBe('matches-organisation');
  });

  it('recognises the organisation inside a longer domain', () => {
    expect(joinEmailOrigin('priya@mail.acme-hiring.co.uk', 'Acme Hiring')).toBe('matches-organisation');
  });

  it('flags a personal mailbox as one no organisation owns', () => {
    expect(joinEmailOrigin('priya@gmail.com', 'Acme Corp')).toBe('consumer-mailbox');
  });

  it('flags an unrelated company domain', () => {
    expect(joinEmailOrigin('priya@globex.com', 'Acme Corp')).toBe('unrelated-domain');
  });

  it('ignores company suffixes when matching, so Acme Ltd does not match globex-ltd', () => {
    expect(joinEmailOrigin('priya@globex-ltd.com', 'Acme Ltd')).toBe('unrelated-domain');
  });

  it('says nothing when the organisation name carries no identifying word', () => {
    expect(joinEmailOrigin('priya@globex.com', 'The Group')).toBe('unknown');
  });

  it('says nothing when the address has no domain to judge', () => {
    expect(joinEmailOrigin('priya', 'Acme Corp')).toBe('unknown');
  });
});

describe('joinEmailCaution', () => {
  it('says nothing about someone starting their own organisation', () => {
    expect(joinEmailCaution('new-org', 'priya@gmail.com', 'Acme Corp')).toBeNull();
  });

  it('says nothing when the address fits the organisation', () => {
    expect(joinEmailCaution('join', 'priya@acme.com', 'Acme Corp')).toBeNull();
  });

  it('names the organisation when a personal address asks to join it', () => {
    expect(joinEmailCaution('join', 'priya@gmail.com', 'Acme Corp'))
      .toBe('Personal email address, not one at Acme Corp.');
  });

  it('reports an unrelated domain as a mismatch rather than a verdict', () => {
    expect(joinEmailCaution('join', 'priya@globex.com', 'Acme Corp'))
      .toBe('Email domain does not look like Acme Corp.');
  });
});

describe('withoutSignup', () => {
  it('removes the decided request and keeps the rest in order', () => {
    const queue = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(withoutSignup(queue, 'b')).toEqual([{ id: 'a' }, { id: 'c' }]);
  });

  it('leaves the queue alone when the request is not in it', () => {
    expect(withoutSignup([{ id: 'a' }], 'z')).toEqual([{ id: 'a' }]);
  });

  it('returns a new array rather than editing the one it was given', () => {
    const queue = [{ id: 'a' }];
    expect(withoutSignup(queue, 'a')).not.toBe(queue);
  });
});

describe('decisionPhaseForStatus', () => {
  it('treats an unknown token as a link that does not work', () => {
    expect(decisionPhaseForStatus(404)).toBe('invalid');
  });

  it('treats a gone token as an expired link', () => {
    expect(decisionPhaseForStatus(410)).toBe('expired');
  });

  it('treats a conflict as a request somebody has already decided', () => {
    expect(decisionPhaseForStatus(409)).toBe('decided');
  });

  it('treats anything else as a fault at our end', () => {
    expect(decisionPhaseForStatus(500)).toBe('failed');
  });
});

/**
 * The queue's reading of what the server actually sends.
 *
 * `GET /api/admin/signups` nests the applicant's details under `applicant`,
 * because the "organisation" is `organisationName` for one mode and `orgSlug`
 * for the other and only the server can tell which. The queue read them from
 * the top level, found `undefined`, and `.trim()` took the whole page to its
 * error boundary the moment anyone was waiting.
 */
describe('queuedSignups', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'sr1',
    name: 'Priya Sharma',
    email: 'priya@acme.com',
    mode: 'new-org',
    organisationName: 'Priya Labs',
    orgSlug: null,
    status: 'PENDING',
    createdAt: '2026-09-23T08:00:00.000Z',
    applicant: { name: 'Priya Sharma', email: 'priya@acme.com', organisation: 'Priya Labs', mode: 'new-org' },
    ...over,
  });

  it('reads the organisation from where the server puts it', () => {
    expect(queuedSignups([row()])[0].organisation).toBe('Priya Labs');
  });

  it('reads the code of the organisation a join request names', () => {
    const joining = row({
      mode: 'join',
      organisationName: null,
      orgSlug: 'acme-hiring',
      applicant: { name: 'Priya Sharma', email: 'priya@acme.com', organisation: 'acme-hiring', mode: 'join' },
    });

    expect(queuedSignups([joining])[0]).toMatchObject({ mode: 'join', organisation: 'acme-hiring' });
  });

  it('gives an organisation-less row an empty name rather than undefined', () => {
    expect(queuedSignups([row({ applicant: { name: 'Priya Sharma', email: 'priya@acme.com', mode: 'join' } })])[0].organisation).toBe('');
  });

  it('survives a row with no applicant at all', () => {
    expect(queuedSignups([row({ applicant: undefined })])[0].organisation).toBe('');
  });

  it('drops a row with no id, which no decision could be sent for', () => {
    expect(queuedSignups([row({ id: '' }), row()])).toHaveLength(1);
  });

  it('reads nothing at all as an empty queue', () => {
    expect(queuedSignups(undefined)).toEqual([]);
  });
});

describe('applicantName', () => {
  it('uses the name when there is one', () => {
    expect(applicantName({ name: 'Priya Sharma', email: 'priya@acme.com' })).toBe('Priya Sharma');
  });

  it('falls back to the address rather than addressing nobody', () => {
    expect(applicantName({ name: '  ', email: 'priya@acme.com' })).toBe('priya@acme.com');
  });

  it('says "This applicant" when the row carries neither', () => {
    expect(applicantName({ name: '', email: '' })).toBe('This applicant');
  });
});
