// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Privacy } from '../src/pages/Privacy';
import { ComplianceFooter } from '../src/components/ComplianceFooter';
import { PrivacyLink } from '../src/components/PrivacyLink';

/**
 * There was no privacy page and no terms anywhere in the product, nothing
 * linked to one, and the consent checkbox referenced none (legal review pack,
 * question 31). A page nobody can reach is not a notice, so these tests are
 * about the page existing AND about the links to it.
 */

const at = (node: ReactElement) => render(createElement(MemoryRouter, null, node));

afterEach(cleanup);

describe('the privacy page', () => {
  it('says what is collected, why, how long, who it is shared with, the rights and how to ask', () => {
    at(createElement(Privacy));
    const headings = ['What is collected', 'Why', 'How long it is kept', 'Who it is shared with', 'Your rights', 'How to ask for a copy, or for erasure'];
    for (const heading of headings) expect(screen.getByRole('heading', { name: heading }), heading).toBeTruthy();
  });

  it('names every recipient outside Questor and the hiring organisation', () => {
    at(createElement(Privacy));
    const body = document.body.textContent ?? '';
    expect([/Google/.test(body), /AI model provider/.test(body), /email service/.test(body)]).toEqual([true, true, true]);
  });

  it('gives the retention window the product actually uses', () => {
    at(createElement(Privacy));
    expect(document.body.textContent).toContain('180 days');
  });

  it('says a request for a copy or erasure goes to the organisation that invited them', () => {
    at(createElement(Privacy));
    expect(document.body.textContent).toMatch(/Ask the organisation that invited you/);
  });

  it('renders no mailto where no support address is configured', () => {
    // VITE_SUPPORT_EMAIL is unset in the test build, as it is on every
    // deployment today.
    at(createElement(Privacy));
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it('says plainly that there is no separate address, rather than leaving a sentence dangling', () => {
    at(createElement(Privacy));
    expect(document.body.textContent).toMatch(/publishes no separate address for candidates/);
  });

  it('points on to the law-by-law detail rather than repeating it', () => {
    at(createElement(Privacy));
    expect(screen.getByRole('link', { name: /How Questor meets the laws/ }).getAttribute('href')).toBe('/about#trust');
  });

  it('says it is not legal advice', () => {
    at(createElement(Privacy));
    expect(document.body.textContent).toMatch(/it is not legal advice/);
  });
});

describe('reaching the privacy page', () => {
  it('is linked from the sign-in footer', () => {
    const { container } = at(createElement(ComplianceFooter));
    expect(within(container).getByRole('link', { name: 'Privacy' }).getAttribute('href')).toBe('/privacy');
  });

  it('opens in a new tab from the candidate flow, so nobody loses their place mid-consent', () => {
    const { container } = at(createElement(PrivacyLink));
    const link = within(container).getByRole('link');
    expect([link.getAttribute('href'), link.getAttribute('target')]).toEqual(['/privacy', '_blank']);
  });

  it('carries a label that says what it is', () => {
    at(createElement(PrivacyLink));
    expect(screen.getByRole('link', { name: 'How Questor handles your data' })).toBeTruthy();
  });

  it('takes a label suited to where it sits', () => {
    at(createElement(PrivacyLink, { label: 'What happens to your data, in full' }));
    expect(screen.getByRole('link', { name: 'What happens to your data, in full' })).toBeTruthy();
  });
});
