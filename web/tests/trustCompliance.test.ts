import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { CATALOG_ATTRIBUTIONS as SERVER_ATTRIBUTIONS } from '../../server/src/domain/catalogAttribution';
import { ComplianceFooter } from '../src/components/ComplianceFooter';
import { TrustSection } from '../src/components/TrustSection';
import {
  FOOTER_FRAMEWORKS, TRUST_FRAMEWORKS, TRUST_SECTION_ID, TRUST_SECURITY, TRUST_STATUSES, trustStatusLabel,
} from '../src/components/trustModel';

/**
 * The trust section on About and the quiet footer on the sign-in pages. What is
 * pinned here is what must never drift: the licence-prescribed attribution, the
 * link between the two, and that every claim carries an honest status.
 */

function inRouter(node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(createElement(MemoryRouter, null, node));
}

/** Rendered text with tags stripped and React's escaping undone. */
function textOf(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
}

const footer = inRouter(createElement(ComplianceFooter));
const section = inRouter(createElement(TrustSection));

describe('login compliance footer', () => {
  it('carries the O*NET attribution word for word from the server constant', () => {
    expect(textOf(footer)).toContain(SERVER_ATTRIBUTIONS[0].text);
  });

  it('carries the ESCO attribution word for word from the server constant', () => {
    expect(textOf(footer)).toContain(SERVER_ATTRIBUTIONS[1].text);
  });

  it('links to the trust section of the About page', () => {
    expect(footer).toContain(`href="/about#${TRUST_SECTION_ID}"`);
  });

  it('names only frameworks the About page covers', () => {
    const covered = new Set(TRUST_FRAMEWORKS.map((f) => f.footerLabel).filter(Boolean));
    expect(FOOTER_FRAMEWORKS.every((label) => covered.has(label))).toBe(true);
  });

  it('lists each footer framework in the rendered line', () => {
    expect(FOOTER_FRAMEWORKS.every((label) => textOf(footer).includes(label))).toBe(true);
  });

  it('does not claim WCAG, which the compliance docs do not analyse', () => {
    expect(textOf(footer)).not.toMatch(/WCAG/);
  });
});

describe('About trust section', () => {
  it('is reachable by the id the footer links to', () => {
    expect(section).toContain(`id="${TRUST_SECTION_ID}"`);
  });

  it.each(TRUST_STATUSES)('renders the "%s" status in words', (status) => {
    expect(textOf(section)).toContain(trustStatusLabel(status));
  });

  it('uses every status at least once, so none is decorative', () => {
    const used = new Set([...TRUST_FRAMEWORKS.flatMap((f) => f.items), ...TRUST_SECURITY].map((i) => i.status));
    expect([...used].sort()).toEqual([...TRUST_STATUSES].sort());
  });

  it.each(['EU AI Act', 'GDPR', 'DPDP', 'Illinois', 'Local Law 144', 'Accessibility'])('covers %s', (name) => {
    expect(textOf(section)).toContain(name);
  });

  it('keeps fairness monitoring in progress, since it is still a stub', () => {
    const fairness = TRUST_FRAMEWORKS.flatMap((f) => f.items).find((i) => i.key === 'ai-act-fairness');
    expect(fairness?.status).toBe('in-progress');
  });

  it('never makes a blanket compliance claim', () => {
    expect(textOf(section)).not.toMatch(/\bcompliant\b|\bcertified\b/i);
  });

  it('carries the O*NET attribution word for word from the server constant', () => {
    expect(textOf(section)).toContain(SERVER_ATTRIBUTIONS[0].text);
  });

  it('gives every entry what the law asks and what Questor does', () => {
    const items = TRUST_FRAMEWORKS.flatMap((f) => f.items);
    expect(items.every((i) => i.asks.length > 0 && i.questor.length > 0)).toBe(true);
  });
});
