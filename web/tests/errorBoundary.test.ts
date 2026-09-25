// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { boundaryCopy, isPublicPath } from '../src/components/errorBoundaryModel';

/**
 * One page that throws must not blank the whole app, and the screen that
 * replaces it must offer a way forward without showing the error itself.
 */

const SECRET = 'TypeError: cannot read properties of undefined (reading "secretInternalField")';
let shouldThrow = true;

function Faulty() {
  if (shouldThrow) throw new Error(SECRET);
  return createElement('p', null, 'Recovered page');
}

const renderBoundary = (props: { scope: 'app' | 'page'; homeHref?: string | null; resetKey?: string }) =>
  render(createElement(ErrorBoundary, props, createElement(Faulty)));

beforeEach(() => {
  shouldThrow = true;
  // React reports caught errors to the console; keep the test output readable.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('shows a friendly title in place of the page', () => {
    renderBoundary({ scope: 'page' });
    expect(screen.getByRole('heading').textContent).toBe(boundaryCopy('page').title);
  });

  it('never shows the error message', () => {
    const { container } = renderBoundary({ scope: 'page' });
    expect(container.textContent).not.toContain('secretInternalField');
  });

  it('announces itself as an alert', () => {
    renderBoundary({ scope: 'page' });
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('renders the page again when Try again works', () => {
    renderBoundary({ scope: 'page' });
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Recovered page')).toBeTruthy();
  });

  it('offers a way to the dashboard from a console page', () => {
    renderBoundary({ scope: 'page' });
    expect(screen.getByRole('link', { name: 'Go to the dashboard' }).getAttribute('href')).toBe('/');
  });

  it('offers no dashboard link where there is none to go to', () => {
    renderBoundary({ scope: 'page', homeHref: null });
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('clears the fault when the address changes', () => {
    const { rerender } = renderBoundary({ scope: 'page', resetKey: '/a' });
    shouldThrow = false;
    rerender(createElement(ErrorBoundary, { scope: 'page', resetKey: '/b' }, createElement(Faulty)));
    expect(screen.getByText('Recovered page')).toBeTruthy();
  });

  it('leaves a healthy page alone', () => {
    shouldThrow = false;
    renderBoundary({ scope: 'app' });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('isPublicPath', () => {
  // '/v/' is read by an employer rather than a candidate, and has even less of
  // a dashboard to be offered: they have no account and never will.
  it.each(['/portal/abc', '/room/abc', '/talk-to-a-person/x', '/feedback-consent/x', '/v/abc'])('treats %s as candidate-facing', (path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  it('treats a console page as signed-in', () => {
    expect(isPublicPath('/candidates')).toBe(false);
  });
});
