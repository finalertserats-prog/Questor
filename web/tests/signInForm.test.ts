// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast';

// The two-step sign-in: password, then the code, when the organisation asks
// for one. The properties under test are the ones the flow stands on — the
// ticket is not a session, the page does not sign anyone in early, and asking
// to be remembered is something the person does rather than something we do.

const posts: Array<{ path: string; body: unknown }> = [];
let loginResult: unknown = { kind: 'signed_in' };
let codeResult: unknown = undefined;

const login = vi.fn(async (email: string, password: string, opts?: unknown) => {
  posts.push({ path: 'login', body: { email, password, opts } });
  if (loginResult instanceof Error) throw loginResult;
  return loginResult;
});
const submitCode = vi.fn(async (pending: string, code: string) => {
  posts.push({ path: 'code', body: { pending, code } });
  if (codeResult instanceof Error) throw codeResult;
});

vi.mock('../src/auth', () => ({ useAuth: () => ({ login, submitCode }) }));

function mount(element: ReturnType<typeof createElement>) {
  return render(createElement(MemoryRouter, null, createElement(ToastProvider, null, element)));
}

beforeEach(() => {
  posts.length = 0;
  login.mockClear();
  submitCode.mockClear();
  loginResult = { kind: 'signed_in' };
  codeResult = undefined;
});

afterEach(cleanup);

async function form() {
  const { SignInForm } = await import('../src/components/SignInForm');
  return mount(createElement(SignInForm, { orgSlug: 'acme', orgName: 'Acme Corp' }));
}

function typePassword() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'rita@acme.test' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-enough-passphrase' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('the password step', () => {
  it('signs in against the organisation whose page it is', async () => {
    await form();
    typePassword();

    await waitFor(() => expect(login).toHaveBeenCalled());
    expect(posts[0].body).toEqual({
      email: 'rita@acme.test',
      password: 'a-long-enough-passphrase',
      opts: { orgSlug: 'acme', rememberDevice: false },
    });
  });

  it('does not ask to be remembered unless the person ticks it', async () => {
    await form();
    // The box exists, and starts clear.
    expect((screen.getByLabelText(/Keep me signed in on this device/) as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByLabelText(/Keep me signed in on this device/));
    typePassword();

    await waitFor(() => expect(login).toHaveBeenCalled());
    expect((posts[0].body as { opts: { rememberDevice: boolean } }).opts.rememberDevice).toBe(true);
  });

  it('says plainly what being remembered does and does not cover', async () => {
    await form();
    const hint = screen.getByText(/It skips the emailed code/);
    expect(hint.textContent).toContain('not your password');
    expect(hint.textContent).toContain('device that is yours');
  });

  it('shows a refusal without moving on', async () => {
    loginResult = new Error('Invalid credentials');
    await form();
    typePassword();

    expect(await screen.findByText('Invalid credentials')).toBeTruthy();
    expect(screen.queryByLabelText('Sign-in code')).toBeNull();
  });
});

describe('the code step', () => {
  beforeEach(() => {
    loginResult = { kind: 'code_sent', pending: 'a-ticket-value-here', destination: 'r••••@acme.test', resendAfterSeconds: 60 };
  });

  it('asks for the code, and says where it went without spelling the address out', async () => {
    await form();
    typePassword();

    expect(await screen.findByLabelText('Sign-in code')).toBeTruthy();
    expect(screen.getByText(/r••••@acme\.test/)).toBeTruthy();
    // The full address is not on the page: this form is reachable by anyone
    // holding the password, and it must not hand them the mailbox as well.
    expect(document.body.textContent).not.toContain('rita@acme.test');
  });

  it('sends the code with the ticket from the password step', async () => {
    await form();
    typePassword();
    fireEvent.change(await screen.findByLabelText('Sign-in code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(submitCode).toHaveBeenCalled());
    expect(posts[1]).toEqual({ path: 'code', body: { pending: 'a-ticket-value-here', code: '123456' } });
  });

  it('offers the code field to an OS that can fill it', async () => {
    await form();
    typePassword();
    const field = await screen.findByLabelText('Sign-in code');

    expect(field.getAttribute('autocomplete')).toBe('one-time-code');
    expect(field.getAttribute('inputmode')).toBe('numeric');
  });

  it('clears a rejected code rather than leaving it to be pressed again', async () => {
    codeResult = new Error('That code is not right. 4 tries left.');
    await form();
    typePassword();
    fireEvent.change(await screen.findByLabelText('Sign-in code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(/4 tries left/)).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText('Sign-in code') as HTMLInputElement).value).toBe(''));
  });

  it('tells someone who was not signing in what that means, and what to do', async () => {
    await form();
    typePassword();
    await screen.findByLabelText('Sign-in code');

    // A code arriving unasked is the one signal a person has that their
    // password is out. The page has to say so.
    expect(screen.getByText(/someone else has your password/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Reset it now' }).getAttribute('href')).toBe('/forgot-password?org=acme');
  });

  it('goes back to the password when the code never arrived', async () => {
    await form();
    typePassword();
    fireEvent.click(await screen.findByRole('button', { name: /Start again/ }));

    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.queryByLabelText('Sign-in code')).toBeNull();
    // And the password box is empty: nothing half-typed is left on a shared
    // screen for the next person.
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
  });
});
