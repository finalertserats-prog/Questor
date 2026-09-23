// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../src/components/Toast';

// The pages a person who cannot sign in actually sees, and the settings form
// that changes a password. The point of each test is a property the feature
// stands on, not that the markup renders.

/** Stands in for the real ApiError so a status can be attached to a rejection. */
class ApiErrorStub extends Error { status = -1; }

const posts: Array<{ path: string; body: unknown }> = [];
let postResult: (path: string) => unknown = () => ({ ok: true });

vi.mock('../src/api/client', () => ({
  api: {
    get: (path: string) => Promise.reject(new Error(`unstubbed GET ${path}`)),
    post: (path: string, body?: unknown) => {
      posts.push({ path, body });
      const answer = postResult(path);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  },
  ApiError: ApiErrorStub,
  getToken: () => null,
  setToken: () => {},
}));

const nav = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => nav };
});

function mount(element: ReturnType<typeof createElement>) {
  return render(createElement(MemoryRouter, null, createElement(ToastProvider, null, element)));
}

beforeEach(() => {
  posts.length = 0;
  nav.mockClear();
  postResult = () => ({ ok: true });
});

afterEach(() => {
  // This workspace runs vitest without globals, so React Testing Library's
  // automatic cleanup is never registered. Without this, each render stacks up
  // in the same document and getByLabelText finds the previous test's form.
  cleanup();
  window.location.hash = '';
});

describe('the forgot-password page', () => {
  it('says the same thing whether the request worked or was refused', async () => {
    const { ForgotPassword } = await import('../src/pages/ForgotPassword');

    mount(createElement(ForgotPassword));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'rita@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }));
    const afterSuccess = await screen.findByText(/link to set a new password is on its way/i);
    expect(afterSuccess).toBeTruthy();

    // Again, with the server refusing. A rate limit answered differently would
    // say, to anyone watching, that this address was worth limiting.
    postResult = () => new Error('Too many requests. Please wait a moment and try again.');
    const second = mount(createElement(ForgotPassword));
    fireEvent.change(second.getByLabelText('Email'), { target: { value: 'rita@example.com' } });
    fireEvent.click(second.getByRole('button', { name: 'Email me a link' }));
    expect(await second.findByText(/link to set a new password is on its way/i)).toBeTruthy();
  });

  it('says so honestly when the request never reached us at all', async () => {
    // Not an enumeration case: a connection that failed, or the whole
    // deployment refusing while its rate-limit store is down, says nothing
    // about this address. Telling the person a link is coming, when nothing
    // was even attempted, sends them to wait at an inbox for an hour.
    postResult = () => Object.assign(new ApiErrorStub('Questor could not be reached.'), { status: 0 });
    const { ForgotPassword } = await import('../src/pages/ForgotPassword');
    mount(createElement(ForgotPassword));

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'rita@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }));

    expect(await screen.findByText('Questor could not be reached.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Check your email' })).toBeNull();
  });

  it('still hides a rate limit, which does say something about this address', async () => {
    postResult = () => Object.assign(new ApiErrorStub('Too many requests. Please wait a moment and try again.'), { status: 429 });
    const { ForgotPassword } = await import('../src/pages/ForgotPassword');
    mount(createElement(ForgotPassword));

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'rita@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }));

    expect(await screen.findByText(/link to set a new password is on its way/i)).toBeTruthy();
  });

  it('does not send an address that could not be reached', async () => {
    const { ForgotPassword } = await import('../src/pages/ForgotPassword');
    mount(createElement(ForgotPassword));

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'not-an-address' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }));

    expect(posts).toEqual([]);
    expect(screen.getByText('Please enter the email address you sign in with.')).toBeTruthy();
  });
});

