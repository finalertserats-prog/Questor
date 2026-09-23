import { describe, it, expect } from 'vitest';
import {
  newPasswordProblem, forgotFormProblem, tokenFromHash, PASSWORD_MIN_LENGTH,
} from '../src/components/passwordModel';
import { PASSWORD_MIN_LENGTH as SIGNUP_MIN } from '../src/components/signupModel';

describe('newPasswordProblem', () => {
  it('accepts a password at the floor', () => {
    expect(newPasswordProblem('a'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
  });

  it('names the rule when the password is short', () => {
    expect(newPasswordProblem('short')).toBe(`Please use a password of at least ${PASSWORD_MIN_LENGTH} characters.`);
  });

  it('refuses a passphrase bcrypt would silently truncate', () => {
    // bcrypt reads 72 bytes. Devanagari is three bytes a character, so 30
    // characters is already past it — and the tail would be discarded rather
    // than rejected, leaving two different passwords that both "work".
    expect(newPasswordProblem('क'.repeat(30))).toBe('That password is too long. Please use something shorter.');
  });

  it('catches a mistyped repeat before the request is made', () => {
    expect(newPasswordProblem('a-long-enough-passphrase', 'a-long-enough-passphrasf')).toBe('The two passwords do not match.');
  });

  it('is happy when the repeat matches', () => {
    expect(newPasswordProblem('a-long-enough-passphrase', 'a-long-enough-passphrase')).toBeNull();
  });

  it('holds the same floor as the signup form', () => {
    // The server keeps one policy; each workspace keeps one copy of the number.
    // A recovery form that accepted less would make recovery the soft way in.
    expect(PASSWORD_MIN_LENGTH).toBe(SIGNUP_MIN);
  });
});

describe('forgotFormProblem', () => {
  it('asks for an address that could be reached', () => {
    expect(forgotFormProblem('not-an-address')).toBe('Please enter the email address you sign in with.');
  });

  it('accepts one that could', () => {
    expect(forgotFormProblem('  rita@example.com  ')).toBeNull();
  });
});

describe('tokenFromHash', () => {
  it('reads a bare fragment', () => {
    expect(tokenFromHash('#abcdefghijklmnopqrst')).toBe('abcdefghijklmnopqrst');
  });

  it('reads a token= fragment, which some mail clients rewrite links into', () => {
    expect(tokenFromHash('#token=abcdefghijklmnopqrst')).toBe('abcdefghijklmnopqrst');
  });

  it('gives nothing for an empty address bar', () => {
    expect(tokenFromHash('')).toBe('');
  });

  it('gives nothing for something that is not shaped like a token', () => {
    expect(tokenFromHash('#short')).toBe('');
    expect(tokenFromHash('#<script>alert(1)</script>')).toBe('');
  });
});
