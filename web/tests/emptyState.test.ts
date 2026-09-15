import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyState } from '../src/components/EmptyState';
import { Skeleton } from '../src/components/Skeleton';

const render = (props: Parameters<typeof EmptyState>[0]) => renderToStaticMarkup(createElement(EmptyState, props));

describe('EmptyState', () => {
  it('renders the title as a heading', () => {
    expect(render({ icon: 'candidates', title: 'No candidates yet', message: 'Add one.' }))
      .toContain('<h3 class="empty-title">No candidates yet</h3>');
  });

  it('renders the one-line guidance', () => {
    expect(render({ icon: 'candidates', title: 'Empty', message: 'Add a candidate to get started.' }))
      .toContain('Add a candidate to get started.');
  });

  it('shows the icon when no illustration is given', () => {
    expect(render({ icon: 'candidates', title: 'Empty', message: 'x' })).toContain('<svg');
  });

  it('shows a decorative illustration instead of the icon when a src is given', () => {
    const html = render({ icon: 'candidates', illustration: '/brand/empty-candidates.webp', title: 'Empty', message: 'x' });
    expect(html).toMatch(/<img[^>]*src="\/brand\/empty-candidates.webp"[^>]*alt=""|<img[^>]*alt=""[^>]*src="\/brand\/empty-candidates.webp"/);
  });

  it('omits the icon when an illustration is shown', () => {
    const html = render({ icon: 'candidates', illustration: '/brand/x.webp', title: 'Empty', message: 'x' });
    expect(html).not.toContain('<svg');
  });

  it('renders the call to action when one is given', () => {
    const html = render({ icon: 'candidates', title: 'Empty', message: 'x', action: createElement('a', { href: '/new' }, 'Add candidate') });
    expect(html).toContain('<div class="empty-action"><a href="/new">Add candidate</a></div>');
  });

  it('renders no action wrapper when there is no call to action', () => {
    expect(render({ icon: 'candidates', title: 'Empty', message: 'x' })).not.toContain('empty-action');
  });

  // Without intrinsic dimensions the browser reserves no space for the artwork
  // and the text below it jumps when the image arrives.
  it('gives the illustration intrinsic dimensions so the layout does not shift', () => {
    const html = render({ icon: 'candidates', illustration: '/brand/x.webp', title: 'Empty', message: 'x' });
    expect(html).toContain('width="360"');
    expect(html).toContain('height="360"');
  });

  it('uses the artwork’s real aspect ratio when it is not square', () => {
    const html = render({
      icon: 'interviews', illustration: '/brand/empty-interviews.webp', title: 'Empty', message: 'x',
      illustrationWidth: 360, illustrationHeight: 331,
    });
    expect(html).toContain('width="360"');
    expect(html).toContain('height="331"');
  });
});

describe('Skeleton', () => {
  it('announces loading to assistive technology', () => {
    expect(renderToStaticMarkup(createElement(Skeleton, { label: 'Loading candidates' })))
      .toContain('role="status"');
  });

  it('renders the requested number of placeholder lines', () => {
    const html = renderToStaticMarkup(createElement(Skeleton, { lines: 4 }));
    expect(html.match(/skeleton-line/g)?.length).toBe(4);
  });
});