describe('the set-a-new-password page', () => {
  it('takes the token out of the address bar before anything else happens', async () => {
    window.location.hash = '#a-token-value-long-enough';
    postResult = () => ({ usable: true });
    const { ResetPassword } = await import('../src/pages/ResetPassword');

    mount(createElement(ResetPassword));
    await screen.findByLabelText('New password');

    expect(window.location.hash).toBe('');
    // And it went to the server in a body, never in the request line.
    expect(posts[0].path).toBe('/auth/password/reset/check');
    expect(posts[0].body).toEqual({ token: 'a-token-value-long-enough' });
  });

  it('shows the dead-link wording for a link with no token at all', async () => {
    window.location.hash = '';
    const { ResetPassword } = await import('../src/pages/ResetPassword');

    mount(createElement(ResetPassword));

    expect(await screen.findByText(/This link is no longer valid/i)).toBeTruthy();
    // Nothing was asked of the server: there was nothing to ask about.
    expect(posts).toEqual([]);
  });

  it('shows the same dead-link wording when the server says the link is spent', async () => {
    window.location.hash = '#a-token-value-long-enough';
    postResult = () => ({ usable: false });
    const { ResetPassword } = await import('../src/pages/ResetPassword');

    mount(createElement(ResetPassword));

    expect(await screen.findByText(/This link is no longer valid/i)).toBeTruthy();
    expect(screen.queryByLabelText('New password')).toBeNull();
  });

  it('does not call a link expired when it simply could not be checked', async () => {
    // "This link has expired" sends the person to ask for a new one, spending
    // one of the five they get an hour on a link that was never the problem.
    window.location.hash = '#a-token-value-long-enough';
    postResult = () => Object.assign(new ApiErrorStub('This service is briefly unavailable.'), { status: 503 });
    const { ResetPassword } = await import('../src/pages/ResetPassword');

    mount(createElement(ResetPassword));

    expect(await screen.findByText(/could not check it/i)).toBeTruthy();
    expect(screen.queryByText(/This link is no longer valid/i)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Ask for a new link' })).toBeNull();
  });

  it('catches a mistyped repeat before spending the link on it', async () => {
    window.location.hash = '#a-token-value-long-enough';
    postResult = () => ({ usable: true });
    const { ResetPassword } = await import('../src/pages/ResetPassword');

    mount(createElement(ResetPassword));
    fireEvent.change(await screen.findByLabelText('New password'), { target: { value: 'a-long-enough-passphrase' } });
    fireEvent.change(screen.getByLabelText('Repeat new password'), { target: { value: 'a-long-enough-passphrasf' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));

    expect(screen.getByText('The two passwords do not match.')).toBeTruthy();
    expect(posts.filter((p) => p.path === '/auth/password/reset')).toEqual([]);
  });

  it('sends the person to sign in once the password is set', async () => {
    window.location.hash = '#a-token-value-long-enough';
    postResult = () => ({ usable: true, ok: true });
    const { ResetPassword } = await import('../src/pages/ResetPassword');

    mount(createElement(ResetPassword));
    fireEvent.change(await screen.findByLabelText('New password'), { target: { value: 'a-long-enough-passphrase' } });
    fireEvent.change(screen.getByLabelText('Repeat new password'), { target: { value: 'a-long-enough-passphrase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set password' }));

    await waitFor(() => expect(nav).toHaveBeenCalledWith('/login'));
    expect(posts.some((p) => p.path === '/auth/password/reset')).toBe(true);
  });
});

describe('the change-password form', () => {
  it('sends the current password with the new one', async () => {
    const { ChangePasswordPanel } = await import('../src/components/ChangePasswordPanel');
    mount(createElement(ChangePasswordPanel));

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'the-old-passphrase' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'a-long-enough-passphrase' } });
    fireEvent.change(screen.getByLabelText('Repeat new password'), { target: { value: 'a-long-enough-passphrase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      path: '/auth/password/change',
      body: { currentPassword: 'the-old-passphrase', newPassword: 'a-long-enough-passphrase' },
    });
  });

  it('refuses to send the password the account already has', async () => {
    const { ChangePasswordPanel } = await import('../src/components/ChangePasswordPanel');
    mount(createElement(ChangePasswordPanel));

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'a-long-enough-passphrase' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'a-long-enough-passphrase' } });
    fireEvent.change(screen.getByLabelText('Repeat new password'), { target: { value: 'a-long-enough-passphrase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(screen.getByText('Your new password must be different from your current one.')).toBeTruthy();
    expect(posts).toEqual([]);
  });

  it('clears the fields once the change lands, so nothing is left on a shared screen', async () => {
    const { ChangePasswordPanel } = await import('../src/components/ChangePasswordPanel');
    mount(createElement(ChangePasswordPanel));

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'the-old-passphrase' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'a-long-enough-passphrase' } });
    fireEvent.change(screen.getByLabelText('Repeat new password'), { target: { value: 'a-long-enough-passphrase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() => expect((screen.getByLabelText('New password') as HTMLInputElement).value).toBe(''));
    expect((screen.getByLabelText('Current password') as HTMLInputElement).value).toBe('');
  });
});
